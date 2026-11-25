"""
Sync API (app/sync.py has the engine).

Server edition — used by standalone copies, with Authorization: Bearer <device token>
  POST /api/sync/link            {username, password, name, device} → token (public; rate limited like login)
  POST /api/sync/unlink          forget this device's token
  POST /api/sync/push            {rows, tombs, users} → what the server holds where it refused or knew better
  POST /api/sync/pull            {since, want} → changes after `since`, cards the account can see
  PUT  /api/sync/blob/{uid}      an attachment's file, uploaded before its row
  GET  /api/sync/blob/{uid}      an attachment's file
  GET  /api/sync/devices         (signed in) my linked standalone copies; DELETE /api/sync/devices/{id}
  GET  /api/sync/version         (public) the program version standalone copies must run → {build, deps, sha256, size}
  GET  /api/sync/package         (device token / signed in) that program as a zip: a copy updates itself with it

Both editions
  GET  /api/sync/wait?since=N    long poll: returns as soon as anything changed after N (≤ 25 s);
                                 the board uses it to refresh at once when someone else edits

Standalone copy (portable edition, no login)
  GET  /api/sync/client          link state, online, waiting changes, last sync
  POST /api/sync/client/connect  {server, username, password, verify} → link to a server
  POST /api/sync/client/now      sync now
  POST /api/sync/client/update   check the server's version now (and update to it)
  POST /api/sync/client/disconnect
  GET  /api/sync/client/log      conflicts (both versions kept) and refused / deleted notes
  POST /api/sync/client/resolve  {id, keep: mine|theirs}
"""
import hashlib
import json
import secrets
import time
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .. import config as C
from .. import images as img
from .. import ldapauth, sync
from ..auth import client_ip, current_user, public_user
from ..database import get_db
from ..roles import board_access

router = APIRouter(prefix="/api/sync", tags=["sync"])
# board rules an administrator sets on the server; a linked standalone copy follows them
BOARD_SETTINGS = ("board_tag_colors", "board_wip_high", "board_wip_over", "board_supervisor", "board_due_soon_days",
                  "board_overdue_remind_time", "board_windows", "board_load_hours", "board_default_estimate_hours")
MAX_PAYLOAD = 50 * 1024 * 1024


def _now_ms() -> int:
    return int(time.time() * 1000)


def _server_only():
    if not C.AUTH:
        raise HTTPException(status_code=404, detail="這是單機版；同步伺服器端只在伺服器版提供")


def _signed_in(request: Request) -> dict:
    user = current_user(request)
    if user.get("id") is None:
        raise HTTPException(status_code=401, detail="請先登入")
    return user


async def _json(request: Request) -> dict:
    raw = await request.body()
    if len(raw) > MAX_PAYLOAD:
        raise HTTPException(status_code=413, detail="資料量太大")
    try:
        data = json.loads(raw or b"{}")
    except ValueError:
        raise HTTPException(status_code=400, detail="格式錯誤")
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="格式錯誤")
    return data


# ------------------------------------------------------------------ client updates (server edition)
INSTALLER_URL = "https://github.com/nox913106/net-tool-table/releases/download/latest/IPMS-Setup.exe"
_package = {"build": None, "data": b"", "sha256": ""}


def _client_package() -> dict:
    """The server's own program files, zipped once per version: what a standalone copy installs."""
    from .. import version
    info = version.info(C.PROJECT_ROOT)
    if _package["build"] != info["build"]:
        data = version.package(C.PROJECT_ROOT)
        _package.update(build=info["build"], data=data, sha256=hashlib.sha256(data).hexdigest())
    return {**info, "sha256": _package["sha256"], "size": len(_package["data"])}


@router.get("/version")
async def client_version():
    """Standalone copies compare this with their own build and update when it differs (forced)."""
    _server_only()
    import asyncio
    info = await asyncio.get_running_loop().run_in_executor(None, _client_package)
    return {**info, "installer": C.CLIENT_INSTALLER_URL or INSTALLER_URL}


@router.get("/package")
async def client_package():
    _server_only()
    import asyncio
    from fastapi.responses import Response
    info = await asyncio.get_running_loop().run_in_executor(None, _client_package)
    return Response(_package["data"], media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="ipms-{info["build"]}.zip"',
                             "X-Build": info["build"], "X-Sha256": info["sha256"], "Cache-Control": "no-store"})


# ------------------------------------------------------------------ live updates (both editions)
@router.get("/wait")
async def wait(request: Request, since: int = -1):
    current_user(request)
    deadline = time.monotonic() + 25
    while True:
        db = await get_db()
        try:
            seq = await sync.current_seq(db)
        finally:
            await db.close()
        left = deadline - time.monotonic()
        if since < 0 or seq > since or left <= 0 or await request.is_disconnected():
            return {"seq": seq}
        await sync.changed(min(5.0, left))       # woken by any change made through this process


# ------------------------------------------------------------------ devices (server)
class LinkIn(BaseModel):
    username: str
    password: str
    name: str = Field("", max_length=80)        # computer name, shown in the device list
    device: str = Field("", max_length=40)


@router.post("/link")
async def link(body: LinkIn, request: Request):
    _server_only()
    from .auth import authenticate
    db = await get_db()
    try:
        user = await authenticate(db, ldapauth.normalize(body.username), body.password, client_ip(request))
        token = secrets.token_urlsafe(32)
        await db.execute("INSERT INTO sync_devices (user_id, token_hash, name, device, last_seen, ip) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)",
                         (user["id"], hashlib.sha256(token.encode()).hexdigest(), body.name.strip()[:80] or None,
                          body.device.strip()[:40] or None, client_ip(request)))
        await db.commit()
        return {"token": token, "user": public_user(user), "now": _now_ms()}
    finally:
        await db.close()


async def _issue_device(db, user: dict, name: str, device: str, ip: str) -> str:
    if user.get("role") == "guest":                 # not given a level yet: nothing to sync
        raise HTTPException(status_code=403, detail="帳號尚未開通：目前是訪客，請聯絡系統管理員開通為使用者或以上後再連線")
    token = secrets.token_urlsafe(32)
    await db.execute("INSERT INTO sync_devices (user_id, token_hash, name, device, last_seen, ip) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)",
                     (user["id"], hashlib.sha256(token.encode()).hexdigest(), (name or "").strip()[:80] or None,
                      (device or "").strip()[:40] or None, ip))
    return token


# ----------------------------------------------- link by approving in a browser (Microsoft Entra ID, or any sign-in)
# The standalone copy asks for a code; the person opens /link?code=… in a browser where they are signed in
# (Microsoft, AD or local) and approves; the copy then collects its device token. No password reaches the copy.
LINK_REQUESTS: dict = {}            # code → {poll, name, device, ip, at, user_id, denied}
LINK_TTL = 600


class LinkStartIn(BaseModel):
    name: str = ""
    device: str = ""


def _link_gc():
    now = time.time()
    for k in [k for k, v in LINK_REQUESTS.items() if now - v["at"] > LINK_TTL]:
        LINK_REQUESTS.pop(k, None)


@router.post("/link/start")
async def link_start(body: LinkStartIn, request: Request):
    _server_only()
    _link_gc()
    if len(LINK_REQUESTS) > 200:
        raise HTTPException(status_code=429, detail="嘗試次數過多，請 15 分鐘後再試")
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    code = "".join(secrets.choice(alphabet) for _ in range(8))
    poll = secrets.token_urlsafe(24)
    LINK_REQUESTS[code] = {"poll": poll, "name": body.name.strip()[:80], "device": body.device.strip()[:40],
                           "ip": client_ip(request), "at": time.time(), "user_id": None, "denied": False}
    from .auth import entra_redirect_uri
    base = entra_redirect_uri(request, default_only=True).rsplit("/api/", 1)[0]
    return {"code": f"{code[:4]}-{code[4:]}", "poll": poll, "url": f"{base}/link?code={code[:4]}-{code[4:]}", "expires_in": LINK_TTL}


def _link_req(code: str) -> dict:
    _link_gc()
    r = LINK_REQUESTS.get((code or "").replace("-", "").strip().upper())
    if not r:
        raise HTTPException(status_code=404, detail="連結代碼不存在或已過期，請在單機版重新開始")
    return r


@router.get("/link/request")
async def link_request(code: str, request: Request):
    """What the approval page shows: which computer asks to link to my account."""
    _server_only()
    _signed_in(request)
    r = _link_req(code)
    return {"name": r["name"], "ip": r["ip"], "approved": bool(r["user_id"]), "denied": r["denied"]}


class LinkApproveIn(BaseModel):
    code: str
    allow: bool = True


@router.post("/link/approve")
async def link_approve(body: LinkApproveIn, request: Request):
    _server_only()
    user = _signed_in(request)
    if user.get("id") is None or user.get("device_id"):
        raise HTTPException(status_code=403, detail="請在瀏覽器登入後核准")
    r = _link_req(body.code)
    if r["user_id"] or r["denied"]:
        raise HTTPException(status_code=400, detail="這個連結代碼已經處理過了")
    if body.allow:
        r["user_id"] = user["id"]
    else:
        r["denied"] = True
    return {"success": True}


class LinkPollIn(BaseModel):
    poll: str


@router.post("/link/poll")
async def link_poll(body: LinkPollIn, request: Request):
    """The standalone copy asks whether the person approved; once approved, it gets its device token (once)."""
    _server_only()
    _link_gc()
    code = next((k for k, v in LINK_REQUESTS.items() if secrets.compare_digest(v["poll"], body.poll or "")), None)
    if code is None:
        raise HTTPException(status_code=404, detail="連結代碼不存在或已過期，請在單機版重新開始")
    r = LINK_REQUESTS[code]
    if r["denied"]:
        LINK_REQUESTS.pop(code, None)
        raise HTTPException(status_code=403, detail="已在瀏覽器拒絕這台電腦的連結")
    if not r["user_id"]:
        return {"pending": True}
    LINK_REQUESTS.pop(code, None)
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM users WHERE id = ? AND active = 1", (r["user_id"],))
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=403, detail="這個帳號已被停用，請洽管理員")
        user = dict(row)
        token = await _issue_device(db, user, r["name"], r["device"], r["ip"])
        await db.commit()
        return {"token": token, "user": public_user(user), "now": _now_ms()}
    finally:
        await db.close()


@router.post("/unlink")
async def unlink(request: Request):
    _server_only()
    user = _signed_in(request)
    if user.get("device_id"):
        db = await get_db()
        try:
            await db.execute("DELETE FROM sync_devices WHERE id = ?", (user["device_id"],))
            await db.commit()
        finally:
            await db.close()
    return {"success": True}


@router.get("/devices")
async def devices(request: Request):
    _server_only()
    user = _signed_in(request)
    db = await get_db()
    try:
        cur = await db.execute("SELECT id, name, created, last_seen, ip FROM sync_devices WHERE user_id = ? ORDER BY last_seen DESC",
                               (user["id"],))
        return [dict(r) for r in await cur.fetchall()]
    finally:
        await db.close()


@router.delete("/devices/{device_id}")
async def drop_device(device_id: int, request: Request):
    _server_only()
    user = _signed_in(request)
    db = await get_db()
    try:
        await db.execute("DELETE FROM sync_devices WHERE id = ? AND user_id = ?", (device_id, user["id"]))
        await db.commit()
        return {"success": True}
    finally:
        await db.close()


# ------------------------------------------------------------------ permissions (server)
def _guard(db, user: dict):
    """The same rules as the board's own endpoints, applied to rows arriving from a standalone copy."""
    from .tasks import HISTORY_MSG, _can_edit, _check_assignees, _comment_rights, _visible_sql, can_delete, is_history
    from fastapi import HTTPException as HE
    me = user["id"]
    acc = board_access(user)
    seen = {}

    async def visible(card) -> bool:
        if card not in seen:
            where, args = _visible_sql(user)
            cur = await db.execute(f"SELECT 1 FROM tasks t WHERE t.id = ? AND {where}", (card, *args))
            seen[card] = bool(await cur.fetchone())
        return seen[card]

    async def guard(table, uid, local, changes, op) -> Optional[str]:
        if table == "tasks":
            if op == "insert":
                if changes.get("owner_id") != me and acc["edit"] != "all":
                    changes["owner_id"] = me
                return None
            if not await visible(local["_rid"]):
                return "你已經看不到這張卡片"
            if await is_history(db, local["_rid"]):
                return HISTORY_MSG
            if op == "update":
                return None if await _can_edit(db, local["_rid"], user) else "這張卡片你只能檢視（唯讀）"
            t = dict(local)
            t["id"] = local["_rid"]
            return None if await can_delete(db, t, user) else "只能刪除自己建立的卡片"
        if table == "nodes":                       # portal links: only one's own personal area
            if op == "insert":
                changes["owner_id"] = me
            elif local["owner_id"] != me:
                return "公用區只有管理員可以修改" if local["owner_id"] is None else "這不是你的個人區"
            if str(changes.get("url") or "").lower().startswith("file:"):
                return "伺服器上的個人區不能放本機程式"
            parent = changes.get("parent_id")
            if parent is not None:
                cur = await db.execute("SELECT owner_id, node_type FROM nodes WHERE id = ?", (parent,))
                p = await cur.fetchone()
                if not p or p["owner_id"] != me or p["node_type"] != "folder":
                    return "只能放在自己個人區的資料夾裡"
            return None
        card = changes.get("task_id") if op == "insert" else local["task_id"]
        if card is None or not await visible(card):
            return "你看不到這張卡片"
        if await is_history(db, card):
            return HISTORY_MSG
        if table == "task_comments":
            if op == "insert":
                changes["user_id"] = me
                if changes.get("is_task") and not await _can_edit(db, card, user):
                    return "只有能編輯卡片的人可以新增子任務"
                if changes.get("assignee_id") not in (None, me) and not await _can_edit(db, card, user):
                    return "沒有指派子任務的權限"
                return None
            rights = await _comment_rights(db, card, local, user)
            if op == "delete":
                return None if (local["user_id"] == me or rights["editor"]) else "只能刪除自己的留言"
            keys = set(changes)
            if "task_id" in keys:
                return "不能把留言移到別張卡片"
            if "assignee_id" in keys and not rights["assign"]:
                return "沒有指派子任務的權限"
            if keys & {"body", "edited_at"} and not rights["edit_body"]:
                return "只能修改自己的留言"
            if keys - {"body", "edited_at", "assignee_id"} and not (rights["edit_task"] or rights["editor"]):
                return "沒有修改這個子任務的權限"
            return None
        if table == "task_members":
            role = changes.get("role") if op == "insert" else local["role"]
            target = changes.get("user_id") if op == "insert" else local["user_id"]
            if op == "update":
                if set(changes) - {"done_at"}:
                    return "協作人資料只能標記完成"
                return None if target == me or await _can_edit(db, card, user) else "只有協作人本人或卡片編輯者可以標記完成"
            if role == "assignee":
                if not await _can_edit(db, card, user):
                    return "沒有指派負責人的權限"
                if op == "insert":
                    cur = await db.execute("SELECT id, username, display_name FROM users WHERE id = ?", (target,))
                    p = await cur.fetchone()
                    try:
                        await _check_assignees(db, user, card, [dict(p)] if p else [])
                    except HE as e:
                        return e.detail
                return None
            if role != "mention":
                return "不支援的協作人類型"
            return None if op == "insert" or target == me or await _can_edit(db, card, user) else "沒有移除協作人的權限"
        if table == "task_watch":                 # one's own notification settings only
            if op == "insert":
                changes["user_id"] = me
                return None if changes.get("mode") in ("all", "mine", "digest", "off") else "不支援的通知模式"
            if local["user_id"] != me:
                return "只能修改自己的通知設定"
            return None if changes.get("mode", "mine") in ("all", "mine", "digest", "off") else "不支援的通知模式"
        if table == "task_time":
            if op == "insert":
                changes["user_id"] = me
                return None
            return None if local["user_id"] == me else "只能修改自己的工時"
        if table == "task_images":
            if op == "insert":
                changes["user_id"] = me
                return None
            return None if local["user_id"] == me or await _can_edit(db, card, user) else "只能刪除或修改自己上傳的附件"
        return "不支援的資料"

    return guard


NOTE_KINDS = {"assigned", "mention", "comment", "subtask", "blocked", "overdue", "reminder"}


async def _notes_in(db, notes: dict, user: dict):
    """Notifications the copy made for other people (exactly what the server would have sent for the same
    action), and which of the account's own notifications were read there."""
    from .tasks import _resolve_people
    for n in (notes.get("new") or [])[:500]:
        if not isinstance(n, dict) or not isinstance(n.get("uid"), str) or not n.get("user"):
            continue
        people = await _resolve_people(db, [str(n["user"])])
        if not people or people[0]["id"] == user["id"]:
            continue
        task_id = None
        if n.get("task"):
            cur = await db.execute("SELECT id FROM tasks WHERE uid = ?", (str(n["task"]),))
            r = await cur.fetchone()
            if not r:
                continue                                  # its card did not make it here
            task_id = r[0]
        kind = n.get("kind") if n.get("kind") in NOTE_KINDS else "comment"
        await db.execute("""INSERT OR IGNORE INTO notifications (uid, user_id, task_id, actor_id, kind, text, created_at, synced)
                            VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), 1)""",
                         (n["uid"][:40], people[0]["id"], task_id, user["id"], kind, str(n.get("text") or "")[:300],
                          str(n["created_at"])[:19] if n.get("created_at") else None))
    read = [u for u in (notes.get("read") or []) if isinstance(u, str)][:1000]
    for i in range(0, len(read), 400):
        part = read[i:i + 400]
        await db.execute(f"UPDATE notifications SET read = 1 WHERE user_id = ? AND uid IN ({','.join('?' * len(part))})",
                         (user["id"], *part))


async def _notes_out(db, user: dict) -> list:
    """The account's own notifications for its copies' 🔔."""
    await db.execute("UPDATE notifications SET uid = lower(hex(randomblob(12))) WHERE uid IS NULL AND user_id = ?", (user["id"],))
    cur = await db.execute("""SELECT n.uid, n.kind, n.text, n.read, n.created_at, t.uid AS task, a.username AS actor
                              FROM notifications n LEFT JOIN tasks t ON t.id = n.task_id LEFT JOIN users a ON a.id = n.actor_id
                              WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 200""", (user["id"],))
    return [dict(r) for r in await cur.fetchall()]


async def _known_accounts(db, names):
    """People the copy assigned or @mentioned who never signed in here: add them from the AD directory,
    the way the board does when someone picks them on the server."""
    from .tasks import _resolve_people
    names = [n for n in names if isinstance(n, str)][:200]
    missing = []
    for i in range(0, len(names), 400):
        part = names[i:i + 400]
        cur = await db.execute(f"SELECT username FROM users WHERE username IN ({','.join('?' * len(part))})", part)
        have = {r[0] for r in await cur.fetchall()}
        missing += [n for n in part if n not in have]
    for i in range(0, len(missing), 20):
        await _resolve_people(db, missing[i:i + 20])


async def _after(db, rep: sync.Report, user: dict, notes: bool = True):
    """What the board's endpoints do besides writing: subtask viewers, summary status, notifications
    (a copy that sends its own notifications — notes=False — is not guessed for)."""
    from .tasks import _members, _sync_subtask_members, _who, notify, rollup_status
    cards = {c for c in rep.cards if c}
    for card in cards:
        cur = await db.execute("SELECT 1 FROM tasks WHERE id = ?", (card,))
        if await cur.fetchone():
            await _sync_subtask_members(db, card)
            await rollup_status(db, card)
    if not notes:
        return
    for table, uid, rowid in rep.inserted:
        if table == "task_comments":
            cur = await db.execute("""SELECT c.body, c.task_id, t.title, t.owner_id FROM task_comments c
                                      JOIN tasks t ON t.id = c.task_id WHERE c.rowid = ?""", (rowid,))
            c = await cur.fetchone()
            if c:
                people = await _members(db, c["task_id"], "assignee") | await _members(db, c["task_id"], "mention") | {c["owner_id"]}
                await notify(db, people, c["task_id"], user, "comment", f"{_who(user)} 在「{c['title']}」留言：{(c['body'] or '')[:60]}")
        elif table == "task_members":
            cur = await db.execute("""SELECT m.user_id, m.role, m.task_id, t.title FROM task_members m
                                      JOIN tasks t ON t.id = m.task_id WHERE m.rowid = ?""", (rowid,))
            m = await cur.fetchone()
            if m and m["role"] == "assignee":
                await notify(db, [m["user_id"]], m["task_id"], user, "assigned", f"{_who(user)} 把「{m['title']}」指派給你")
            elif m and m["role"] == "mention":
                await notify(db, [m["user_id"]], m["task_id"], user, "mention", f"{_who(user)} 在「{m['title']}」提到你")


# ------------------------------------------------------------------ push / pull (server)
@router.post("/push")
async def push(request: Request):
    _server_only()
    user = _signed_in(request)
    payload = await _json(request)
    db = await get_db()
    try:
        async def staged(uid):
            cur = await db.execute("SELECT stored, mime, kind, size FROM sync_blobs WHERE uid = ?", (uid,))
            r = await cur.fetchone()
            return tuple(r) if r else None
        if isinstance(payload.get("users"), dict):
            await _known_accounts(db, list(payload["users"]))
        rep = await sync.merge(db, payload, server=True, guard=_guard(db, user), blob_for=staged)
        for table, uid, _ in rep.inserted:
            if table == "task_images":
                await db.execute("DELETE FROM sync_blobs WHERE uid = ?", (uid,))
        notes = payload.get("notes")
        await _after(db, rep, user, notes=not isinstance(notes, dict))
        if isinstance(notes, dict):
            await _notes_in(db, notes, user)
        await db.commit()
        img.remove(rep.files_removed)

        # tell the copy what we hold where we refused its change or know a later value
        ids = sync.Ids(db, server=True)
        rows, tombs, force, reasons = [], [], [], {}
        back: dict = {}
        for table, uid, why in rep.rejected:
            force.append(uid)
            reasons[uid] = why
            back.setdefault(table, set()).add(uid)
        for table, uid in rep.stale:
            back.setdefault(table, set()).add(uid)
        for table, uids in back.items():
            got = await sync.export_by_uid(db, table, list(uids), ids)
            rows += got
            have = {r["uid"] for r in got}
            for uid in uids - have:
                if uid in reasons:                       # refused new row: the copy removes it
                    tombs.append({"t": table, "uid": uid, "ts": "", "dev": ""})
            if table == "tasks":                        # a refused deletion: the whole card comes back
                refused = [r for r in got if r["uid"] in reasons]
                if refused:
                    cur = await db.execute(f"SELECT id FROM tasks WHERE uid IN ({','.join('?' * len(refused))})",
                                           [r["uid"] for r in refused])
                    card_ids = [r[0] for r in await cur.fetchall()]
                    extra = await sync.export_cards(db, card_ids, ids)
                    for r in extra:
                        if r["t"] != "tasks":
                            rows.append(r)
                            force.append(r["uid"])
        # only what this account may see goes back (a made-up uid must not reveal anything)
        from .tasks import _visible_sql
        where, args = _visible_sql(user)
        cur = await db.execute(f"SELECT t.uid FROM tasks t WHERE {where}", args)
        vis = {r[0] for r in await cur.fetchall()}
        shown = [r for r in rows if (r["v"].get("owner_id") in (None, user["username"]) if r["t"] == "nodes"
                                     else (r["uid"] if r["t"] == "tasks" else r["v"].get("task_id")) in vis)]
        for r in rows:
            if r not in shown and r["uid"] in reasons:
                tombs.append({"t": r["t"], "uid": r["uid"], "ts": "", "dev": ""})
        rows = shown
        for table, uid in rep.dropped:                  # deleted here after the copy's edit
            cur = await db.execute("SELECT ts, dev FROM sync_tomb WHERE tbl = ? AND uid = ?", (table, uid))
            t = await cur.fetchone()
            if t:
                tombs.append({"t": table, "uid": uid, "ts": t[0], "dev": t[1]})
        return {"applied": rep.applied, "rows": rows, "tombs": tombs, "force": force, "reasons": reasons,
                "deferred": [[t, u] for t, u in rep.deferred], "users": await sync.people_of(db, rows), "now": _now_ms()}
    finally:
        await db.close()


async def _directory(db) -> dict:
    """Active accounts, so a standalone copy can show names and assign or @mention anyone while offline."""
    cur = await db.execute("""SELECT u.username, u.display_name, u.email, u.department, m.username FROM users u
                              LEFT JOIN users m ON m.id = u.manager_id
                              WHERE u.active = 1 AND u.source IN ('ldap', 'entra', 'demo') ORDER BY u.id LIMIT 5000""")
    return {r[0]: {"display_name": r[1], "email": r[2], "department": r[3], "manager": r[4], "directory": True}
            for r in await cur.fetchall()}


@router.get("/people")
async def people_search(request: Request, q: str = ""):
    """The same people search as the board's pickers (known accounts, then AD) for a linked copy."""
    _server_only()
    user = _signed_in(request)
    from .auth import people
    return [{k: p.get(k) for k in ("username", "display_name", "department", "relation")} for p in await people(q, user)]


@router.post("/pull")
async def pull(request: Request):
    _server_only()
    from .tasks import _visible_sql
    user = _signed_in(request)
    body = await _json(request)
    since = body.get("since") if isinstance(body.get("since"), int) else 0
    want = [u for u in (body.get("want") or []) if isinstance(u, str)][:2000]
    nodes_have = body.get("nodes_have")                 # public links this copy holds (newer copies send it)
    db = await get_db()
    try:
        seq = await sync.current_seq(db)
        # public links: only what this account may see (app/node_access.py)
        from ..node_access import hidden_ids
        hidden = await hidden_ids(db, user)
        cur = await db.execute("SELECT id, uid, parent_id FROM nodes WHERE owner_id IS NULL AND uid IS NOT NULL")
        pub = {r[1]: (r[0], r[2]) for r in await cur.fetchall()}
        pub_visible = [u for u, (i, _) in pub.items() if i not in hidden]
        pub_hidden = {u for u, (i, _) in pub.items() if i in hidden}
        where, args = _visible_sql(user)
        cur = await db.execute(f"SELECT t.id, t.uid FROM tasks t WHERE {where}", args)
        vis = {r[1]: r[0] for r in await cur.fetchall() if r[1]}
        ids = sync.Ids(db, server=True)
        rows, tombs = [], []
        if since <= 0:
            rows = await sync.export_cards(db, list(vis.values()), ids)
            rows += [r for r in await sync.export_rows(db, "nodes", "(owner_id IS NULL OR owner_id = ?)", (user["id"],), ids)
                     if r["uid"] not in pub_hidden]
        else:
            cur = await db.execute("SELECT DISTINCT tbl, uid FROM sync_clock WHERE seq > ?", (since,))
            changed: dict = {}
            for t, u in await cur.fetchall():
                if t in sync.TABLES:
                    changed.setdefault(t, []).append(u)
            for table in sync.ORDER:
                for r in await sync.export_by_uid(db, table, changed.get(table, []), ids):
                    if table == "nodes":
                        if r["v"].get("owner_id") in (None, user["username"]) and r["uid"] not in pub_hidden:
                            rows.append(r)
                        continue
                    card = r["uid"] if table == "tasks" else r["v"].get("task_id")
                    if card in vis:
                        rows.append(r)
            wanted = [vis[u] for u in want if u in vis]
            if wanted:
                have = {(r["t"], r["uid"]) for r in rows}
                rows += [r for r in await sync.export_cards(db, wanted, ids) if (r["t"], r["uid"]) not in have]
            if isinstance(nodes_have, list):            # newly visible (a folder opened to this person): the whole subtree
                have = set(u for u in nodes_have if isinstance(u, str)) | {r["uid"] for r in rows if r["t"] == "nodes"}
                gaps = [u for u in pub_visible if u not in have]
                if gaps:
                    by_id = {i: p for i, p in pub.values()}

                    def depth(u):
                        d, p = 0, pub[u][1]
                        while p is not None and d < 64:
                            d, p = d + 1, by_id.get(p)
                        return d
                    rows += await sync.export_by_uid(db, "nodes", sorted(gaps, key=depth), ids)
            cur = await db.execute("SELECT tbl, uid, ts, dev FROM sync_tomb WHERE seq > ?", (since,))
            tombs = [{"t": r[0], "uid": r[1], "ts": r[2], "dev": r[3]} for r in await cur.fetchall()]
        people = await _directory(db)
        people.update(await sync.people_of(db, rows))
        cur = await db.execute("SELECT * FROM users WHERE id = ?", (user["id"],))
        me = public_user(await cur.fetchone())
        me["supervisor"] = user.get("supervisor")
        if me.get("manager_id"):
            cur = await db.execute("SELECT username FROM users WHERE id = ?", (me["manager_id"],))
            m = await cur.fetchone()
            me["manager_username"] = m[0] if m else None
        team = list(user.get("team") or [])
        if team:
            cur = await db.execute(f"SELECT username FROM users WHERE id IN ({','.join('?' * len(team))})", team)
            me["team_usernames"] = [r[0] for r in await cur.fetchall()]
        from .settings import read_settings
        site = await read_settings(db)
        board = {k: site.get(k) for k in BOARD_SETTINGS}
        notes = await _notes_out(db, user)
        await db.commit()
        return {"rows": rows, "tombs": tombs, "visible": list(vis), "nodes_visible": pub_visible, "seq": seq, "users": people, "me": me, "now": _now_ms(),
                "settings": board, "notes": notes}
    finally:
        await db.close()


# ------------------------------------------------------------------ attachments (server)
@router.put("/blob/{uid}")
async def put_blob(uid: str, request: Request, name: str = ""):
    _server_only()
    _signed_in(request)
    if not uid.isalnum() or len(uid) > 64:
        raise HTTPException(status_code=400, detail="編號錯誤")
    data = await request.body()
    if not data or len(data) > img.MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="檔案太大")
    db = await get_db()
    try:
        cur = await db.execute("SELECT 1 FROM task_images WHERE uid = ? UNION ALL SELECT 1 FROM sync_blobs WHERE uid = ?", (uid, uid))
        if await cur.fetchone():
            return {"success": True, "known": True}
        try:
            stored, mime, kind = img.store(data, name)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        await db.execute("INSERT INTO sync_blobs (uid, stored, mime, kind, size) VALUES (?, ?, ?, ?, ?)",
                         (uid, stored, mime, kind, len(data)))
        await db.commit()
        return {"success": True}
    finally:
        await db.close()


@router.put("/icon/{name}")
async def put_icon(name: str, request: Request):
    """An icon file used by a personal link (kept if one with that name already exists)."""
    _server_only()
    _signed_in(request)
    from ..config import MAX_ICON_BYTES
    from .search import safe_icon_path
    dest = safe_icon_path(name)
    if dest.exists():
        return {"success": True, "known": True}
    data = await request.body()
    if not data or len(data) > MAX_ICON_BYTES:
        raise HTTPException(status_code=413, detail="圖示太大")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return {"success": True}


@router.get("/blob/{uid}")
async def get_blob(uid: str, request: Request):
    _server_only()
    from .tasks import _visible_sql
    user = _signed_in(request)
    db = await get_db()
    try:
        where, args = _visible_sql(user)
        cur = await db.execute(f"""SELECT i.stored, i.mime, i.name FROM task_images i JOIN tasks t ON t.id = i.task_id
                                   WHERE i.uid = ? AND {where}""", (uid, *args))
        r = await cur.fetchone()
    finally:
        await db.close()
    p = img.path(r["stored"]) if r else None
    if not p or not p.is_file():
        raise HTTPException(status_code=404, detail="找不到檔案")
    return FileResponse(p, media_type=r["mime"])


# ------------------------------------------------------------------ standalone copy
def _client_only():
    if C.AUTH:
        raise HTTPException(status_code=404, detail="伺服器版不需要連線到其他伺服器")


class ConnectIn(BaseModel):
    server: str = Field(..., max_length=300)
    username: str = Field(..., max_length=120)
    password: str = Field(..., max_length=500)
    verify: bool = True


class ResolveIn(BaseModel):
    id: int
    keep: str


@router.get("/client")
async def client_status():
    from .. import syncclient
    if C.AUTH:
        return {"available": False}
    return await syncclient.status()


@router.post("/client/connect")
async def client_connect(body: ConnectIn):
    _client_only()
    from .. import syncclient
    await syncclient.connect(body.server, body.username, body.password, body.verify)
    return await syncclient.status()


class BrowserConnectIn(BaseModel):
    server: str
    verify: bool = True


@router.post("/client/connect/start")
async def client_connect_start(body: BrowserConnectIn):
    """Link by approving in a browser (Microsoft account, or any sign-in): → {code, url} to open."""
    _client_only()
    from .. import syncclient
    return await syncclient.connect_browser_start(body.server, body.verify)


@router.post("/client/connect/poll")
async def client_connect_poll():
    _client_only()
    from .. import syncclient
    res = await syncclient.connect_browser_poll()
    return res if res.get("pending") else {"pending": False, **(await syncclient.status())}


@router.post("/client/now")
async def client_now():
    _client_only()
    from .. import syncclient
    await syncclient.sync_now()
    return await syncclient.status()


@router.post("/client/update")
async def client_update():
    """Check the server's version now (and update to it when it differs)."""
    _client_only()
    from .. import syncclient
    await syncclient.update_now()
    return await syncclient.status()


@router.post("/client/disconnect")
async def client_disconnect():
    _client_only()
    from .. import syncclient
    await syncclient.disconnect()
    return await syncclient.status()


@router.get("/client/log")
async def client_log(limit: int = 200):
    _client_only()
    from .. import syncclient
    return await syncclient.log(min(max(limit, 1), 500))


@router.post("/client/resolve")
async def client_resolve(body: ResolveIn):
    _client_only()
    from .. import syncclient
    if body.keep not in ("mine", "theirs"):
        raise HTTPException(status_code=400, detail="請選擇保留哪一個版本")
    await syncclient.resolve(body.id, body.keep)
    return {"success": True}
