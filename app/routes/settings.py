"""
Site Settings & Data Portability Routes
Everything that used to be hard-coded in the frontend (titles, sections,
filters, widgets, colors) lives here so the portal can be reused for any purpose.
"""
import json
import re
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import config as C
from ..database import get_db
from ..localapps import is_file_url, local_allowed
from ..models import unsafe_url
from .tasks import export_tasks, import_tasks

router = APIRouter(prefix="/api", tags=["settings"])

# Default values: also documents every supported setting key.
DEFAULT_SETTINGS: Dict[str, Any] = {
    # --- Branding ---
    "site_title": "Tool Table",
    "site_subtitle": "",
    "favicon": "",                      # icon file name or an emoji

    # --- Appearance ---
    "theme": "auto",                    # auto | dark | light (viewer can still toggle)
    "accent_color": "#6366f1",
    "background": "aurora",             # aurora | gradient | plain
    "density": "comfortable",           # comfortable | compact
    "default_view": "grid",             # grid | list (viewer can still toggle)

    # --- Header ---
    "show_clock": True,
    "clock_style": "flip",              # flip | simple
    "clock_show_seconds": True,
    "show_client_ip": False,            # viewer's IP as seen by this server
    "show_public_ip": False,            # public IP / city via ipinfo.io (browser → ipinfo.io)
    "show_admin_button": False,         # otherwise: click the logo or clock 5 times

    # --- Navigation ---
    "search_placeholder": "搜尋…",
    "sidebar_show_links": False,
    "sidebar_default": "expanded",      # expanded | collapsed (icon rail); each viewer's toggle is remembered
    "sidebar_hover_expand": True,       # collapsed rail opens while the pointer is over it
    "sidebar_show_icons": True,
    "sidebar_show_counts": True,
    "show_quick_filters": True,
    "quick_filters_title": "快速篩選",
    "quick_filters": [],                # [{"label": "...", "icon": "x.png"}]; empty = auto
    "quick_filters_auto_limit": 8,

    # --- Home page (ordered sections) ---
    # type: message | quick_links | favorites | recent | roots | folder | board
    # optional: title, node_id (folder), style (grid | compact), limit
    "home_sections": [
        {"type": "message"},
        {"type": "quick_links"},
        {"type": "board"},
        {"type": "favorites"},
        {"type": "recent"},
        {"type": "roots"},
    ],
    "home_message": "",
    "quick_links_title": "快速連結",
    "quick_links_icon": "⚡",
    "quick_links_group_label": "群組",

    # --- Cards ---
    "show_descriptions": True,
    "show_link_host": True,             # show the link's domain under its name
    "open_links_in_new_tab": True,      # default for links without their own setting
    "enable_favorites": True,           # ☆ on cards (stored per browser)
    "enable_recent": True,              # recently opened (stored per browser)
    "allow_drop_add": True,             # drag a web link onto the portal to add it
    "favicon_web_fallback": True,       # public sites: use a favicon service when the site blocks direct fetches

    # --- Task board ---
    "board_enabled": True,              # sidebar entry, header reminder bell
    "board_notify": True,               # desktop notifications for reminders (viewer must allow)
    "board_due_soon_days": 2,           # cards due within N days are highlighted
    "board_overdue_remind_time": "09:30",  # daily reminder for one-off cards past due (viewer's local time)
    "public_dashboard": True,           # /dashboard: per department / account status counts, no login
    "board_supervisor": "rw",           # 上級 on cards of everyone below them: rw = full rights, ro = view + comment, off = none
    "board_wip_high": 6,                # a column with this many open cards shows 高負荷 (default: ≤5 normal, 6–8 high)
    "board_wip_over": 9,                # … and from this many 超量
}

ENUMS = {
    "theme": {"auto", "dark", "light"},
    "background": {"aurora", "gradient", "plain"},
    "density": {"comfortable", "compact"},
    "default_view": {"grid", "list"},
    "clock_style": {"flip", "simple"},
    "sidebar_default": {"expanded", "collapsed"},
    "board_supervisor": {"rw", "ro", "off"},
}
SECTION_TYPES = {"message", "quick_links", "favorites", "recent", "roots", "folder", "board"}


class SettingsUpdate(BaseModel):
    values: Dict[str, Any]


def validate_setting(key: str, value: Any) -> Any:
    if key not in DEFAULT_SETTINGS:
        raise HTTPException(status_code=400, detail=f"未知的設定項目: {key}")
    default = DEFAULT_SETTINGS[key]
    if key in ENUMS and value not in ENUMS[key]:
        raise HTTPException(status_code=400, detail=f"{key} 的值無效：{value}")
    if key == "board_overdue_remind_time" and not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", str(value)):
        raise HTTPException(status_code=400, detail="每日提醒時間格式為 HH:MM，例如 09:30")
    if key in ("board_wip_high", "board_wip_over"):
        try:
            n = int(value)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="工作量門檻必須是數字")
        if not 1 <= n <= 999:
            raise HTTPException(status_code=400, detail="工作量門檻要在 1～999 之間")
        return n
    if key == "accent_color" and not re.fullmatch(r"#[0-9a-fA-F]{6}", str(value)):
        raise HTTPException(status_code=400, detail="主題色必須是 #RRGGBB")
    if isinstance(default, bool):
        return bool(value)
    if isinstance(default, int):
        try:
            return int(value)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"{key} 必須是數字")
    if isinstance(default, str):
        return "" if value is None else str(value)
    if key == "home_sections":
        if not isinstance(value, list):
            raise HTTPException(status_code=400, detail="home_sections 必須是陣列")
        clean = []
        for sec in value:
            if not isinstance(sec, dict) or sec.get("type") not in SECTION_TYPES:
                continue
            item = {"type": sec["type"]}
            if sec.get("title"):
                item["title"] = str(sec["title"])[:100]
            if sec["type"] == "folder":
                if not isinstance(sec.get("node_id"), int):
                    continue
                item["node_id"] = sec["node_id"]
            if sec.get("style") in ("grid", "compact"):
                item["style"] = sec["style"]
            if sec["type"] == "board" and isinstance(sec.get("hide_closed"), bool):
                item["hide_closed"] = sec["hide_closed"]
            if isinstance(sec.get("limit"), int) and sec["limit"] > 0:
                item["limit"] = sec["limit"]
            clean.append(item)
        return clean
    if key == "quick_filters":
        if not isinstance(value, list):
            raise HTTPException(status_code=400, detail="quick_filters 必須是陣列")
        return [
            {"label": str(f.get("label") or ""), "icon": str(f["icon"])}
            for f in value if isinstance(f, dict) and f.get("icon")
        ]
    return value


async def read_settings(db) -> Dict[str, Any]:
    cursor = await db.execute("SELECT key, value FROM settings")
    merged = dict(DEFAULT_SETTINGS)
    for row in await cursor.fetchall():
        if row["key"] not in DEFAULT_SETTINGS:
            continue  # obsolete key from an older version
        try:
            merged[row["key"]] = json.loads(row["value"])
        except (TypeError, ValueError):
            pass
    return merged


async def write_settings(db, values: Dict[str, Any]):
    for key, value in values.items():
        value = validate_setting(key, value)
        await db.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value, ensure_ascii=False)),
        )


@router.get("/settings")
async def get_settings():
    db = await get_db()
    try:
        return await read_settings(db)
    finally:
        await db.close()


@router.get("/settings/defaults")
async def get_default_settings():
    return DEFAULT_SETTINGS


@router.put("/settings")
async def update_settings(update: SettingsUpdate):
    db = await get_db()
    try:
        await write_settings(db, update.values)
        await db.commit()
        return await read_settings(db)
    finally:
        await db.close()


@router.post("/settings/reset")
async def reset_settings():
    db = await get_db()
    try:
        await db.execute("DELETE FROM settings")
        await db.commit()
        return DEFAULT_SETTINGS
    finally:
        await db.close()


# ============ Export / Import ============

NODE_FIELDS = ["name", "node_type", "icon", "url", "description", "color", "launch_args", "launch_cwd",
               "new_tab", "sort_order", "is_active"]
LINK_FIELDS = ["region", "name", "url", "sort_order", "is_active"]


async def export_subtree(db, parent_id: Optional[int]) -> List[dict]:
    if parent_id is None:
        # the server's backup / export covers the public area (personal areas belong to each account)
        public = " AND owner_id IS NULL" if C.AUTH else ""
        cursor = await db.execute(f"SELECT * FROM nodes WHERE parent_id IS NULL{public} ORDER BY sort_order, id")
    else:
        cursor = await db.execute(
            "SELECT * FROM nodes WHERE parent_id = ? ORDER BY sort_order, id", (parent_id,)
        )
    result = []
    for row in await cursor.fetchall():
        item = {k: row[k] for k in NODE_FIELDS if k in row.keys()}
        item["ref"] = row["id"]   # original id; lets import remap references (home sections)
        item["icon"] = item.get("icon") or None
        item["color"] = item.get("color") or None
        item["is_active"] = bool(item.get("is_active", True))
        item["new_tab"] = bool(item.get("new_tab", True)) if item.get("new_tab") is not None else True
        # Export children of any node (legacy data may have links with children)
        children = await export_subtree(db, row["id"])
        if row["node_type"] == "folder" or children:
            item["children"] = children
        result.append(item)
    return result


@router.get("/export")
async def export_all():
    """Export settings, node tree and quick links as one JSON document"""
    db = await get_db()
    try:
        cursor = await db.execute("SELECT * FROM auth_links ORDER BY region, sort_order, id")
        links = [
            {k: (bool(row[k]) if k == "is_active" else row[k]) for k in LINK_FIELDS}
            for row in await cursor.fetchall()
        ]
        cursor = await db.execute("SELECT key FROM settings")
        stored_keys = {row["key"] for row in await cursor.fetchall()}
        settings = await read_settings(db)
        return {
            "format": "tool-table",
            "version": 1,
            "exported_at": datetime.now().isoformat(timespec="seconds"),
            # Only customised settings, so defaults can evolve
            "settings": {k: v for k, v in settings.items() if k in stored_keys},
            "nodes": await export_subtree(db, None),
            "quick_links": links,
            "tasks": await export_tasks(db),
        }
    finally:
        await db.close()


class ImportPayload(BaseModel):
    data: Dict[str, Any]
    replace: bool = True  # True: wipe nodes/links first; False: append


async def import_subtree(db, items: List[dict], parent_id: Optional[int], parent_code: Optional[str],
                         id_map: Optional[Dict[int, int]] = None, allow_local: bool = False):
    # Continue numbering after any existing siblings (append mode)
    if parent_id is None:
        cursor = await db.execute("SELECT code FROM nodes WHERE parent_id IS NULL")
    else:
        cursor = await db.execute("SELECT code FROM nodes WHERE parent_id = ?", (parent_id,))
    used = set()
    for row in await cursor.fetchall():
        try:
            used.add(int(str(row["code"]).split("-")[-1]))
        except ValueError:
            pass
    n = 0
    for item in items:
        if not isinstance(item, dict) or not item.get("name"):
            continue
        node_type = item.get("node_type") or ("folder" if "children" in item else "link")
        if node_type == "link" and unsafe_url(item.get("url")):
            continue  # refuse javascript:/data: links
        if node_type == "link" and is_file_url(item.get("url")) and not allow_local:
            continue  # program links may only be imported on the PC running the portable edition
        if node_type not in ("folder", "link"):
            raise HTTPException(status_code=400, detail=f"無效的類型: {node_type}")
        n += 1
        while n in used:
            n += 1
        code = f"{parent_code}-{n}" if parent_code else str(n)
        cursor = await db.execute(
            """INSERT INTO nodes (parent_id, code, name, node_type, icon, url, description,
                                  color, launch_args, launch_cwd, new_tab, sort_order, is_active)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                parent_id, code, item["name"], node_type, item.get("icon") or None,
                item.get("url") if node_type == "link" else None,
                item.get("description") or None,
                item.get("color") if isinstance(item.get("color"), str) and len(item["color"]) == 7 else None,
                (item.get("launch_args") or None) if node_type == "link" else None,
                (item.get("launch_cwd") or None) if node_type == "link" else None,
                bool(item.get("new_tab", True)),
                int(item.get("sort_order", n - 1) or 0),
                bool(item.get("is_active", True)),
            ),
        )
        if id_map is not None and isinstance(item.get("ref"), int):
            id_map[item["ref"]] = cursor.lastrowid
        if item.get("children"):
            await import_subtree(db, item["children"], cursor.lastrowid, code, id_map, allow_local)


@router.post("/import")
async def import_all(payload: ImportPayload, request: Request):
    data = payload.data
    if not isinstance(data.get("nodes", []), list) or not isinstance(data.get("quick_links", []), list):
        raise HTTPException(status_code=400, detail="檔案格式錯誤")
    db = await get_db()
    try:
        if payload.replace:
            await db.execute("DELETE FROM nodes" + (" WHERE owner_id IS NULL" if C.AUTH else ""))
            await db.execute("DELETE FROM auth_links")
            await db.execute("DELETE FROM settings")
            if isinstance(data.get("tasks"), list):     # older backups have no tasks: keep the board
                await db.execute("DELETE FROM tasks")
        id_map: Dict[int, int] = {}
        await import_subtree(db, data.get("nodes", []), None, None, id_map,
                             allow_local=local_allowed(request) and request.headers.get("x-tool-table") == "1")
        if isinstance(data.get("settings"), dict):
            incoming = {k: v for k, v in data["settings"].items() if k in DEFAULT_SETTINGS}
            if isinstance(incoming.get("home_sections"), list):
                remapped = []
                for sec in incoming["home_sections"]:
                    if isinstance(sec, dict) and sec.get("type") == "folder":
                        if sec.get("node_id") not in id_map:
                            continue  # folder not in this file
                        sec = {**sec, "node_id": id_map[sec["node_id"]]}
                    remapped.append(sec)
                incoming["home_sections"] = remapped
            await write_settings(db, incoming)
        tasks = await import_tasks(db, data.get("tasks"))
        for i, link in enumerate(data.get("quick_links", [])):
            if not link.get("name") or not link.get("url") or unsafe_url(link["url"]):
                continue
            await db.execute(
                "INSERT INTO auth_links (region, name, url, sort_order, is_active) VALUES (?, ?, ?, ?, ?)",
                (link.get("region") or "", link["name"], link["url"],
                 int(link.get("sort_order", i) or 0), bool(link.get("is_active", True))),
            )
        await db.commit()
        cursor = await db.execute("SELECT COUNT(*) AS c FROM nodes")
        nodes = (await cursor.fetchone())["c"]
        cursor = await db.execute("SELECT COUNT(*) AS c FROM auth_links")
        links = (await cursor.fetchone())["c"]
        return {"success": True, "nodes": nodes, "quick_links": links, "tasks": tasks}
    except Exception:
        await db.rollback()
        raise
    finally:
        await db.close()
