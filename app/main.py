"""
Tool Table - FastAPI application
Serves the API and the static frontend (frontend/).
"""
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, RedirectResponse
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
    """The viewer's IP as seen by this server (behind nginx: from X-Forwarded-For)."""
    return {"ip": request.client.host if request.client else None}
