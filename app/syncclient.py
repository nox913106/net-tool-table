"""
Standalone copy (portable edition) ↔ server sync client.

Once linked with an Active Directory account (POST /api/sync/client/connect) the copy works as
that account and keeps syncing in the background:

  online   local edits go up within a couple of seconds; a long poll on the server's
           /api/sync/wait brings other people's edits down as soon as they happen
  offline  edits are kept (sync_clock.dirty) and sent when the server answers again
           (retry every 5 s, slowing to once a minute); "立即同步" tries at once

Each cycle pulls first (so edits on both sides are compared here, where both versions can be
kept for a manual choice), then pushes. The device token lives in sync_state (protected with
Windows DPAPI on the portable edition, so a copied data folder cannot be used elsewhere).
"""
import asyncio
import base64
import secrets
import json
import os
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

from fastapi import HTTPException

from . import images as img
from . import sync
from .database import get_db

LOCAL_USER: Optional[dict] = None
_status = {"online": None, "syncing": False, "last_ok": None, "last_try": None, "error": None, "rev": 0}
_lock: Optional[asyncio.Lock] = None
_remote_seq = {"seen": -1}
_retry = {"at": 0.0, "wait": 5.0}
_task = None


class SyncError(Exception):
    def __init__(self, msg: str, offline: bool = False, status: int = 0):
        super().__init__(msg)
        self.offline, self.status = offline, status


# ------------------------------------------------------------------ token protection
def _protect(token: str) -> str:
    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes

            class BLOB(ctypes.Structure):
                _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]
            raw = token.encode()
            src = BLOB(len(raw), ctypes.cast(ctypes.create_string_buffer(raw, len(raw)), ctypes.POINTER(ctypes.c_char)))
            out = BLOB()
            if ctypes.windll.crypt32.CryptProtectData(ctypes.byref(src), None, None, None, None, 0, ctypes.byref(out)):
                data = ctypes.string_at(out.pbData, out.cbData)
                ctypes.windll.kernel32.LocalFree(out.pbData)
                return "dpapi:" + base64.b64encode(data).decode()
        except Exception:
            pass
    return "plain:" + token


def _unprotect(stored: Optional[str]) -> Optional[str]:
    if not stored:
        return None
    if stored.startswith("plain:"):
        return stored[6:]
    if stored.startswith("dpapi:") and sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes

            class BLOB(ctypes.Structure):
                _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]
            raw = base64.b64decode(stored[6:])
            src = BLOB(len(raw), ctypes.cast(ctypes.create_string_buffer(raw, len(raw)), ctypes.POINTER(ctypes.c_char)))
            out = BLOB()
            if ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(src), None, None, None, None, 0, ctypes.byref(out)):
                data = ctypes.string_at(out.pbData, out.cbData)
                ctypes.windll.kernel32.LocalFree(out.pbData)
                return data.decode()
        except Exception:
            return None
    return None


# ------------------------------------------------------------------ HTTP
def _http(cfg: dict, method: str, path: str, body=None, raw: Optional[bytes] = None, timeout: float = 60,
          token: bool = True) -> bytes:
    url = cfg["server"] + path
    headers = {"X-Tool-Table": "1", "User-Agent": "ToolTable-Portable-Sync"}
    data = None
    if raw is not None:
        data = raw
        headers["Content-Type"] = "application/octet-stream"
    elif body is not None:
        data = json.dumps(body, ensure_ascii=False).encode()
        headers["Content-Type"] = "application/json"
    if token and cfg.get("token"):
        headers["Authorization"] = "Bearer " + cfg["token"]
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    ctx = ssl.create_default_context() if cfg.get("verify", True) else ssl._create_unverified_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx if url.startswith("https") else None) as res:
            return res.read()
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read() or b"{}").get("detail")
        except Exception:
            detail = None
        msg = detail if isinstance(detail, str) else f"伺服器回應 HTTP {e.code}"
        if e.code == 401:
            msg = "伺服器不再接受這台電腦的連結（可能已被移除或太久沒有同步），請重新連線"
        raise SyncError(msg, offline=e.code in (502, 503, 504), status=e.code)
    except ssl.SSLError as e:
        raise SyncError(f"無法驗證伺服器憑證：{e.reason or e}", offline=False)
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as e:
        reason = getattr(e, "reason", e)
        if isinstance(reason, ssl.SSLError):
            raise SyncError(f"無法驗證伺服器憑證：{reason.reason or reason}", offline=False)
        raise SyncError(f"連不到伺服器（{reason}）", offline=True)


async def _call(cfg, method, path, body=None, raw=None, timeout=60, token=True, as_json=True):
    loop = asyncio.get_running_loop()
    data = await loop.run_in_executor(None, lambda: _http(cfg, method, path, body, raw, timeout, token))
    if not as_json:
        return data
    try:
        return json.loads(data or b"{}")
    except ValueError:
        raise SyncError("伺服器回應的不是 Tool Table 同步資料（網址正確嗎？）")


def _normalize_server(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    if not url:
        raise HTTPException(status_code=400, detail="請輸入伺服器網址")
    if "://" not in url:
        url = "https://" + url
    p = urllib.parse.urlparse(url)
    if p.scheme not in ("http", "https") or not p.netloc:
        raise HTTPException(status_code=400, detail="伺服器網址格式錯誤，例如 https://tools.corp.local")
    return f"{p.scheme}://{p.netloc}{p.path.rstrip('/')}"


# ------------------------------------------------------------------ config
async def _cfg(db) -> dict:
    token = _unprotect(await sync.state(db, "token"))
    user = await sync.state(db, "user")
    return {"server": await sync.state(db, "server"), "token": token,
            "verify": (await sync.state(db, "verify", "1")) == "1",
            "user": json.loads(user) if user else None,
            "cursor": int(await sync.state(db, "cursor", "0") or 0)}


def _linked(cfg) -> bool:
    return bool(cfg.get("server") and cfg.get("token") and cfg.get("user"))


async def _offset(db, server_ms, sent: float):
    if isinstance(server_ms, (int, float)):
        mid = (sent + time.time()) / 2
        off = server_ms / 1000 - mid
        await sync.set_state(db, "offset", f"{off:+.3f} seconds")


async def _local_account(db, info: dict) -> int:
    cur = await db.execute("SELECT id FROM users WHERE username = ?", (info["username"],))
    r = await cur.fetchone()
    if r:
        await db.execute("UPDATE users SET display_name = ?, email = ?, department = ?, active = 1 WHERE id = ?",
                         (info.get("display_name"), info.get("email"), info.get("department"), r[0]))
        return r[0]
    cur = await db.execute("INSERT INTO users (username, source, display_name, email, department, role, active) "
                           "VALUES (?, 'ldap', ?, ?, ?, 'user', 1)",
                           (info["username"], info.get("display_name"), info.get("email"), info.get("department")))
    return cur.lastrowid


async def _as_local_user(db, uid: int, info: dict) -> dict:
    """Locally the linked account sees the board with its server role (what the server would refuse
    shows read-only here too) and keeps full control of this computer's own portal (local_admin)."""
    ids = sync.Ids(db, server=False)
    team = []
    for name in info.get("team_usernames") or []:
        i = await ids.user_id(name)
        if i:
            team.append(i)
    manager = await ids.user_id(info["manager_username"]) if info.get("manager_username") else None
    return {"id": uid, "username": info["username"], "display_name": info.get("display_name") or info["username"],
            "manager_id": manager,
            "role": info.get("role") or "user", "source": "ldap", "department": info.get("department") or "",
            "email": info.get("email") or "", "active": 1, "scope_departments": info.get("scope_departments") or [],
            "team": team, "supervisor": info.get("supervisor") or "rw", "local_admin": True}


async def startup():
    """Load the link (if any) and start the background loop. Standalone copy only."""
    global LOCAL_USER, _lock, _task
    _lock = asyncio.Lock()
    db = await get_db()
    try:
        cfg = await _cfg(db)
        if cfg["user"]:
            uid = await _local_account(db, cfg["user"])
            LOCAL_USER = await _as_local_user(db, uid, cfg["user"])
            await db.commit()
    finally:
        await db.close()
    _task = [asyncio.create_task(_loop()), asyncio.create_task(_listen())]
    return _task


# ------------------------------------------------------------------ link
async def connect(server: str, username: str, password: str, verify: bool = True):
    global LOCAL_USER
    server = _normalize_server(server)
    db = await get_db()
    try:
        device = await sync.state(db, "device")
        old = await _cfg(db)
    finally:
        await db.close()
    cfg = {"server": server, "verify": verify}
    sent = time.time()
    try:
        res = await _call(cfg, "POST", "/api/sync/link", {"username": username, "password": password,
                                                           "name": socket.gethostname()[:80], "device": device}, token=False, timeout=30)
    except SyncError as e:
        raise HTTPException(status_code=400, detail=str(e))
    user, token = res.get("user"), res.get("token")
    if not user or not token:
        raise HTTPException(status_code=400, detail="伺服器沒有回應連結資訊（網址是 Tool Table 伺服器嗎？）")
    if old.get("user") and old["user"].get("username") != user["username"] and old.get("server"):
        raise HTTPException(status_code=400, detail=f"這台電腦的資料屬於 {old['user'].get('display_name') or old['user']['username']}，"
                                                    "不能改連另一個帳號（請改用另一份單機版）")
    db = await get_db()
    try:
        uid = await _local_account(db, user)
        # what was made here before linking belongs to this account
        await db.execute("UPDATE tasks SET owner_id = ? WHERE owner_id IS NULL", (uid,))
        for table in ("task_comments", "task_time", "task_images"):
            await db.execute(f"UPDATE {table} SET user_id = ? WHERE user_id IS NULL", (uid,))
        if not old.get("user"):                      # first link: this computer's links become my 個人區
            await db.execute("UPDATE nodes SET owner_id = ? WHERE owner_id IS NULL", (uid,))
        await sync.seed_dirty(db)
        await sync.set_state(db, "server", server)
        await sync.set_state(db, "token", _protect(token))
        await sync.set_state(db, "verify", "1" if verify else "0")
        await sync.set_state(db, "user", json.dumps(user, ensure_ascii=False))
        if old.get("server") != server:
            await sync.set_state(db, "cursor", "0")
        await _offset(db, res.get("now"), sent)
        LOCAL_USER = await _as_local_user(db, uid, user)
        await db.commit()
    finally:
        await db.close()
    _retry["at"] = 0
    try:
        await sync_now()
    except Exception:
        pass


async def disconnect():
    """Stop syncing. The data stays here and keeps working offline."""
    global LOCAL_USER
    db = await get_db()
    try:
        cfg = await _cfg(db)
    finally:
        await db.close()
    if _linked(cfg):
        try:
            await _call(cfg, "POST", "/api/sync/unlink", {}, timeout=10)
        except Exception:
            pass
    db = await get_db()
    try:
        await sync.set_state(db, "token", None)
        await db.commit()
    finally:
        await db.close()
    _status.update(online=None, error=None)


# ------------------------------------------------------------------ one cycle
async def sync_now():
    """Pull, then push. Raises nothing: the outcome is in status()."""
    if _lock is None:
        return
    async with _lock:
        db = await get_db()
        try:
            cfg = await _cfg(db)
        finally:
            await db.close()
        if not _linked(cfg):
            return
        _status.update(syncing=True, last_try=time.time())
        try:
            await _pull(cfg)
            await _push(cfg)
            _status.update(online=True, error=None, last_ok=time.time())
            _retry.update(at=0, wait=5.0)
        except SyncError as e:
            _status.update(online=False if e.offline else True, error=str(e))
            _retry["at"] = time.time() + _retry["wait"]
            _retry["wait"] = min(60.0, _retry["wait"] * 2)
        except Exception as e:                       # never let the loop die
            _status.update(error=f"同步失敗：{e}")
            _retry["at"] = time.time() + _retry["wait"]
        finally:
            _status["syncing"] = False


async def _after_merge(db, rep: sync.Report):
    from .routes.tasks import _sync_subtask_members
    for card in {c for c in rep.cards if c}:
        cur = await db.execute("SELECT 1 FROM tasks WHERE id = ?", (card,))
        if await cur.fetchone():
            await _sync_subtask_members(db, card)


async def _pull(cfg):
    global LOCAL_USER
    want = []
    for _ in range(3):
        sent = time.time()
        res = await _call(cfg, "POST", "/api/sync/pull", {"since": cfg["cursor"], "want": want}, timeout=120)
        db = await get_db()
        try:
            await _offset(db, res.get("now"), sent)
            if isinstance(res.get("users"), dict):
                await _directory_in(db, res["users"])
            rep = await sync.merge(db, res, server=False, log=True)
            await _after_merge(db, rep)
            removed = await _reconcile(db, set(res.get("visible") or []))
            cur = await db.execute("SELECT uid FROM tasks WHERE uid IS NOT NULL")
            local = {r[0] for r in await cur.fetchall()}
            cur = await db.execute("SELECT uid FROM sync_tomb WHERE tbl = 'tasks' AND dirty = 1")
            local |= {r[0] for r in await cur.fetchall()}
            missing = [u for u in res.get("visible") or [] if u not in local]
            if isinstance(res.get("settings"), dict):       # the server's board rules (tag colours, load thresholds…)
                from .routes.settings import DEFAULT_SETTINGS, validate_setting
                for k, v in res["settings"].items():
                    if k in DEFAULT_SETTINGS and k.startswith("board_"):
                        try:
                            v = validate_setting(k, v)
                        except Exception:
                            continue
                        await db.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                                         (k, json.dumps(v, ensure_ascii=False)))
            if isinstance(res.get("seq"), int):
                await sync.set_state(db, "cursor", str(res["seq"]))
                cfg["cursor"] = res["seq"]
                _remote_seq["seen"] = max(_remote_seq["seen"], res["seq"])
            if res.get("me", {}).get("username") == (cfg.get("user") or {}).get("username"):
                await sync.set_state(db, "user", json.dumps(res["me"], ensure_ascii=False))
                uid = await _local_account(db, res["me"])
                LOCAL_USER = await _as_local_user(db, uid, res["me"])
            await _notes_in(db, res.get("notes"))
            await db.commit()
        finally:
            await db.close()
        img.remove(rep.files_removed + removed)
        await _fetch_blobs(cfg, rep.need_blobs)
        if rep.nodes:
            await _fetch_icons(cfg)
        if rep.nodes:
            _status["nodes_rev"] = _status.get("nodes_rev", 0) + 1
        if rep.applied or removed:
            _status["rev"] += 1
            sync.poke()
        if not missing or missing == want:
            break
        want = missing


async def _directory_in(db, people: dict):
    """Mirror the server's account list (names, departments, reporting lines) for pickers and @mentions."""
    rows = [(u, p) for u, p in people.items() if isinstance(u, str) and isinstance(p, dict) and p.get("directory")]
    if not rows:
        return
    cur = await db.execute("SELECT id, username FROM users")
    have = {r[1]: r[0] for r in await cur.fetchall()}
    for u, p in rows:
        if u in have:
            await db.execute("UPDATE users SET display_name = ?, email = ?, department = ?, active = 1 WHERE id = ?",
                             (p.get("display_name"), p.get("email"), p.get("department"), have[u]))
        else:
            cur = await db.execute("INSERT INTO users (username, source, display_name, email, department, role, active) "
                                   "VALUES (?, 'ldap', ?, ?, ?, 'user', 1)", (u, p.get("display_name"), p.get("email"), p.get("department")))
            have[u] = cur.lastrowid
    for u, p in rows:
        if "manager" in p:
            await db.execute("UPDATE users SET manager_id = ? WHERE id = ?", (have.get(p.get("manager")) if p.get("manager") else None, have[u]))


async def _notes_in(db, notes: list):
    """The account's notifications from the server: new ones appear in 🔔, read there = read here."""
    if LOCAL_USER is None or not isinstance(notes, list):
        return
    me = LOCAL_USER["id"]
    for n in notes[:500]:
        if not isinstance(n, dict) or not isinstance(n.get("uid"), str):
            continue
        cur = await db.execute("SELECT id, read FROM notifications WHERE uid = ?", (n["uid"],))
        r = await cur.fetchone()
        if r:
            if n.get("read") and not r[1]:
                await db.execute("UPDATE notifications SET read = 1, synced = 1 WHERE id = ?", (r[0],))
            continue
        task_id = actor = None
        if n.get("task"):
            cur = await db.execute("SELECT id FROM tasks WHERE uid = ?", (n["task"],))
            t = await cur.fetchone()
            task_id = t[0] if t else None
        if n.get("actor"):
            cur = await db.execute("SELECT id FROM users WHERE username = ?", (n["actor"],))
            a = await cur.fetchone()
            actor = a[0] if a else None
        await db.execute("""INSERT INTO notifications (uid, user_id, task_id, actor_id, kind, text, read, created_at, synced)
                            VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), 1)""",
                         (n["uid"], me, task_id, actor, n.get("kind") or "comment", n.get("text") or "",
                          1 if n.get("read") else 0, n.get("created_at")))


async def _notes_out(db) -> tuple:
    """What this copy owes the server: notifications its user's actions made for other people, and which of
    the user's own notifications were read here. Returns (payload or None, ids sent)."""
    if LOCAL_USER is None:
        return None, []
    me = LOCAL_USER["id"]
    cur = await db.execute("""SELECT n.id, n.uid, n.user_id, n.actor_id, n.kind, n.text, n.read, n.created_at,
                                     u.username, t.uid AS task FROM notifications n
                              LEFT JOIN users u ON u.id = n.user_id LEFT JOIN tasks t ON t.id = n.task_id
                              WHERE n.synced = 0 ORDER BY n.id LIMIT 500""")
    rows = await cur.fetchall()
    new, read, ids = [], [], []
    for r in rows:
        uid = r["uid"]
        if not uid:
            uid = secrets.token_hex(12)
            await db.execute("UPDATE notifications SET uid = ? WHERE id = ?", (uid, r["id"]))
        ids.append(r["id"])
        if r["user_id"] == me:
            if r["read"]:
                read.append(uid)
        elif r["actor_id"] == me and r["username"]:
            new.append({"uid": uid, "user": r["username"], "task": r["task"], "kind": r["kind"], "text": r["text"],
                        "created_at": r["created_at"]})
    await db.commit()
    if not new and not read:
        return None, ids
    return {"new": new, "read": read}, ids


async def remote_people(q: str) -> list:
    """People search on the server (AD directory included) while it is reachable; [] otherwise."""
    db = await get_db()
    try:
        cfg = await _cfg(db)
    finally:
        await db.close()
    if not _linked(cfg) or not _status.get("online"):
        return []
    try:
        res = await _call(cfg, "GET", f"/api/sync/people?q={urllib.parse.quote(q)}", timeout=5)
        return res if isinstance(res, list) else []
    except Exception:
        return []


async def _reconcile(db, visible: set) -> list:
    """Cards the account can no longer see (reassigned, role changed) leave this copy — unless
    they still hold edits made here, which go up first."""
    cur = await db.execute("SELECT id, uid FROM tasks WHERE uid IS NOT NULL")
    gone = [(i, u) for i, u in await cur.fetchall() if u not in visible]
    files = []
    if not gone:
        return files
    await db.execute("INSERT INTO sync_ctx (k) VALUES (1)")
    try:
        for card, uid in gone:
            cur = await db.execute("""SELECT 1 FROM sync_clock WHERE dirty = 1 AND (
                                          (tbl = 'tasks' AND uid = ?)
                                       OR (tbl = 'task_comments' AND uid IN (SELECT uid FROM task_comments WHERE task_id = ?))
                                       OR (tbl = 'task_members' AND uid IN (SELECT uid FROM task_members WHERE task_id = ?))
                                       OR (tbl = 'task_time' AND uid IN (SELECT uid FROM task_time WHERE task_id = ?))
                                       OR (tbl = 'task_images' AND uid IN (SELECT uid FROM task_images WHERE task_id = ?))) LIMIT 1""",
                                   (uid, card, card, card, card))
            if await cur.fetchone():
                continue
            cur = await db.execute("SELECT stored FROM task_images WHERE task_id = ?", (card,))
            files += [r[0] for r in await cur.fetchall() if r[0]]
            await db.execute("DELETE FROM tasks WHERE id = ?", (card,))
        for table in sync.ORDER:
            await db.execute(f"DELETE FROM sync_clock WHERE tbl = ? AND uid NOT IN (SELECT uid FROM {table} WHERE uid IS NOT NULL)", (table,))
    finally:
        await db.execute("DELETE FROM sync_ctx")
    return files


async def _fetch_blobs(cfg, uids):
    for uid in uids:
        try:
            data = await _call(cfg, "GET", f"/api/sync/blob/{uid}", as_json=False, timeout=120)
        except SyncError as e:
            if e.status == 404:
                continue
            raise
        db = await get_db()
        try:
            cur = await db.execute("SELECT name FROM task_images WHERE uid = ? AND stored = ''", (uid,))
            r = await cur.fetchone()
            if not r:
                continue
            try:
                stored, _, _ = img.store(data, r[0] or "")
            except ValueError:
                continue
            await db.execute("INSERT INTO sync_ctx (k) VALUES (1)")
            await db.execute("UPDATE task_images SET stored = ? WHERE uid = ?", (stored, uid))
            await db.execute("DELETE FROM sync_ctx")
            await db.execute("INSERT OR IGNORE INTO sync_sent_blobs (uid) VALUES (?)", (uid,))
            await db.commit()
        finally:
            await db.close()


def _icon_file(name):
    from .routes.search import safe_icon_path
    try:
        return safe_icon_path(name)
    except Exception:
        return None                                   # a built-in icon name, not a file


async def _fetch_icons(cfg):
    """Icon files used by links that came from the server (public area, my personal links)."""
    db = await get_db()
    try:
        cur = await db.execute("SELECT DISTINCT icon FROM nodes WHERE icon IS NOT NULL AND icon != ''")
        names = [r[0] for r in await cur.fetchall()]
    finally:
        await db.close()
    for name in names:
        p = _icon_file(name)
        if not p or p.exists():
            continue
        try:
            data = await _call(cfg, "GET", "/resource/icon/" + urllib.parse.quote(name), as_json=False, token=False, timeout=30)
        except SyncError:
            continue
        if data and len(data) <= 5 * 1024 * 1024:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)


async def _send_icons(cfg, names):
    for name in names:
        p = _icon_file(name)
        if not p or not p.is_file():
            continue
        try:
            await _call(cfg, "PUT", "/api/sync/icon/" + urllib.parse.quote(name), raw=p.read_bytes(), timeout=60)
        except SyncError as e:
            if e.offline:
                raise


async def _push(cfg):
    db = await get_db()
    try:
        payload = await sync.dirty_payload(db)
        notes, note_ids = await _notes_out(db)
        if notes:
            payload["notes"] = notes
        elif payload["rows"] or payload["tombs"]:
            payload["notes"] = {"new": [], "read": []}     # this copy sends its own notifications
        if not payload["rows"] and not payload["tombs"] and not notes:
            if note_ids:
                await db.execute(f"UPDATE notifications SET synced = 1 WHERE id IN ({','.join('?' * len(note_ids))})", note_ids)
                await db.commit()
            return
        uploads = []
        new_images = [r["uid"] for r in payload["rows"] if r["t"] == "task_images"]
        for uid in new_images:
            cur = await db.execute("""SELECT i.stored, i.name FROM task_images i WHERE i.uid = ?
                                      AND NOT EXISTS (SELECT 1 FROM sync_sent_blobs s WHERE s.uid = i.uid)""", (uid,))
            r = await cur.fetchone()
            if r and r[0]:
                uploads.append((uid, r[0], r[1]))
    finally:
        await db.close()
    icons = {r["v"].get("icon") for r in payload["rows"] if r["t"] == "nodes" and r["v"].get("icon")}
    await _send_icons(cfg, icons)
    for uid, stored, name in uploads:                 # files first, so their rows can be applied
        p = img.path(stored)
        if not p or not p.is_file():
            continue
        await _call(cfg, "PUT", f"/api/sync/blob/{uid}?name={urllib.parse.quote(name or stored)}", raw=p.read_bytes(), timeout=300)
        db = await get_db()
        try:
            await db.execute("INSERT OR IGNORE INTO sync_sent_blobs (uid) VALUES (?)", (uid,))
            await db.commit()
        finally:
            await db.close()
    sent = time.time()
    res = await _call(cfg, "POST", "/api/sync/push", payload, timeout=300)
    db = await get_db()
    try:
        await _offset(db, res.get("now"), sent)
        rep = await sync.merge(db, {"rows": res.get("rows") or [], "tombs": res.get("tombs") or [], "users": res.get("users") or {}},
                               server=False, log=True, force=frozenset(res.get("force") or []), reasons=res.get("reasons") or {})
        keep = {(t, u) for t, u in res.get("deferred") or []}
        await sync.clear_sent(db, payload, keep)
        if note_ids:                                     # sent: the server has them now (others' copies are not kept here)
            marks = ','.join('?' * len(note_ids))
            await db.execute(f"DELETE FROM notifications WHERE id IN ({marks}) AND user_id != ?", (*note_ids, LOCAL_USER["id"]))
            await db.execute(f"UPDATE notifications SET synced = 1 WHERE id IN ({marks})", note_ids)
        await _after_merge(db, rep)
        await db.commit()
    finally:
        await db.close()
    img.remove(rep.files_removed)
    await _fetch_blobs(cfg, rep.need_blobs)
    if rep.applied:
        _status["rev"] += 1
        sync.poke()


# ------------------------------------------------------------------ background
async def _loop():
    tick = 0
    while True:
        await sync.changed(2.0)                       # woken by any local change
        tick += 1
        try:
            db = await get_db()
            try:
                cfg = await _cfg(db)
                pending = await sync.pending_count(db) if _linked(cfg) else 0
            finally:
                await db.close()
            if not _linked(cfg) or _status["syncing"]:
                continue
            remote = _remote_seq["seen"] > cfg["cursor"]
            due = pending or remote or tick % 30 == 0 or not _status["online"]      # offline: retry (backs off)
            if due and time.time() >= _retry["at"]:
                await sync_now()
        except Exception:
            pass


async def _listen():
    """Long poll the server: return as soon as anything changes there."""
    while True:
        try:
            db = await get_db()
            try:
                cfg = await _cfg(db)
            finally:
                await db.close()
            if not _linked(cfg):
                await asyncio.sleep(2)
                continue
            if _status["online"] is False and time.time() < _retry["at"]:
                await asyncio.sleep(1)
                continue
            res = await _call(cfg, "GET", f"/api/sync/wait?since={cfg['cursor']}", timeout=40)
            seq = res.get("seq")
            if _status["online"] and not _status["error"] and not _status["syncing"]:
                _status["last_ok"] = time.time()          # connected and nothing new: still in sync
            if _status["online"] is False:              # the server answers again: sync now
                _retry["at"] = 0
                sync.poke()
            if isinstance(seq, int) and seq > cfg["cursor"]:
                _remote_seq["seen"] = seq
                sync.poke()
        except SyncError as e:
            if e.offline:
                _status["online"] = False
            await asyncio.sleep(3)
        except Exception:
            await asyncio.sleep(5)


# ------------------------------------------------------------------ status / log
FIELD_LABELS = {
    "title": "標題", "description": "說明", "status": "狀態", "priority": "優先", "start_at": "開始", "due_at": "到期",
    "remind": "提醒", "repeat": "重複", "repeat_every": "重複間隔", "owner_id": "建立者", "blocked_at": "卡住",
    "blocked_reason": "卡住原因", "blocked_by": "標記卡住的人", "body": "內容", "assignee_id": "負責人",
    "estimate_minutes": "預估時間", "is_task": "子任務", "done_at": "協作完成", "minutes": "工時", "note": "工時說明",
    "work_date": "工作日期", "name": "檔名", "parent_id": "所屬留言", "next_id": "下一次",
}
TABLE_LABELS = {"tasks": "卡片", "task_comments": "留言／子任務", "task_members": "協作人", "task_time": "工時", "task_images": "附件"}
STATUS_ZH = {"recurring": "週期工作", "overdue": "過期未結案", "new": "新建", "ongoing": "進行中", "pending": "待確認",
             "onhold": "暫停", "complete": "完成", "canceled": "取消"}


async def status() -> dict:
    db = await get_db()
    try:
        cfg = await _cfg(db)
        pending = await sync.pending_count(db)
        cur = await db.execute("SELECT COUNT(*) FROM sync_log WHERE kind = 'conflict' AND status = 'open'")
        conflicts = (await cur.fetchone())[0]
        device = await sync.state(db, "device")
    finally:
        await db.close()
    user = cfg.get("user") or {}
    return {"available": True, "linked": _linked(cfg), "server": cfg.get("server"),
            "was_linked": bool(cfg.get("user")) and not cfg.get("token"),
            "user": {"username": user.get("username"), "display_name": user.get("display_name"), "role": user.get("role")} if user else None,
            "online": _status["online"], "syncing": _status["syncing"], "pending": pending, "conflicts": conflicts,
            "last_ok": _status["last_ok"], "last_try": _status["last_try"], "error": _status["error"],
            "rev": _status["rev"], "device": device, "verify": cfg.get("verify", True)}


async def _display(db, table, field, raw):
    try:
        v = json.loads(raw) if raw is not None else None
    except ValueError:
        v = raw
    if v is None or v == "":
        return "（空白）"
    if field in ("owner_id", "blocked_by", "assignee_id", "user_id"):
        cur = await db.execute("SELECT COALESCE(display_name, username) FROM users WHERE id = ?", (v,))
        r = await cur.fetchone()
        return r[0] if r else str(v)
    if field == "status":
        return STATUS_ZH.get(v, v)
    if field == "priority":
        return {"low": "低", "normal": "一般", "high": "高"}.get(v, v)
    if field == "estimate_minutes" or field == "minutes":
        return f"{v} 分鐘"
    return str(v)


async def log(limit: int) -> list:
    db = await get_db()
    try:
        cur = await db.execute("""SELECT * FROM sync_log ORDER BY (kind = 'conflict' AND status = 'open') DESC, id DESC LIMIT ?""", (limit,))
        rows = await cur.fetchall()
        out = []
        for r in rows:
            card_id = None
            if r["tbl"] == "tasks":
                c = await (await db.execute("SELECT id FROM tasks WHERE uid = ?", (r["uid"],))).fetchone()
                card_id = c[0] if c else None
            elif r["tbl"] in sync.TABLES:
                c = await (await db.execute(f"SELECT {sync.TABLES[r['tbl']]['card']} FROM {r['tbl']} WHERE uid = ?", (r["uid"],))).fetchone()
                card_id = c[0] if c else None
            out.append({"id": r["id"], "at": r["at"], "kind": r["kind"], "what": TABLE_LABELS.get(r["tbl"], r["tbl"]),
                        "card": r["card"], "card_id": card_id, "field": FIELD_LABELS.get(r["field"], r["field"]),
                        "mine": await _display(db, r["tbl"], r["field"], r["mine"]) if r["kind"] != "deleted" else None,
                        "theirs": await _display(db, r["tbl"], r["field"], r["theirs"]) if r["kind"] != "deleted" else None,
                        "winner": r["winner"], "status": r["status"], "note": r["note"]})
        return out
    finally:
        await db.close()


async def resolve(log_id: int, keep: str):
    """Put the chosen version of a conflicting field in place (it then syncs like any edit)."""
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM sync_log WHERE id = ? AND kind = 'conflict'", (log_id,))
        r = await cur.fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="找不到這筆衝突")
        if r["status"] == "open" and r["tbl"] in sync.TABLES and r["field"] in sync.TABLES[r["tbl"]]["fields"]:
            value = json.loads(r["mine"] if keep == "mine" else r["theirs"])
            await db.execute(f"UPDATE {r['tbl']} SET {r['field']} = ? WHERE uid = ? AND {r['field']} IS NOT ?",
                             (value, r["uid"], value))
            if r["tbl"] == "task_comments":
                c = await (await db.execute("SELECT task_id FROM task_comments WHERE uid = ?", (r["uid"],))).fetchone()
                if c:
                    from .routes.tasks import rollup_status, _sync_subtask_members
                    await _sync_subtask_members(db, c[0])
                    await rollup_status(db, c[0])
        await db.execute("UPDATE sync_log SET status = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?",
                         ("kept-" + keep, log_id))
        await db.commit()
    finally:
        await db.close()
    _status["rev"] += 1
    sync.poke()
