"""
Sign-in, account and user-management API.

  GET  /api/auth/status          is login on, is AD configured (public)
  POST /api/auth/login           {username, password} → session cookie
  POST /api/auth/logout
  GET  /api/auth/me              the signed-in account
  POST /api/auth/password        local account: change own password
  GET  /api/users                (admin) all accounts
  POST /api/users                (admin) add an AD account before it has signed in
  PUT  /api/users/{id}           (admin) role / active
  GET  /api/people?q=            (signed in) people for @mentions and assignees
"""
import asyncio
import json
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .. import config as C
from .. import ldapauth, sysconfig
from ..auth import (ANON, COOKIE, clear_failures, client_ip, create_session, current_user, end_session,
                    hash_password, is_admin, public_user, record_failure, require_admin, set_cookie,
                    too_many, verify_password)
from ..database import get_db
from ..roles import ASSIGNABLE, LABELS, board_access

router = APIRouter(tags=["auth"])


class LoginIn(BaseModel):
    username: str
    password: str


class PasswordIn(BaseModel):
    current: str
    new: str


class UserUpdate(BaseModel):
    role: Optional[str] = None
    active: Optional[bool] = None
    manager: Optional[str] = None                     # 上級: username; "" = none; "@ad" = follow AD again
    scope_departments: Optional[List[str]] = None     # department managers; [] = their own AD department


class UserAdd(BaseModel):
    username: str


@router.get("/api/auth/status")
async def status():
    from .. import entra
    e = sysconfig.entra()
    return {"auth": C.AUTH, "ldap": ldapauth.enabled(), "directory": ldapauth.directory_enabled() or entra.directory_enabled(e),
            "local_admin": C.LOCAL_ADMIN, "entra": entra.enabled(e) and C.AUTH, "entra_label": e.button_label}


# ------------------------------------------------------------- Microsoft Entra ID sign-in
def entra_redirect_uri(request: Request, default_only: bool = False) -> str:
    """Where Microsoft sends the browser back: the setting, else this site's own address (as the browser sees it)."""
    c = sysconfig.entra()
    if c.redirect_uri and not default_only:
        return c.redirect_uri
    h = request.headers
    proto = h.get("x-forwarded-proto") or request.url.scheme
    host = (h.get("x-forwarded-host") or h.get("host") or request.url.netloc).split(",")[0].strip()
    port = h.get("x-forwarded-port")
    if port and ":" not in host and port not in ("443" if proto == "https" else "80",):
        host = f"{host}:{port}"
    return f"{proto}://{host}/api/auth/entra/callback"


def _safe_next(n: str) -> str:
    return n if n.startswith("/") and not n.startswith("//") else "/"


@router.get("/api/auth/entra/start")
async def entra_start(request: Request, next: str = "/"):
    from fastapi.responses import RedirectResponse
    from urllib.parse import quote
    from .. import entra
    try:
        url = entra.start(entra_redirect_uri(request), _safe_next(next))
    except entra.EntraError as e:
        from .. import i18n
        return RedirectResponse("/login?error=" + quote(i18n.translate(str(e))), status_code=303)
    return RedirectResponse(url, status_code=303)


async def upsert_entra_user(db, info: dict) -> dict:
    """The account a Microsoft sign-in belongs to: an existing AD / Entra account with the same on-premises
    account name, user principal name or e-mail, else a new account (source entra)."""
    keys = [k for k in (info.get("sam"), info.get("upn"), info.get("username")) if k]
    row = None
    for k in keys:
        cur = await db.execute("SELECT * FROM users WHERE lower(username) = ? AND source IN ('ldap', 'entra')", (k.lower(),))
        row = await cur.fetchone()
        if row:
            break
    if row is None and info.get("email"):
        cur = await db.execute("SELECT * FROM users WHERE lower(email) = ? AND source IN ('ldap', 'entra')", (info["email"].lower(),))
        row = await cur.fetchone()
    if row is None:
        cur = await db.execute("SELECT 1 FROM users WHERE lower(username) = ?", (info["username"].lower(),))
        if await cur.fetchone():
            raise HTTPException(status_code=409, detail="這個帳號名稱已被本機帳號使用")
        cur = await db.execute("""INSERT INTO users (username, source, display_name, email, department, role, last_login)
                                  VALUES (?, 'entra', ?, ?, ?, 'user', CURRENT_TIMESTAMP)""",
                               (info["username"], info["display_name"], info["email"], info["department"]))
        uid = cur.lastrowid
    else:
        uid = row["id"]
        if sysconfig.entra().sync_profile:
            await db.execute("""UPDATE users SET display_name = ?, email = COALESCE(NULLIF(?, ''), email),
                                department = COALESCE(NULLIF(?, ''), department), last_login = CURRENT_TIMESTAMP WHERE id = ?""",
                             (info["display_name"], info["email"], info["department"], uid))
        else:
            await db.execute("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?", (uid,))
    cur = await db.execute("SELECT * FROM users WHERE id = ?", (uid,))
    user = dict(await cur.fetchone())
    m = info.get("manager")
    if m and sysconfig.entra().sync_profile and user.get("manager_source") != "manual":
        cur = await db.execute("""SELECT id FROM users WHERE source IN ('ldap', 'entra') AND (lower(username) IN (?, ?) OR lower(email) = ?)""",
                               (m.get("sam") or "-", m.get("upn") or "-", (m.get("email") or "-").lower()))
        mr = await cur.fetchone()
        if mr is None:
            cur = await db.execute("""INSERT INTO users (username, source, display_name, email, department, role)
                                      VALUES (?, 'entra', ?, ?, ?, 'user')""", (m["username"], m["display_name"], m["email"], m["department"]))
            mid = cur.lastrowid
        else:
            mid = mr["id"]
        from ..team import would_cycle
        if mid != user.get("manager_id") and not await would_cycle(db, uid, mid):
            await db.execute("UPDATE users SET manager_id = ?, manager_source = 'entra' WHERE id = ?", (mid, uid))
    return user


@router.get("/api/auth/entra/callback")
async def entra_callback(request: Request, code: str = "", state: str = "", error: str = "", error_description: str = ""):
    from fastapi.responses import RedirectResponse
    from urllib.parse import quote
    from .. import entra
    from .. import i18n
    fail = lambda msg: RedirectResponse("/login?error=" + quote(i18n.translate(msg)[:300]), status_code=303)
    if error:
        return fail(f"Microsoft：{error_description or error}")
    try:
        info = await asyncio.get_running_loop().run_in_executor(None, entra.finish, code, state)
    except entra.EntraError as e:
        return fail(str(e))
    db = await get_db()
    try:
        try:
            user = await upsert_entra_user(db, info)
        except HTTPException as e:
            return fail(e.detail)
        if not user["active"]:
            return fail("這個帳號已被停用，請洽管理員")
        token = await create_session(db, user["id"], request)
        await db.commit()
    finally:
        await db.close()
    resp = RedirectResponse(_safe_next(info.get("next") or "/"), status_code=303)
    set_cookie(resp, request, token)
    return resp


async def ad_admin_count(db) -> int:
    cur = await db.execute("SELECT COUNT(*) AS c FROM users WHERE source IN ('ldap', 'entra') AND role = 'sysadmin' AND active = 1")
    return (await cur.fetchone())["c"]


async def upsert_ldap_user(db, info: dict, login: bool = False) -> dict:
    cur = await db.execute("SELECT * FROM users WHERE username = ?", (info["username"],))
    row = await cur.fetchone()
    if row and row["source"] not in ("ldap", "entra"):
        raise HTTPException(status_code=409, detail="這個帳號名稱已被本機帳號使用")
    if row:
        await db.execute(
            f"""UPDATE users SET display_name = ?, email = ?, department = ?{", last_login = CURRENT_TIMESTAMP" if login else ""}
                WHERE id = ?""", (info["display_name"], info["email"], info["department"], row["id"]))
        uid = row["id"]
    else:
        cur = await db.execute(
            f"""INSERT INTO users (username, source, display_name, email, department, role{", last_login" if login else ""})
                VALUES (?, 'ldap', ?, ?, ?, 'user'{", CURRENT_TIMESTAMP" if login else ""})""",
            (info["username"], info["display_name"], info["email"], info["department"]))
        uid = cur.lastrowid
    cur = await db.execute("SELECT * FROM users WHERE id = ?", (uid,))
    return dict(await cur.fetchone())


async def sync_manager(db, user: dict, info: dict):
    """上級 from AD's manager attribute (AD: manager = DN). An admin's manual choice is kept."""
    cfg = sysconfig.ldap()
    if not cfg.sync_manager or user.get("manager_source") == "manual":
        return
    dn = info.get("manager_dn") or ""
    manager_id = None
    if dn:
        login = await asyncio.get_running_loop().run_in_executor(None, ldapauth.login_of_dn, dn)
        if not login:
            return                                           # unknown right now: keep what we had
        cur = await db.execute("SELECT * FROM users WHERE username = ?", (login,))
        row = await cur.fetchone()
        if row is None:
            found = await asyncio.get_running_loop().run_in_executor(None, ldapauth.lookup, login)
            if not found:
                return
            row = await upsert_ldap_user(db, found)
        manager_id = row["id"]
        from ..team import would_cycle
        if await would_cycle(db, user["id"], manager_id):
            return
    if manager_id != user.get("manager_id") or (manager_id and user.get("manager_source") != "ad"):
        await db.execute("UPDATE users SET manager_id = ?, manager_source = ? WHERE id = ?",
                         (manager_id, "ad" if manager_id else None, user["id"]))
        await db.commit()


async def authenticate(db, username: str, password: str, ip: str) -> dict:
    """Check an account's password (local or Active Directory) → the users row. Raises HTTPException."""
    if not username or not password:
        raise HTTPException(status_code=400, detail="請輸入帳號與密碼")
    if too_many(ip, username):
        raise HTTPException(status_code=429, detail="嘗試次數過多，請 15 分鐘後再試")
    cur = await db.execute("SELECT * FROM users WHERE username = ?", (username,))
    row = await cur.fetchone()
    user = None
    if row is not None and row["source"] == "demo":           # demo staff (app/demo.py) cannot sign in
        record_failure(ip, username)
        raise HTTPException(status_code=401, detail="示範帳號不能登入")
    if row is not None and row["source"] == "local":
        if verify_password(password, row["password_hash"]):
            user = dict(row)
            await db.execute("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?", (row["id"],))
    elif ldapauth.enabled():
        try:
            info = await asyncio.get_running_loop().run_in_executor(None, ldapauth.authenticate, username, password)
        except ConnectionError as e:
            raise HTTPException(status_code=503, detail=str(e))
        if info:
            user = await upsert_ldap_user(db, info, login=True)
            await sync_manager(db, user, info)
    elif row is None:
        record_failure(ip, username)
        raise HTTPException(status_code=401, detail="尚未設定 AD 連線，目前只能用本機管理員帳號登入")

    if user is None:
        record_failure(ip, username)
        raise HTTPException(status_code=401, detail="帳號或密碼錯誤")
    if not user["active"]:
        raise HTTPException(status_code=403, detail="這個帳號已被停用，請洽管理員")
    clear_failures(username)
    return user


@router.post("/api/auth/login")
async def login(body: LoginIn, request: Request):
    if not C.AUTH:
        return {"user": ANON}
    username = ldapauth.normalize(body.username)
    db = await get_db()
    try:
        user = await authenticate(db, username, body.password, client_ip(request))
        token = await create_session(db, user["id"], request)
        await db.commit()
        resp = JSONResponse({"user": public_user(user)})
        set_cookie(resp, request, token)
        return resp
    finally:
        await db.close()


@router.post("/api/auth/logout")
async def logout(request: Request):
    await end_session(request.cookies.get(COOKIE))
    resp = JSONResponse({"success": True})
    resp.delete_cookie(COOKIE, path="/")
    return resp


@router.get("/api/auth/me")
async def me(user: dict = Depends(current_user)):
    # people: a multi-user board (server, or a standalone copy linked to a server as an account)
    people_on = C.AUTH or bool(user.get("local_admin"))
    out = {"user": user, "auth": C.AUTH, "people": people_on and user.get("id") is not None, "is_admin": is_admin(user),
           "board": board_access(user), "role_label": LABELS.get(user.get("role"), user.get("role"))}
    if people_on and user.get("id") is not None:
        db = await get_db()
        try:
            ids = [i for i in [user.get("manager_id"), *(user.get("team") or [])] if i]
            people = {}
            if ids:
                cur = await db.execute(f"SELECT id, username, display_name, department, manager_id FROM users WHERE id IN ({','.join('?' * len(ids))})", ids)
                people = {r["id"]: {"id": r["id"], "username": r["username"], "name": r["display_name"] or r["username"],
                                    "department": r["department"], "manager_id": r["manager_id"]} for r in await cur.fetchall()}
            out["manager"] = people.get(user.get("manager_id"))
            out["team"] = [people[i] for i in user.get("team") or [] if i in people]
        finally:
            await db.close()
    if C.AUTH and is_admin(user):
        db = await get_db()
        try:
            out["needs_ad_admin"] = await ad_admin_count(db) == 0
        finally:
            await db.close()
    return out


@router.post("/api/auth/password")
async def change_password(body: PasswordIn, user: dict = Depends(current_user)):
    if not C.AUTH or user.get("source") != "local":
        raise HTTPException(status_code=400, detail="AD 帳號請在 Windows / AD 變更密碼")
    if len(body.new) < 12:
        raise HTTPException(status_code=400, detail="新密碼至少 12 個字元")
    db = await get_db()
    try:
        cur = await db.execute("SELECT password_hash FROM users WHERE id = ?", (user["id"],))
        if not verify_password(body.current, (await cur.fetchone())["password_hash"]):
            raise HTTPException(status_code=400, detail="目前的密碼不正確")
        if verify_password(body.new, (await (await db.execute("SELECT password_hash FROM users WHERE id = ?", (user["id"],))).fetchone())["password_hash"]):
            raise HTTPException(status_code=400, detail="新密碼不能和目前的密碼相同")
        await db.execute("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?", (hash_password(body.new), user["id"]))
        await db.commit()
        return {"success": True}
    finally:
        await db.close()


class LangIn(BaseModel):
    lang: Optional[str] = None


@router.put("/api/auth/lang")
async def set_lang(body: LangIn, user: dict = Depends(current_user)):
    """My interface language: zh-TW, en, or null (follow the site default)."""
    if body.lang not in (None, "zh-TW", "en"):
        raise HTTPException(status_code=400, detail="語言只能是 zh-TW 或 en")
    if user.get("id") is None:
        return {"lang": body.lang}                 # no account (standalone): the browser keeps it
    db = await get_db()
    try:
        await db.execute("UPDATE users SET lang = ? WHERE id = ?", (body.lang, user["id"]))
        await db.commit()
        return {"lang": body.lang}
    finally:
        await db.close()


# ------------------------------------------------------------- user management
@router.get("/api/users")
async def list_users(_: dict = Depends(require_admin)):
    db = await get_db()
    try:
        cur = await db.execute("""
            SELECT u.*,
              (SELECT COUNT(*) FROM tasks t WHERE t.owner_id = u.id) AS created_cards,
              (SELECT COUNT(*) FROM task_members m WHERE m.user_id = u.id AND m.role = 'assignee') AS assigned_cards
            FROM users u ORDER BY (u.role = 'superadmin') DESC, u.department, u.display_name, u.username""")
        rows = [{**public_user(r), "created_cards": r["created_cards"], "assigned_cards": r["assigned_cards"]}
                for r in await cur.fetchall()]
        by_id = {u["id"]: u for u in rows}
        for u in rows:
            m = by_id.get(u.get("manager_id"))
            u["manager"] = {"id": m["id"], "username": m["username"], "name": m["display_name"] or m["username"]} if m else None
            u["reports"] = sum(1 for x in rows if x.get("manager_id") == u["id"])
        cur = await db.execute("SELECT DISTINCT department FROM users WHERE department IS NOT NULL AND department != '' ORDER BY department")
        departments = [r["department"] for r in await cur.fetchall()]
        from .. import entra
        return {"users": rows, "ad_admins": await ad_admin_count(db), "directory": ldapauth.directory_enabled() or entra.directory_enabled(),
                "entra": entra.enabled(),
                "ldap": ldapauth.enabled(), "roles": [{"key": k, "label": LABELS[k]} for k in ASSIGNABLE],
                "departments": departments, "sync_manager": sysconfig.ldap().sync_manager}
    finally:
        await db.close()


@router.post("/api/users")
async def add_user(body: UserAdd, _: dict = Depends(require_admin)):
    info = await asyncio.get_running_loop().run_in_executor(None, ldapauth.lookup, body.username)
    if not info:
        raise HTTPException(status_code=404, detail="在 AD 找不到這個帳號（或未設定 AD 服務帳號）")
    db = await get_db()
    try:
        user = await upsert_ldap_user(db, info)
        await db.commit()
        return public_user(user)
    finally:
        await db.close()


@router.put("/api/users/{user_id}")
async def update_user(user_id: int, body: UserUpdate, me_: dict = Depends(require_admin)):
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="找不到這個帳號")
        if row["role"] == "superadmin":
            raise HTTPException(status_code=400, detail="本機最高管理員帳號不能在這裡修改")
        role = body.role if body.role is not None else row["role"]
        active = int(body.active) if body.active is not None else row["active"]
        if role not in ASSIGNABLE:
            raise HTTPException(status_code=400, detail="權限無效")
        was_ad_admin = row["source"] in ("ldap", "entra") and row["role"] == "sysadmin" and row["active"]
        if was_ad_admin and (role != "sysadmin" or not active) and await ad_admin_count(db) <= 1:
            raise HTTPException(status_code=400, detail="至少要保留一個 AD 帳號是系統管理者")
        if user_id == me_.get("id") and (role != "sysadmin" or not active):
            raise HTTPException(status_code=400, detail="不能取消自己的系統管理者權限或停用自己")
        scope = row["scope_departments"]
        if body.scope_departments is not None:
            clean = sorted({d.strip()[:100] for d in body.scope_departments if isinstance(d, str) and d.strip()})
            scope = json.dumps(clean, ensure_ascii=False) if clean else None
        await db.execute("UPDATE users SET role = ?, active = ?, scope_departments = ? WHERE id = ?", (role, active, scope, user_id))
        if body.manager is not None:
            from ..team import would_cycle
            if body.manager == "@ad":                       # follow AD again (applied at the next sign-in)
                await db.execute("UPDATE users SET manager_source = NULL WHERE id = ?", (user_id,))
            elif body.manager == "":
                await db.execute("UPDATE users SET manager_id = NULL, manager_source = 'manual' WHERE id = ?", (user_id,))
            else:
                cur = await db.execute("SELECT id FROM users WHERE username = ?", (ldapauth.normalize(body.manager),))
                m = await cur.fetchone()
                if not m:
                    found = await asyncio.get_running_loop().run_in_executor(None, ldapauth.lookup, body.manager)
                    if not found:
                        raise HTTPException(status_code=400, detail=f"找不到帳號 {body.manager}")
                    m = await upsert_ldap_user(db, found)
                if await would_cycle(db, user_id, m["id"]):
                    raise HTTPException(status_code=400, detail="不能把自己或自己的下級設為上級")
                await db.execute("UPDATE users SET manager_id = ?, manager_source = 'manual' WHERE id = ?", (m["id"], user_id))
        if not active or role != row["role"] or scope != row["scope_departments"]:
            await db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))   # takes effect immediately
        await db.commit()
        cur = await db.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        return public_user(await cur.fetchone())
    finally:
        await db.close()


@router.get("/api/people")
async def people(q: str = "", user: dict = Depends(current_user)):
    """Accounts for @mentions / assignee pickers: known accounts first, then the AD directory."""
    text = (q or "").strip().lower()
    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT id, username, display_name, department FROM users
               WHERE active = 1 AND source IN ('ldap', 'entra', 'demo') AND id IS NOT ? AND (? = '' OR lower(username) LIKE ? OR lower(display_name) LIKE ?)
               ORDER BY display_name LIMIT 20""", (user.get("id"), text, f"%{text}%", f"%{text}%"))
        out = [{**dict(r), "known": True} for r in await cur.fetchall()]
        from ..team import relations
        rel = await relations(db, user.get("id"))
        for p in out:
            p["relation"] = rel.get(p["id"])
        order = {"上級": 0, "下級": 1, "同級": 2}
        out.sort(key=lambda p: order.get(p["relation"], 3))      # my own reporting line first
    finally:
        await db.close()
    if text and not C.AUTH:                       # linked copy: the server's search (AD included) while online
        from .. import syncclient
        seen = {p["username"] for p in out}
        for p in await syncclient.remote_people(text):
            if isinstance(p, dict) and p.get("username") and p["username"] not in seen:
                out.append({"id": None, "username": p["username"], "display_name": p.get("display_name"),
                            "department": p.get("department"), "relation": p.get("relation"), "known": False})
                seen.add(p["username"])
    if text and ldapauth.directory_enabled():
        seen = {p["username"] for p in out}
        found = await asyncio.get_running_loop().run_in_executor(None, ldapauth.search_directory, text)
        out += [{"id": None, "username": a["username"], "display_name": a["display_name"], "department": a["department"],
                 "known": False} for a in found if a["username"] not in seen]
    from .. import entra
    if text and C.AUTH and entra.directory_enabled():         # Microsoft Entra ID (read only)
        seen = {p["username"] for p in out}
        try:
            found = await asyncio.get_running_loop().run_in_executor(None, entra.search_directory, text)
        except entra.EntraError:
            found = []
        out += [{"id": None, "username": a["username"], "display_name": a["display_name"], "department": a["department"],
                 "known": False} for a in found if a["username"] not in seen]
    return out[:20]
