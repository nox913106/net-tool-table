"""
Accounts, sessions and access control (server edition).

Roles
  superadmin  the local break-glass account created by the installer (not used day to day)
  admin       board admin + site admin: sees every card, assigns people, edits the portal
  user        everyone else who signs in with Active Directory: their own / assigned /
              @mentioned cards; can browse the portal

With TOOL_TABLE_AUTH off (portable edition, development) every request runs as an
implicit local superadmin and nothing asks for a password.

Sessions: random token in an HttpOnly, SameSite=Lax cookie (Secure over HTTPS); only its
SHA-256 is stored. Idle timeout TOOL_TABLE_SESSION_HOURS, hard limit _SESSION_MAX_DAYS.
State-changing API calls must carry the X-Tool-Table header (sent by the frontend), which
a cross-site form or image cannot add — CSRF protection on top of SameSite.
"""
import base64
import hashlib
import hmac
import secrets
import time
from collections import defaultdict, deque
from typing import Optional
from urllib.parse import quote

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse

from . import config as C
from . import sysconfig
from .database import get_db

COOKIE = "tt_session"
ANON = {"id": None, "username": "local", "display_name": "本機", "role": "superadmin", "source": "local",
        "department": "", "email": "", "active": 1}

# ------------------------------------------------------------------ paths
PUBLIC_EXACT = {
    "/login", "/dashboard", "/manifest.webmanifest", "/sw.js", "/favicon.ico",
    "/api/health", "/api/auth/login", "/api/sync/link", "/api/auth/status", "/api/public/dashboard", "/api/public/branding",
}
PUBLIC_PREFIX = ("/assets/", "/resource/icon/")
ADMIN_PAGES = ("/admin", "/admin.html")
ADMIN_ANY_METHOD = ("/api/export", "/api/import", "/api/users", "/api/local", "/api/settings/reset", "/api/settings/defaults",
                    "/api/system")
ADMIN_WRITE = ("/api/nodes", "/api/auth-links", "/api/icons", "/api/settings")
SAFE_METHODS = ("GET", "HEAD", "OPTIONS")


def is_admin(user: dict) -> bool:
    """System administrator: may use the admin panel. Board rights: see app/roles.py."""
    from .roles import is_sysadmin
    return is_sysadmin(user)


def _starts(path: str, prefixes) -> bool:
    return any(path == p or path.startswith(p + "/") or path.startswith(p + "?") for p in prefixes)


# --------------------------------------------------------------- passwords
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    n, r, p = 2 ** 14, 8, 1
    digest = hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, dklen=32)
    return f"scrypt${n}${r}${p}${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password: str, stored: Optional[str]) -> bool:
    try:
        algo, n, r, p, salt, digest = (stored or "").split("$")
        if algo != "scrypt":
            return False
        calc = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=32)
        return hmac.compare_digest(calc, base64.b64decode(digest))
    except Exception:
        return False


def generate_password(length: int = 20) -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
    return "".join(secrets.choice(alphabet) for _ in range(length))


# ----------------------------------------------------------------- sessions
def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def create_session(db, user_id: int, request: Request) -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    await db.execute("INSERT INTO sessions (token_hash, user_id, created, last_seen, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
                     (_token_hash(token), user_id, now, now, client_ip(request), (request.headers.get("user-agent") or "")[:200]))
    sec = sysconfig.security()
    await db.execute("DELETE FROM sessions WHERE last_seen < ? OR created < ?",
                     (now - sec.session_hours * 3600, now - sec.session_max_days * 86400))
    return token


async def session_user(token: Optional[str]) -> Optional[dict]:
    if not token or len(token) > 100:
        return None
    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT u.*, s.last_seen, s.created AS s_created FROM sessions s JOIN users u ON u.id = s.user_id
               WHERE s.token_hash = ?""", (_token_hash(token),))
        row = await cur.fetchone()
        if not row:
            return None
        now = time.time()
        sec = sysconfig.security()
        if not row["active"] or now - row["last_seen"] > sec.session_hours * 3600 or now - row["s_created"] > sec.session_max_days * 86400:
            await db.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))
            await db.commit()
            return None
        if now - row["last_seen"] > 300:                  # sliding expiry, written at most every 5 min
            await db.execute("UPDATE sessions SET last_seen = ? WHERE token_hash = ?", (now, _token_hash(token)))
            await db.commit()
        return await full_user(db, row)
    finally:
        await db.close()


async def full_user(db, row) -> dict:
    user = public_user(row)
    # reporting line: who is below this person, and what a supervisor may do with their cards
    from .team import team_ids
    user["team"] = await team_ids(db, row["id"])
    cur = await db.execute("SELECT value FROM settings WHERE key = 'board_supervisor'")
    s = await cur.fetchone()
    mode = (s[0] or '"rw"').strip('"') if s else "rw"
    user["supervisor"] = mode if mode in ("rw", "ro", "off") else "rw"
    return user


DEVICE_IDLE_DAYS = 90          # a standalone copy that has not synced for this long must sign in again


async def device_user(token: Optional[str]) -> Optional[dict]:
    """The account behind a standalone copy's sync token (Authorization: Bearer, /api/sync/* only)."""
    if not token or len(token) > 100:
        return None
    db = await get_db()
    try:
        cur = await db.execute("""SELECT u.*, d.id AS device_id, d.last_seen AS d_seen FROM sync_devices d
                                  JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?""", (_token_hash(token),))
        row = await cur.fetchone()
        if not row or not row["active"]:
            return None
        cur = await db.execute("SELECT julianday('now') - julianday(COALESCE(?, created)) FROM sync_devices WHERE id = ?",
                               (row["d_seen"], row["device_id"]))
        if (await cur.fetchone())[0] > DEVICE_IDLE_DAYS:
            await db.execute("DELETE FROM sync_devices WHERE id = ?", (row["device_id"],))
            await db.commit()
            return None
        await db.execute("UPDATE sync_devices SET last_seen = CURRENT_TIMESTAMP WHERE id = ? "
                         "AND (last_seen IS NULL OR last_seen < datetime('now', '-5 minutes'))", (row["device_id"],))
        await db.commit()
        user = await full_user(db, row)
        user["device_id"] = row["device_id"]
        return user
    finally:
        await db.close()


async def end_session(token: Optional[str]):
    if not token:
        return
    db = await get_db()
    try:
        await db.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))
        await db.commit()
    finally:
        await db.close()


def public_user(row) -> dict:
    keys = ("id", "username", "source", "display_name", "email", "department", "role", "active", "last_login", "created_at",
            "must_change_password", "scope_departments", "manager_id", "manager_source")
    out = {k: row[k] for k in keys if k in row.keys()}
    if isinstance(out.get("scope_departments"), str):
        import json
        try:
            out["scope_departments"] = json.loads(out["scope_departments"])
        except ValueError:
            out["scope_departments"] = []
    return out


def set_cookie(response, request: Request, token: str):
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(COOKIE, token, httponly=True, samesite="lax", secure=secure, path="/",
                        max_age=int(sysconfig.security().session_max_days * 86400))


def client_ip(request: Request) -> str:
    return request.client.host if request.client else ""


# ------------------------------------------------------------- rate limiting
_fails = defaultdict(deque)          # key → timestamps of failed logins


def too_many(ip: str, username: str) -> bool:
    now = time.time()
    sec = sysconfig.security()
    window = max(1, int(sec.lock_minutes)) * 60
    for key, limit in ((f"ip:{ip}", int(sec.ip_attempts)), (f"user:{username}", int(sec.lock_attempts))):
        q = _fails[key]
        while q and now - q[0] > window:
            q.popleft()
        if len(q) >= limit:
            return True
    return False


def record_failure(ip: str, username: str):
    now = time.time()
    _fails[f"ip:{ip}"].append(now)
    _fails[f"user:{username}"].append(now)


def clear_failures(username: str):
    _fails.pop(f"user:{username}", None)


# ------------------------------------------------------------- dependencies
def current_user(request: Request) -> dict:
    user = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(status_code=401, detail="請先登入")
    return user


def require_admin(request: Request) -> dict:
    user = current_user(request)
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="需要管理員權限")
    return user


# --------------------------------------------------------------- middleware
async def gate(request: Request, call_next):
    """Attach request.state.user and enforce login / roles / CSRF header."""
    path = request.url.path
    method = request.method.upper()
    # Both editions: a cross-site page cannot add this header without a CORS preflight we never approve,
    # so no other website can change data here (not even on a standalone copy on 127.0.0.1).
    if path.startswith("/api/") and method not in SAFE_METHODS and request.headers.get("x-tool-table") != "1":
        return JSONResponse({"detail": "缺少 X-Tool-Table 標頭"}, status_code=403)
    if not C.AUTH:
        from . import syncclient                     # standalone copy linked to a server: work as that account
        request.state.user = syncclient.LOCAL_USER or ANON
        return await call_next(request)

    bearer = request.headers.get("authorization") or ""
    if path.startswith("/api/sync/") and bearer[:7].lower() == "bearer ":
        user = await device_user(bearer[7:].strip())
    else:
        user = await session_user(request.cookies.get(COOKIE))
    request.state.user = user
    public = path in PUBLIC_EXACT or path.startswith(PUBLIC_PREFIX)
    if user is None and not public:
        if path.startswith("/api/") or path.startswith("/openapi"):
            return JSONResponse({"detail": "請先登入"}, status_code=401)
        nxt = path + (("?" + request.url.query) if request.url.query else "")
        return RedirectResponse(f"/login?next={quote(nxt)}", status_code=303)

    if user is not None and user.get("must_change_password") and path.startswith("/api/") \
            and path not in ("/api/auth/me", "/api/auth/password", "/api/auth/logout", "/api/public/branding", "/api/settings"):
        return JSONResponse({"detail": "請先變更本機管理員的預設密碼"}, status_code=403)

    if user is not None and not is_admin(user):
        if path in ADMIN_PAGES:
            return RedirectResponse("/", status_code=303)
        if C.API_DOCS == "admin" and path in ("/docs", "/openapi.json"):   # API documentation: administrators
            return RedirectResponse("/", status_code=303) if path == "/docs" else JSONResponse({"detail": "需要管理員權限"}, status_code=403)
        if _starts(path, ADMIN_ANY_METHOD) or (method not in SAFE_METHODS and _starts(path, ADMIN_WRITE)):
            return JSONResponse({"detail": "需要管理員權限"}, status_code=403)
    return await call_next(request)
