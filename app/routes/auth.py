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
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .. import config as C
from .. import ldapauth
from ..auth import (ANON, COOKIE, clear_failures, client_ip, create_session, current_user, end_session,
                    hash_password, is_admin, public_user, record_failure, require_admin, set_cookie,
                    too_many, verify_password)
from ..database import get_db

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


class UserAdd(BaseModel):
    username: str


@router.get("/api/auth/status")
async def status():
    return {"auth": C.AUTH, "ldap": ldapauth.enabled(), "directory": ldapauth.directory_enabled(),
            "local_admin": C.LOCAL_ADMIN}


async def ad_admin_count(db) -> int:
    cur = await db.execute("SELECT COUNT(*) AS c FROM users WHERE source = 'ldap' AND role = 'admin' AND active = 1")
    return (await cur.fetchone())["c"]


async def upsert_ldap_user(db, info: dict, login: bool = False) -> dict:
    cur = await db.execute("SELECT * FROM users WHERE username = ?", (info["username"],))
    row = await cur.fetchone()
    if row and row["source"] != "ldap":
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


@router.post("/api/auth/login")
async def login(body: LoginIn, request: Request):
    if not C.AUTH:
        return {"user": ANON}
    username = ldapauth.normalize(body.username)
    ip = client_ip(request)
    if not username or not body.password:
        raise HTTPException(status_code=400, detail="請輸入帳號與密碼")
    if too_many(ip, username):
        raise HTTPException(status_code=429, detail="嘗試次數過多，請 15 分鐘後再試")

    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM users WHERE username = ?", (username,))
        row = await cur.fetchone()
        user = None
        if row is not None and row["source"] == "local":
            if verify_password(body.password, row["password_hash"]):
                user = dict(row)
                await db.execute("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?", (row["id"],))
        elif ldapauth.enabled():
            try:
                info = await asyncio.get_running_loop().run_in_executor(None, ldapauth.authenticate, username, body.password)
            except ConnectionError as e:
                raise HTTPException(status_code=503, detail=str(e))
            if info:
                user = await upsert_ldap_user(db, info, login=True)
        elif row is None:
            record_failure(ip, username)
            raise HTTPException(status_code=401, detail="尚未設定 AD 連線，目前只能用本機管理員帳號登入")

        if user is None:
            record_failure(ip, username)
            raise HTTPException(status_code=401, detail="帳號或密碼錯誤")
        if not user["active"]:
            raise HTTPException(status_code=403, detail="這個帳號已被停用，請洽管理員")
        clear_failures(username)
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
    out = {"user": user, "auth": C.AUTH, "is_admin": is_admin(user)}
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
        return {"users": rows, "ad_admins": await ad_admin_count(db), "directory": ldapauth.directory_enabled(),
                "ldap": ldapauth.enabled()}
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
        if role not in ("admin", "user"):
            raise HTTPException(status_code=400, detail="權限只能是 admin 或 user")
        was_ad_admin = row["source"] == "ldap" and row["role"] == "admin" and row["active"]
        if was_ad_admin and (role != "admin" or not active) and await ad_admin_count(db) <= 1:
            raise HTTPException(status_code=400, detail="至少要保留一個 AD 帳號是管理員")
        if user_id == me_.get("id") and (role != "admin" or not active):
            raise HTTPException(status_code=400, detail="不能取消自己的管理員權限或停用自己")
        await db.execute("UPDATE users SET role = ?, active = ? WHERE id = ?", (role, active, user_id))
        if not active or role != row["role"]:
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
               WHERE active = 1 AND source = 'ldap' AND (? = '' OR lower(username) LIKE ? OR lower(display_name) LIKE ?)
               ORDER BY display_name LIMIT 20""", (text, f"%{text}%", f"%{text}%"))
        out = [{**dict(r), "known": True} for r in await cur.fetchall()]
    finally:
        await db.close()
    if text and ldapauth.directory_enabled():
        seen = {p["username"] for p in out}
        found = await asyncio.get_running_loop().run_in_executor(None, ldapauth.search_directory, text)
        out += [{"id": None, "username": a["username"], "display_name": a["display_name"], "department": a["department"],
                 "known": False} for a in found if a["username"] not in seen]
    return out[:20]
