"""
Tool Table - FastAPI application
Serves the API and the static frontend (frontend/).
"""
import ipaddress
import socket
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .config import ENABLE_DOCS, ICON_DIR, PROJECT_ROOT
from .database import init_db
from .routes import auth_links, local, nodes, search, settings

FRONTEND_DIR = PROJECT_ROOT / "frontend"
VERSION = "3.0.0"


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(
    title="Tool Table API",
    version=VERSION,
    lifespan=lifespan,
    docs_url="/docs" if ENABLE_DOCS else None,
    redoc_url="/redoc" if ENABLE_DOCS else None,
    openapi_url="/openapi.json" if ENABLE_DOCS else None,
)

app.include_router(nodes.router)
app.include_router(auth_links.router)
app.include_router(search.router)
app.include_router(settings.router)
app.include_router(local.router)


@app.middleware("http")
async def harden_icons(request: Request, call_next):
    """Uploaded / fetched icons may be SVG: never let one run script if opened directly."""
    response = await call_next(request)
    if request.url.path.startswith("/resource/icon/"):
        response.headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
        response.headers["X-Content-Type-Options"] = "nosniff"
    return response

# --- Static ---
ICON_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/resource/icon", StaticFiles(directory=ICON_DIR), name="icons")
app.mount("/assets", StaticFiles(directory=FRONTEND_DIR / "assets"), name="assets")


@app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
async def serve_portal():
    return FileResponse(FRONTEND_DIR / "index.html")


@app.api_route("/admin", methods=["GET", "HEAD"], include_in_schema=False)
async def serve_admin():
    return FileResponse(FRONTEND_DIR / "admin.html")


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
    title = (s.get("site_title") or "Tool Table").strip()[:45]
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
        "theme_color": s.get("accent_color") or "#6366f1",
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
