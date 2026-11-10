"""
OpenProject endpoints for the board (any signed-in user; admin settings live in routes/system.py).

  GET  /api/openproject              is sync on? + projects to pick from (cached a few minutes)
  POST /api/tasks/{id}/openproject/sync   push this card now (people who may edit it)
"""
import asyncio
import time

from fastapi import APIRouter, HTTPException, Request

from .. import openproject as op
from ..auth import current_user
from ..database import get_db
from .tasks import _get_visible, _require_edit

router = APIRouter(tags=["openproject"])
_projects = {"at": 0.0, "list": [], "error": None}


def _load_projects():
    cfg = op.configured()
    if not cfg:
        return [], None
    try:
        return [{"id": str(p["id"]), "name": p.get("name"), "identifier": p.get("identifier")}
                for p in op.Client(cfg).elements("/api/v3/projects") if p.get("active", True)], None
    except op.OPError as e:
        return [], str(e)


@router.get("/api/openproject")
async def info(request: Request, refresh: bool = False):
    current_user(request)
    cfg = op.configured()
    if not cfg:
        return {"enabled": False, "projects": []}
    if refresh or time.time() - _projects["at"] > 300 or _projects["error"]:
        _projects["list"], _projects["error"] = await asyncio.get_running_loop().run_in_executor(None, _load_projects)
        _projects["at"] = time.time()
    return {"enabled": True, "url": cfg.url.rstrip("/"), "default_project": cfg.default_project,
            "projects": _projects["list"], "error": _projects["error"]}


@router.post("/api/tasks/{task_id}/openproject/sync")
async def sync_card(task_id: int, request: Request):
    user = current_user(request)
    db = await get_db()
    try:
        t = await _get_visible(db, task_id, user)
        await _require_edit(db, task_id, user)
    finally:
        await db.close()
    if not t.get("op_project"):
        raise HTTPException(status_code=400, detail="這張卡片沒有設定 OpenProject 專案")
    try:
        return await asyncio.get_running_loop().run_in_executor(None, op.sync_now, task_id)
    except op.OPError as e:
        raise HTTPException(status_code=502, detail=str(e))
