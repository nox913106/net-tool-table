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
    "/api/health", "/api/auth/login", "/api/auth/status", "/api/public/dashboard", "/api/public/branding",
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
        return public_user(row)
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
            "must_change_password", "scope_departments")
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
        request.state.user = ANON
        return await call_next(request)

    user = await session_user(request.cookies.get(COOKIE))
    request.state.user = user
    public = path in PUBLIC_EXACT or path.startswith(PUBLIC_PREFIX)
    if user is None and not public:
        if path.startswith("/api/") or path.startswith("/docs") or path.startswith("/openapi"):
            return JSONResponse({"detail": "請先登入"}, status_code=401)
        nxt = path + (("?" + request.url.query) if request.url.query else "")
        return RedirectResponse(f"/login?next={quote(nxt)}", status_code=303)

    if user is not None and user.get("must_change_password") and path.startswith("/api/") \
            and path not in ("/api/auth/me", "/api/auth/password", "/api/auth/logout", "/api/public/branding", "/api/settings"):
        return JSONResponse({"detail": "請先變更本機管理員的預設密碼"}, status_code=403)

    if user is not None and not is_admin(user):
        if path in ADMIN_PAGES:
            return RedirectResponse("/", status_code=303)
        if _starts(path, ADMIN_ANY_METHOD) or (method not in SAFE_METHODS and _starts(path, ADMIN_WRITE)):
            return JSONResponse({"detail": "需要管理員權限"}, status_code=403)
    return await call_next(request)
