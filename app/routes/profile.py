"""
Each account's profile: favorites, recently opened, sidebar / board / Gantt / radar choices, export format,
language … Stored on the server under the account (never in the browser), so it follows the person to any
computer. A standalone copy keeps its own (user_id 0) and syncs it with the linked account in every sync round.

GET  /api/profile          {prefs: {key: value}, site_lang, account}   (no account: empty, nothing kept)
PUT  /api/profile          {values: {key: value | null}}               null removes the key
POST /api/sync/profile     (standalone copy → server) {changes: [{key, value, at}], since} → {rows, now}
"""
import json
import re
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import config as C
from ..database import get_db

router = APIRouter(tags=["profile"])
KEY_RE = re.compile(r"^[a-z0-9][a-z0-9:_.-]{0,63}$")
MAX_VALUE = 64 * 1024
MAX_KEYS = 400


def _uid(request: Request) -> Optional[int]:
    """Whose profile: the signed-in account (server) or the standalone copy's own (0); None = nobody."""
    if not C.AUTH:
        return 0
    user = getattr(request.state, "user", None)
    return user.get("id") if user and user.get("id") is not None else None


async def read(db, uid: int) -> Dict[str, Any]:
    cur = await db.execute("SELECT key, value FROM profile WHERE user_id = ? AND value IS NOT NULL", (uid,))
    out = {}
    for k, v in await cur.fetchall():
        try:
            out[k] = json.loads(v)
        except ValueError:
            pass
    return out


async def write(db, uid: int, values: Dict[str, Any], at: Optional[int] = None, dirty: bool = False):
    at = at or int(time.time() * 1000)
    for k, v in values.items():
        if not KEY_RE.match(k or ""):
            raise HTTPException(status_code=400, detail=f"設定名稱無效：{k}")
        raw = None if v is None else json.dumps(v, ensure_ascii=False, separators=(",", ":"))
        if raw is not None and len(raw) > MAX_VALUE:
            raise HTTPException(status_code=400, detail="設定內容太大")
        await db.execute("""INSERT INTO profile (user_id, key, value, at, dirty) VALUES (?, ?, ?, ?, ?)
                            ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, at = excluded.at, dirty = excluded.dirty""",
                         (uid, k, raw, at, 1 if dirty else 0))
    cur = await db.execute("SELECT COUNT(*) FROM profile WHERE user_id = ?", (uid,))
    if (await cur.fetchone())[0] > MAX_KEYS:
        raise HTTPException(status_code=400, detail="設定項目太多")


@router.get("/api/profile")
async def get_profile(request: Request):
    from .settings import read_settings
    uid = _uid(request)
    db = await get_db()
    try:
        prefs = await read(db, uid) if uid is not None else {}
        if uid and "lang" not in prefs:                  # the account's language from before profiles
            cur = await db.execute("SELECT lang FROM users WHERE id = ?", (uid,))
            r = await cur.fetchone()
            if r and r[0]:
                prefs["lang"] = r[0]
        site = await read_settings(db)
        return {"prefs": prefs, "site_lang": site.get("language") or "zh-TW", "account": uid is not None}
    finally:
        await db.close()


class ProfileIn(BaseModel):
    values: Dict[str, Any]


@router.put("/api/profile")
async def put_profile(body: ProfileIn, request: Request):
    uid = _uid(request)
    if uid is None:
        raise HTTPException(status_code=401, detail="請先登入")
    if len(body.values) > 100:
        raise HTTPException(status_code=400, detail="一次最多 100 項")
    db = await get_db()
    try:
        await write(db, uid, body.values, dirty=not C.AUTH)          # a standalone copy sends it at the next sync
        if uid and "lang" in body.values and body.values["lang"] in ("zh-TW", "en", None):
            await db.execute("UPDATE users SET lang = ? WHERE id = ?", (body.values["lang"], uid))
        await db.commit()
    finally:
        await db.close()
    if not C.AUTH:
        from .. import sync
        sync.poke()                                                  # wake the sync loop
    return {"ok": True}


class SyncRow(BaseModel):
    key: str
    value: Optional[str] = None      # JSON text; None = removed
    at: int


class SyncIn(BaseModel):
    changes: List[SyncRow] = []
    since: int = 0


@router.post("/api/sync/profile")
async def sync_profile(body: SyncIn, request: Request):
    """A standalone copy's profile changes in, the account's changes since `since` out (last write wins per key)."""
    if not C.AUTH:
        raise HTTPException(status_code=404, detail="只有伺服器版提供")
    user = getattr(request.state, "user", None)
    if not user or user.get("id") is None:
        raise HTTPException(status_code=401, detail="請先登入")
    uid = user["id"]
    db = await get_db()
    try:
        for c in body.changes[:MAX_KEYS]:
            if not KEY_RE.match(c.key) or (c.value is not None and len(c.value) > MAX_VALUE):
                continue
            cur = await db.execute("SELECT at FROM profile WHERE user_id = ? AND key = ?", (uid, c.key))
            r = await cur.fetchone()
            if r is None or c.at > r[0]:
                await db.execute("""INSERT INTO profile (user_id, key, value, at) VALUES (?, ?, ?, ?)
                                    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, at = excluded.at""",
                                 (uid, c.key, c.value, c.at))
                if c.key == "lang" and c.value in ('"zh-TW"', '"en"'):
                    await db.execute("UPDATE users SET lang = ? WHERE id = ?", (json.loads(c.value), uid))
        await db.commit()
        cur = await db.execute("SELECT key, value, at FROM profile WHERE user_id = ? AND at > ? ORDER BY at", (uid, body.since))
        rows = [{"key": k, "value": v, "at": a} for k, v, a in await cur.fetchall()]
        cur = await db.execute("SELECT COALESCE(MAX(at), 0) FROM profile WHERE user_id = ?", (uid,))
        return {"rows": rows, "now": (await cur.fetchone())[0]}
    finally:
        await db.close()
