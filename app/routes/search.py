"""
Search API Routes
Global search across nodes
"""
from pathlib import Path
from typing import List

from fastapi import APIRouter, UploadFile, File, HTTPException, Request

from ..config import ALLOWED_ICON_EXTENSIONS, ICON_DIR, MAX_ICON_BYTES

from ..database import get_db
from ..models import SearchResult

router = APIRouter(prefix="/api", tags=["search"])

async def get_node_path(db, node_id: int) -> str:
    """Get full path of a node"""
    path_parts = []
    current_id = node_id
    
    while current_id:
        cursor = await db.execute(
            "SELECT id, parent_id, name FROM nodes WHERE id = ?", (current_id,)
        )
        row = await cursor.fetchone()
        if row:
            path_parts.insert(0, row['name'])
            current_id = row['parent_id']
        else:
            break
    
    return " > ".join(path_parts)

@router.get("/search")
async def search_nodes(q: str, request: Request, limit: int = 50):
    """Search nodes by name"""
    if not q or len(q) < 1:
        return []
    
    db = await get_db()
    try:
        cursor = await db.execute(
            """SELECT * FROM nodes 
               WHERE name LIKE ? AND is_active = TRUE AND (owner_id IS NULL OR owner_id IS ?)
               ORDER BY node_type DESC, name 
               LIMIT ?""",
            (f"%{q}%", (getattr(request.state, "user", None) or {}).get("id"), limit)
        )
        rows = await cursor.fetchall()
        from .. import node_access as acc
        hidden = await acc.hidden_ids(db, getattr(request.state, "user", None))

        results = []
        for row in rows:
            if row["id"] in hidden:
                continue
            node = dict(row)
            node.pop("visible_to", None)
            node['path'] = await get_node_path(db, node['id'])
            results.append(node)
        
        return results
    finally:
        await db.close()

def safe_icon_path(name: str) -> Path:
    """Resolve an icon filename inside ICON_DIR, rejecting anything path-like."""
    name = (name or "").strip()
    if (
        not name
        or name != Path(name).name          # no directory components
        or name.startswith(".")             # no hidden files / "." / ".."
        or "\\" in name
        or len(name) > 128
    ):
        raise HTTPException(status_code=400, detail="無效的檔名")
    if Path(name).suffix.lower() not in ALLOWED_ICON_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"不支援的檔案類型，允許：{', '.join(sorted(ALLOWED_ICON_EXTENSIONS))}",
        )
    path = (ICON_DIR / name).resolve()
    if path.parent != ICON_DIR.resolve():
        raise HTTPException(status_code=400, detail="無效的檔名")
    return path


@router.get("/icons")
async def get_icons():
    """Get list of available icons with metadata"""
    icons = []
    if ICON_DIR.exists():
        for f in ICON_DIR.iterdir():
            if f.is_file() and f.suffix.lower() in ALLOWED_ICON_EXTENSIONS:
                stat = f.stat()
                icons.append({"name": f.name, "size": stat.st_size, "modified": stat.st_mtime})
    return sorted(icons, key=lambda x: x["name"])


@router.post("/icons")
async def upload_icon(file: UploadFile = File(...)):
    """Upload a new icon (replaces an existing icon with the same name)"""
    dest = safe_icon_path(file.filename)
    data = await file.read(MAX_ICON_BYTES + 1)
    if len(data) > MAX_ICON_BYTES:
        raise HTTPException(status_code=413, detail="檔案太大（上限 5 MB）")
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return {"message": "Icon uploaded", "filename": dest.name}


@router.delete("/icons/{filename}")
async def delete_icon(filename: str):
    """Delete an icon"""
    icon_path = safe_icon_path(filename)
    if not icon_path.exists():
        raise HTTPException(status_code=404, detail="Icon not found")

    db = await get_db()
    try:
        cursor = await db.execute("SELECT COUNT(*) as count FROM nodes WHERE icon = ?", (filename,))
        row = await cursor.fetchone()
        if row["count"] > 0:
            raise HTTPException(status_code=400, detail=f"圖示正被 {row['count']} 個項目使用，無法刪除")
    finally:
        await db.close()

    icon_path.unlink()
    return {"message": "Icon deleted", "filename": filename}


@router.put("/icons/{filename}")
async def rename_icon(filename: str, new_name: str):
    """Rename an icon and update every reference to it"""
    old_path = safe_icon_path(filename)
    new_path = safe_icon_path(new_name)

    if not old_path.exists():
        raise HTTPException(status_code=404, detail="Icon not found")
    if new_path.exists():
        raise HTTPException(status_code=400, detail="已有相同檔名的圖示")

    old_path.rename(new_path)

    db = await get_db()
    try:
        await db.execute("UPDATE nodes SET icon = ? WHERE icon = ?", (new_path.name, filename))
        await db.commit()
    finally:
        await db.close()

    return {"message": "Icon renamed", "old_name": filename, "new_name": new_path.name}
