"""
Local programs & automatic icons

  GET  /api/local/status           is "local programs" available to this browser?
  POST /api/local/shortcut         upload a dropped .lnk / .url → parsed target + icon
  POST /api/local/resolve          {name, size} of a dropped .exe → its path on this PC + icon
  POST /api/local/inspect          {path} → name + icon (for a pasted path)
  POST /api/local/presence         a page is open / closing (the standalone copy stops with its window)
  POST /api/launch/{node_id}       start the program / open the file of a node
  POST /api/icons/fetch            {url} → fetch the website's icon into the library

All /api/local/* and /api/launch are restricted by localapps.require_local().
"""
import os
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from .. import localapps as la
from ..config import LOCAL_APPS
from ..database import get_db
from ..favicon import fetch_favicon as _fetch_favicon
from .settings import read_settings


async def fetch_favicon(url: str):
    """Fetch a site icon (in a worker thread) honouring the favicon_web_fallback setting."""
    db = await get_db()
    try:
        fallback = (await read_settings(db)).get("favicon_web_fallback", True)
    finally:
        await db.close()
    return await run_in_threadpool(_fetch_favicon, url, fallback)

router = APIRouter(prefix="/api", tags=["local"])

LAUNCHABLE_HINT = "請拖曳程式的捷徑（.lnk）、網址捷徑（.url）或執行檔（.exe）"


class PresenceIn(BaseModel):
    page: str = Field(..., min_length=4, max_length=40)
    bye: bool = False


@router.post("/local/presence")
async def presence(body: PresenceIn):
    """A page of the standalone copy is open (or closing): the copy stops when its last page is closed."""
    from .. import presence as pr
    pr.beat(body.page, body.bye)
    return {"watch": pr.ENABLED}


@router.get("/local/status")
async def local_status(request: Request):
    return {"enabled": LOCAL_APPS, "allowed": la.local_allowed(request)}


async def _describe(path: str, args: str = "", cwd: str = "", icon_path: str = "", icon_index: int = 0,
                    name: str = "") -> dict:
    icon = await run_in_threadpool(la.icon_from_file, icon_path or path, icon_index, name or Path(path).stem)
    if not icon and icon_path:
        icon = await run_in_threadpool(la.icon_from_file, path, 0, name or Path(path).stem)
    if not name:
        name = await run_in_threadpool(la.program_name, path)
    return {
        "kind": "app", "name": name, "url": la.path_to_url(path), "path": path,
        "args": args, "cwd": cwd, "icon": icon, "exists": os.path.exists(path),
    }


@router.post("/local/shortcut")
async def read_shortcut(request: Request, file: UploadFile = File(...)):
    la.require_local(request)
    data = await file.read(1024 * 1024 + 1)
    if len(data) > 1024 * 1024:
        raise HTTPException(status_code=413, detail="捷徑檔太大")
    name = Path(file.filename or "").stem
    ext = Path(file.filename or "").suffix.lower()
    try:
        if ext == ".url":
            info = la.parse_url_file(data)
            if not info["url"].lower().startswith(("http://", "https://")):
                raise HTTPException(status_code=400, detail="只支援 http / https 網址捷徑")
            icon = await fetch_favicon(info["url"])
            return {"kind": "url", "name": name, "url": info["url"], "icon": icon}
        if ext != ".lnk":
            raise HTTPException(status_code=400, detail=LAUNCHABLE_HINT)
        info = la.parse_lnk(data)
    except la.ShortcutError as e:
        raise HTTPException(status_code=400, detail=str(e))
    target = la.expand_env(info["target"])
    # an .lnk to a web page behaves like a URL shortcut
    if target.lower().startswith(("http://", "https://")):
        icon = await fetch_favicon(target)
        return {"kind": "url", "name": name, "url": target, "icon": icon}
    return await _describe(target, info["args"], info["cwd"], info["icon"], info["icon_index"], name)


class ResolveRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=260)
    size: int = Field(..., ge=0)


@router.post("/local/resolve")
async def resolve_file(request: Request, body: ResolveRequest):
    la.require_local(request)
    if Path(body.name).name != body.name:
        raise HTTPException(status_code=400, detail="無效的檔名")
    path = await run_in_threadpool(la.locate, body.name, body.size)
    if not path:
        return {"kind": "app", "found": False, "name": Path(body.name).stem}
    return {**(await _describe(path)), "found": True}


class InspectRequest(BaseModel):
    path: str = Field(..., min_length=1, max_length=1024)


@router.post("/local/inspect")
async def inspect_path(request: Request, body: InspectRequest):
    la.require_local(request)
    path = la.url_to_path(la.normalize_target(body.path)) if body.path.lower().startswith("file:") else la.expand_env(body.path.strip().strip('"'))
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"找不到：{path}")
    return await _describe(path)


@router.post("/launch/{node_id}")
async def launch_node(node_id: int, request: Request):
    la.require_local(request)
    db = await get_db()
    try:
        cursor = await db.execute("SELECT * FROM nodes WHERE id = ? AND is_active = TRUE", (node_id,))
        node = await cursor.fetchone()
    finally:
        await db.close()
    if not node or not la.is_file_url(node["url"]):
        raise HTTPException(status_code=404, detail="這個項目不是本機程式")
    keys = node.keys()
    await run_in_threadpool(la.launch, la.url_to_path(node["url"]),
                            node["launch_args"] if "launch_args" in keys else "",
                            node["launch_cwd"] if "launch_cwd" in keys else "")
    return {"success": True}


class FetchIconRequest(BaseModel):
    url: str = Field(..., min_length=8, max_length=2048)


@router.post("/icons/fetch")
async def fetch_icon(body: FetchIconRequest):
    if not body.url.lower().startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="只支援 http / https 網址")
    # 200 with icon=null when nothing usable was found (not an error for the caller)
    return {"icon": await fetch_favicon(body.url)}
