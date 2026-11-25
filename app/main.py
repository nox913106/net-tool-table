"""
IPMS - FastAPI application
Serves the API and the static frontend (frontend/).
"""
import ipaddress
import json
import logging
import socket
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .config import ENABLE_DOCS, ICON_DIR, PROJECT_ROOT
from .database import init_db
from . import auth as auth_mod
from .routes import auth as auth_routes, auth_links, dashboard, local, nodes, search, settings, system, tasks
from .routes import sync as sync_routes

FRONTEND_DIR = PROJECT_ROOT / "frontend"
VERSION = "3.0.0"


async def _teams_loop():
    """Teams (server edition): send what is queued every few seconds; turn quiet cards' changes into digests."""
    import asyncio
    from . import teams
    teams.refresh_capture()
    n = 0
    while True:
        try:
            if n % 3 == 0:
                await teams.digest()
            await teams.flush()
        except Exception:
            logging.getLogger("tool_table").exception("teams")
        n += 1
        await asyncio.sleep(10)


async def _scheduler():
    """Background jobs that need no cron: the daily backup (settings in the admin UI), image cleanup,
    the daily project notifications."""
    import asyncio
    from . import backup
    from .database import DB_PATH
    from .routes.tasks import cleanup_images
    loop = asyncio.get_running_loop()
    tick = 0
    while True:
        try:
            await loop.run_in_executor(None, backup.run_scheduled)
        except Exception:
            pass
        try:                                    # daily project notifications (app/projects.py)
            from .projects import run_daily_if_due
            await run_daily_if_due()
        except Exception:
            pass
        from . import config as _C
        if _C.AUTH:                             # system / hardware checks and alerts (app/monitor.py)
            try:
                from .monitor import tick as monitor_tick
                await monitor_tick()
            except Exception:
                logging.getLogger("tool_table").exception("monitor")
        if tick % 60 == 7:                      # hourly: today's counts for the dashboard's trend lines
            try:
                from .routes.dashboard import snapshot
                from .database import get_db
                db = await get_db()
                try:
                    await snapshot(db, force=True)
                finally:
                    await db.close()
            except Exception:
                logging.getLogger("tool_table").exception("dashboard snapshot")
        if tick % 60 == 5:                      # hourly: unposted comment images, orphaned files
            try:
                await loop.run_in_executor(None, cleanup_images, DB_PATH)
            except Exception:
                pass
        tick += 1
        await asyncio.sleep(60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio
    await init_db()
    from .routes.tasks import rollup_all
    try:                                    # once, after the upgrade that introduced summary cards; since then a
        from .database import get_db       # status set by hand must survive restarts
        db = await get_db()
        try:
            cur = await db.execute("SELECT 1 FROM settings WHERE key = '_migr_rollup_v1'")
            done = await cur.fetchone()
            if not done:
                await db.execute("INSERT INTO settings (key, value) VALUES ('_migr_rollup_v1', '1')")
                await db.commit()
        finally:
            await db.close()
        if not done:
            await rollup_all()
    except Exception:                       # never block startup over this
        pass
    try:                                    # the new name: a site still called by the old default name follows it
        from .database import get_db
        db = await get_db()
        try:
            cur = await db.execute("SELECT key, value FROM settings WHERE key IN ('site_title', 'site_subtitle')")
            got = {k: v for k, v in await cur.fetchall()}
            if got.get("site_title") == json.dumps("Tool Table"):
                await db.execute("UPDATE settings SET value = ? WHERE key = 'site_title'", (json.dumps("IPMS"),))
                if got.get("site_subtitle") in (None, json.dumps("")):
                    await db.execute("DELETE FROM settings WHERE key = 'site_subtitle'")      # → the default subtitle
                await db.commit()
        finally:
            await db.close()
    except Exception:
        pass
    task = asyncio.create_task(_scheduler())
    from . import config as _C
    teams_task = asyncio.create_task(_teams_loop()) if _C.AUTH else None
    extra = []
    from . import config as C
    if not C.AUTH:                          # standalone copy: sync with a server once linked
        from . import syncclient
        extra = await syncclient.startup()
        from . import presence                # stop with the program's window
        extra.append(asyncio.create_task(presence.watch()))
    yield
    task.cancel()
    if teams_task:
        teams_task.cancel()
    for t in extra:
        t.cancel()


app = FastAPI(
    title="IPMS API",
    version=VERSION,
    lifespan=lifespan,
    docs_url=None,                          # our own Swagger UI page below (bundled, works offline and under the CSP)
    redoc_url=None,
    openapi_url="/openapi.json" if ENABLE_DOCS else None,
)
from . import apidocs                       # noqa: E402  Chinese summaries, groups, authentication
apidocs.install(app, VERSION)

app.include_router(nodes.router)
from .routes import profile as profile_routes  # noqa: E402
app.include_router(profile_routes.router)
app.include_router(nodes.my_router)
app.include_router(auth_links.router)
app.include_router(search.router)
app.include_router(settings.router)
app.include_router(local.router)
app.include_router(tasks.router)
app.include_router(tasks.notes_router)
app.include_router(auth_routes.router)
app.include_router(dashboard.router)
app.include_router(system.router)
app.include_router(sync_routes.router)


@app.middleware("http")
async def harden_icons(request: Request, call_next):
    """Uploaded / fetched icons may be SVG: never let one run script if opened directly.
    Pages and scripts are always revalidated, so after an upgrade the browser never mixes
    an old cached page with new scripts (a 304 makes this cheap)."""
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
        from . import sync
        sync.poke()                         # wake live viewers (/api/sync/wait) and the sync client
    if path in ("/", "/admin", "/login", "/dashboard", "/docs") or path.startswith("/assets/"):
        response.headers.setdefault("Cache-Control", "no-cache")
    if path.startswith("/resource/icon/"):
        response.headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
        response.headers["X-Content-Type-Options"] = "nosniff"
    return response

# Registered last = runs first: login / roles / CSRF header (app/auth.py)
app.middleware("http")(auth_mod.gate)
# … and before that: the request's language; English answers get the server's texts translated (app/i18n.py)
from . import i18n as i18n_mod          # noqa: E402
app.middleware("http")(i18n_mod.middleware)

# --- Static ---
ICON_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/resource/icon", StaticFiles(directory=ICON_DIR), name="icons")
app.mount("/assets", StaticFiles(directory=FRONTEND_DIR / "assets"), name="assets")


@app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
async def serve_portal():
    return FileResponse(FRONTEND_DIR / "index.html")


if ENABLE_DOCS:
    @app.api_route("/docs", methods=["GET", "HEAD"], include_in_schema=False)
    async def serve_api_docs():
        return FileResponse(FRONTEND_DIR / "apidocs.html")


@app.api_route("/link", methods=["GET", "HEAD"], include_in_schema=False)
async def serve_link():
    """Approve a standalone copy's link to my account (opened from the copy; sign-in required)."""
    return FileResponse(FRONTEND_DIR / "link.html")


@app.api_route("/admin", methods=["GET", "HEAD"], include_in_schema=False)
async def serve_admin():
    return FileResponse(FRONTEND_DIR / "admin.html")


@app.api_route("/login", methods=["GET", "HEAD"], include_in_schema=False)
async def serve_login():
    return FileResponse(FRONTEND_DIR / "login.html")


@app.api_route("/dashboard", methods=["GET", "HEAD"], include_in_schema=False)
async def serve_dashboard():
    return FileResponse(FRONTEND_DIR / "dashboard.html")


@app.get("/api/public/branding", include_in_schema=False)
async def branding():
    """What the login and dashboard pages need before anyone signs in."""
    from .database import get_db
    from .routes.settings import read_settings
    db = await get_db()
    try:
        s = await read_settings(db)
    finally:
        await db.close()
    keys = ("site_title", "site_subtitle", "favicon", "theme", "language", "accent_color", "background", "density", "public_dashboard",
            "dashboard_rotate_seconds")
    return {k: s.get(k) for k in keys}


# --- Install as an app (Chrome / Edge "Install", Android "Add to home screen") ---
@app.api_route("/manifest.webmanifest", methods=["GET", "HEAD"], include_in_schema=False)
async def web_manifest():
    from .database import get_db
    from .routes.settings import read_settings
    db = await get_db()
    try:
        s = await read_settings(db)
    finally:
        await db.close()
    title = (s.get("site_title") or "IPMS").strip()[:45]
    icon = "/assets/app/"
    return JSONResponse({
        "id": "/",
        "name": title,
        "short_name": title[:12],
        "description": (s.get("site_subtitle") or "常用工具與系統入口")[:120],
        "lang": "zh-Hant-TW",
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "background_color": "#0a0d1a",
        "theme_color": s.get("accent_color") or "#0B0E11",
        "icons": [
            {"src": icon + "icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": icon + "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": icon + "icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
        "shortcuts": [
            {"name": "搜尋", "url": "/#search", "icons": [{"src": icon + "icon-192.png", "sizes": "192x192"}]},
            {"name": "管理後台", "url": "/admin", "icons": [{"src": icon + "icon-192.png", "sizes": "192x192"}]},
        ],
    }, media_type="application/manifest+json", headers={"Cache-Control": "no-cache"})


@app.api_route("/sw.js", methods=["GET", "HEAD"], include_in_schema=False)
async def service_worker():
    # served from the root so it controls the whole site
    return FileResponse(FRONTEND_DIR / "sw.js", media_type="text/javascript",
                        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})


@app.api_route("/favicon.ico", methods=["GET", "HEAD"], include_in_schema=False)
async def favicon():
    return FileResponse(FRONTEND_DIR / "assets" / "app" / "favicon-32.png", media_type="image/png")


@app.get("/admin.html", include_in_schema=False)
async def legacy_admin():
    return RedirectResponse("/admin", status_code=301)


# --- Small system endpoints ---
@app.get("/api/health")
async def health_check():
    return {"status": "ok", "version": VERSION}


@app.get("/api/time")
async def server_time():
    """Server clock (ms since epoch) so the header clock needs no third-party service."""
    return {"now": int(time.time() * 1000)}


@app.get("/api/whoami")
async def whoami(request: Request):
    """The viewer's IP as seen by this server (behind nginx: from X-Forwarded-For).

    When the browser runs on this same machine (portable version, or opened on the
    server itself) the connection is loopback, so report this computer's own LAN
    address and name instead of 127.0.0.1."""
    ip = request.client.host if request.client else None
    if ip and _is_loopback(ip):
        return {"ip": _primary_ip() or ip, "local": True, "host": socket.gethostname(), "all": _all_ips()}
    return {"ip": ip, "local": False}


def _is_loopback(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip.split("%")[0]).is_loopback
    except ValueError:
        return ip == "localhost"


def _primary_ip() -> str:
    """Address of the interface used for outbound traffic (a UDP connect sends no packets)."""
    for family, target in ((socket.AF_INET, "192.0.2.1"), (socket.AF_INET6, "2001:db8::1")):
        try:
            with socket.socket(family, socket.SOCK_DGRAM) as s:
                s.connect((target, 9))
                addr = s.getsockname()[0]
                if not ipaddress.ip_address(addr).is_loopback:
                    return addr
        except OSError:
            continue
    return ""


def _all_ips() -> list:
    """Every non-loopback IPv4 address of this computer (several NICs / VPN)."""
    found = []
    try:
        for ai in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            a = ai[4][0]
            if a not in found and not a.startswith(("127.", "169.254.")):
                found.append(a)
    except OSError:
        pass
    primary = _primary_ip()
    if primary and primary not in found:
        found.insert(0, primary)
    return found
