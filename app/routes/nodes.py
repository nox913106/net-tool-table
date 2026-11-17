"""
Nodes API Routes
CRUD operations for hierarchical nodes (categories and links)
"""
from fastapi import APIRouter, HTTPException, Depends, Request
from typing import List, Optional
import aiosqlite

from .. import config as C
from .. import localapps as la
from ..database import get_db
from ..models import (
    NodeCreate, NodeUpdate, NodeMove, NodeResponse, 
    NodeTreeItem, NodeReorder, APIResponse
)

router = APIRouter(prefix="/api/nodes", tags=["nodes"])
my_router = APIRouter(prefix="/api/my/nodes", tags=["nodes"])

# ============ Public area / personal area ============
# owner_id NULL = 公用區 (public area: administrators on the server); owner_id = an account =
# that person's 個人區 (personal area: only they see and edit it). A standalone copy linked to a
# server keeps its own links in its owner's personal area; the public area comes from the server.

def _viewer(request: Request):
    user = getattr(request.state, "user", None) or {}
    return user.get("id")


def _area(request: Request):
    """Whose links /api/nodes manages: None = the public area. On a linked standalone copy the
    local links are the owner's personal area (the public area is the server's, read-only here)."""
    if C.AUTH:
        return None
    from .. import syncclient
    u = syncclient.LOCAL_USER
    return u["id"] if u else None


async def _owned(db, node_id: int, owner):
    cursor = await db.execute("SELECT * FROM nodes WHERE id = ?", (node_id,))
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Node not found")
    if row["owner_id"] != owner:
        if row["owner_id"] is None:
            raise HTTPException(status_code=403, detail="公用區由伺服器的管理員維護，這裡不能修改" if not C.AUTH
                                else "公用區只有管理員可以修改")
        raise HTTPException(status_code=404, detail="Node not found")
    return row

# ============ Helper Functions ============

async def generate_code(db, parent_id: Optional[int]) -> str:
    """Generate next available code based on parent (finds first unused slot)"""
    if parent_id is None:
        cursor = await db.execute(
            "SELECT code FROM nodes WHERE parent_id IS NULL"
        )
        rows = await cursor.fetchall()
        existing = set()
        for row in rows:
            try:
                existing.add(int(row['code']))
            except ValueError:
                pass
        n = 1
        while n in existing:
            n += 1
        return str(n)
    else:
        cursor = await db.execute("SELECT code FROM nodes WHERE id = ?", (parent_id,))
        parent = await cursor.fetchone()
        if not parent:
            raise HTTPException(status_code=404, detail="Parent not found")

        parent_code = parent['code']
        cursor = await db.execute(
            "SELECT code FROM nodes WHERE parent_id = ?", (parent_id,)
        )
        rows = await cursor.fetchall()
        existing = set()
        for row in rows:
            try:
                existing.add(int(row['code'].split('-')[-1]))
            except ValueError:
                pass
        n = 1
        while n in existing:
            n += 1
        return f"{parent_code}-{n}"

async def build_tree(db, include_inactive: bool = False, viewer=None, public_only: bool = False, area=None) -> List[dict]:
    """Whole tree in one query: the public area plus the viewer's own personal area.
    Inactive nodes (and their subtrees) are skipped unless include_inactive is set (admin view).
    personal: in someone's personal area; readonly: not editable through /api/nodes here."""
    where = ["(owner_id IS NULL" + ("" if public_only else " OR owner_id = ?") + ")"]
    args = [] if public_only else [viewer]
    if not include_inactive:
        where.append("is_active = TRUE")
    cursor = await db.execute(f"SELECT * FROM nodes WHERE {' AND '.join(where)} ORDER BY sort_order, id", args)
    rows = [dict(r) for r in await cursor.fetchall()]
    for r in rows:
        r["personal"] = r["owner_id"] is not None
        r["readonly"] = r["owner_id"] != area
        r.pop("uid", None)
    by_id = {r["id"]: r for r in rows}
    roots: List[dict] = []
    for r in rows:
        r["children"] = []
    for r in rows:
        parent = r["parent_id"]
        if parent is None:
            roots.append(r)
        elif parent in by_id:
            by_id[parent]["children"].append(r)
        # parent inactive/missing → hidden with it
    return roots

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

# ============ CRUD Routes ============

@router.get("", response_model=List[NodeResponse])
async def get_root_nodes(request: Request):
    """Get all root nodes"""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM nodes WHERE parent_id IS NULL AND is_active = TRUE AND (owner_id IS NULL OR owner_id IS ?) ORDER BY sort_order, code",
            (_viewer(request),)
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]
    finally:
        await db.close()

@router.get("/tree")
async def get_full_tree(request: Request, include_inactive: bool = False):
    """Public area + my personal area (?include_inactive=true: the admin view — on the server the
    public area only, which is what the admin panel manages)"""
    db = await get_db()
    try:
        return await build_tree(db, include_inactive, _viewer(request), public_only=C.AUTH and include_inactive,
                                area=_area(request))
    finally:
        await db.close()

@router.get("/{node_id}", response_model=NodeResponse)
async def get_node(node_id: int, request: Request):
    """Get single node by ID"""
    db = await get_db()
    try:
        cursor = await db.execute("SELECT * FROM nodes WHERE id = ? AND (owner_id IS NULL OR owner_id IS ?)", (node_id, _viewer(request)))
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Node not found")
        return dict(row)
    finally:
        await db.close()

@router.get("/{node_id}/children", response_model=List[NodeResponse])
async def get_children(node_id: int, request: Request):
    """Get children of a node"""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM nodes WHERE parent_id = ? AND is_active = TRUE AND (owner_id IS NULL OR owner_id IS ?) ORDER BY sort_order, code",
            (node_id, _viewer(request))
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]
    finally:
        await db.close()

@router.get("/code/{code}")
async def get_by_code(code: str, request: Request):
    """Get node by code (e.g., 3-2-1)"""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM nodes WHERE code = ? AND is_active = TRUE AND (owner_id IS NULL OR owner_id IS ?)", (code, _viewer(request))
        )
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Node not found")
        
        # Also get children
        node = dict(row)
        cursor = await db.execute(
            "SELECT * FROM nodes WHERE parent_id = ? AND is_active = TRUE ORDER BY sort_order, code",
            (node['id'],)
        )
        children = await cursor.fetchall()
        node['items'] = [dict(child) for child in children]
        return node
    finally:
        await db.close()

@router.post("", response_model=NodeResponse)
async def create_node(node: NodeCreate, request: Request):
    """Create a new node"""
    return await _create(node, request, _area(request))


async def _create(node: NodeCreate, request: Request, owner):
    db = await get_db()
    try:
        # Validate link type requires URL
        if node.node_type == 'link' and not node.url:
            raise HTTPException(status_code=400, detail="Link type requires URL")
        if node.url:
            node.url = la.normalize_target(node.url)
            if la.is_file_url(node.url):
                la.require_local(request)   # only the PC running the portable edition may add programs
        if node.parent_id is not None:
            parent = await _owned(db, node.parent_id, owner)
            if parent['node_type'] != 'folder':
                raise HTTPException(status_code=400, detail="只能在資料夾底下新增項目")
        
        # Retry logic for code generation conflicts
        max_retries = 5
        for attempt in range(max_retries):
            try:
                # Generate code if not provided
                code = node.code or await generate_code(db, node.parent_id)
                if node.sort_order == 0:
                    cursor = await db.execute(
                        "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM nodes WHERE parent_id IS ?",
                        (node.parent_id,),
                    )
                    node.sort_order = (await cursor.fetchone())[0]
                
                cursor = await db.execute(
                    """INSERT INTO nodes (parent_id, code, name, node_type, icon, url,
                                          description, color, launch_args, launch_cwd,
                                          new_tab, sort_order, is_active, owner_id)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (node.parent_id, code, node.name, node.node_type,
                     node.icon, node.url, node.description, node.color or None,
                     node.launch_args or None, node.launch_cwd or None,
                     node.new_tab, node.sort_order, node.is_active, owner)
                )
                await db.commit()
                
                # Return created node
                cursor = await db.execute("SELECT * FROM nodes WHERE id = ?", (cursor.lastrowid,))
                row = await cursor.fetchone()
                return dict(row)
            except Exception as e:
                if "UNIQUE constraint" in str(e) and attempt < max_retries - 1:
                    # Code conflict, increment and retry
                    await db.rollback()
                    continue
                raise
        
        raise HTTPException(status_code=500, detail="Failed to generate unique code")
    finally:
        await db.close()

@router.put("/reorder")
async def reorder_nodes(reorder: NodeReorder, request: Request):
    """Batch reorder nodes (declared before /{node_id} so it is matched first)"""
    return await _reorder(reorder, _area(request))


async def _reorder(reorder: NodeReorder, owner):
    db = await get_db()
    try:
        for item in reorder.items:
            await db.execute(
                "UPDATE nodes SET sort_order = ? WHERE id = ? AND owner_id IS ?",
                (item['sort_order'], item['id'], owner)
            )
        await db.commit()
        return {"success": True, "message": "Nodes reordered"}
    finally:
        await db.close()

@router.put("/{node_id}", response_model=NodeResponse)
async def update_node(node_id: int, node: NodeUpdate, request: Request):
    """Update a node"""
    return await _update(node_id, node, request, _area(request))


async def _update(node_id: int, node: NodeUpdate, request: Request, owner):
    db = await get_db()
    try:
        existing = await _owned(db, node_id, owner)
        
        # Guard: prevent changing a folder with children to link type
        if node.node_type == 'link':
            cursor = await db.execute(
                "SELECT COUNT(*) as cnt FROM nodes WHERE parent_id = ?", (node_id,)
            )
            row = await cursor.fetchone()
            if row and row['cnt'] > 0:
                raise HTTPException(
                    status_code=400,
                    detail="無法將含有子節點的資料夾改為連結類型"
                )

        if node.url:
            node.url = la.normalize_target(node.url)
        # Changing a program link (or turning a link into one) is local-only
        if la.is_file_url(node.url) or (la.is_file_url(existing["url"]) and node.model_fields_set & {"url", "launch_args", "launch_cwd"}):
            la.require_local(request)

        # Build update query
        updates = []
        values = []
        update_data = node.model_dump(exclude_unset=True)
        
        for key, value in update_data.items():
            updates.append(f"{key} = ?")
            values.append(value)
        
        if updates:
            updates.append("updated_at = CURRENT_TIMESTAMP")
            values.append(node_id)
            
            await db.execute(
                f"UPDATE nodes SET {', '.join(updates)} WHERE id = ?",
                values
            )
            await db.commit()
        
        cursor = await db.execute("SELECT * FROM nodes WHERE id = ?", (node_id,))
        row = await cursor.fetchone()
        return dict(row)
    finally:
        await db.close()

@router.delete("/{node_id}")
async def delete_node(node_id: int, request: Request):
    """Delete a node and its children"""
    return await _delete(node_id, _area(request))


async def _delete(node_id: int, owner):
    db = await get_db()
    try:
        await _owned(db, node_id, owner)

        await db.execute("DELETE FROM nodes WHERE id = ?", (node_id,))
        await db.commit()
        return {"success": True, "message": "Node deleted"}
    finally:
        await db.close()

async def collect_descendants(db, node_id: int) -> List[dict]:
    """Return all descendants (id, code) of a node, depth-first"""
    result = []
    cursor = await db.execute("SELECT id, code FROM nodes WHERE parent_id = ?", (node_id,))
    for row in await cursor.fetchall():
        result.append(dict(row))
        result.extend(await collect_descendants(db, row['id']))
    return result

@router.put("/{node_id}/move")
async def move_node(node_id: int, move: NodeMove, request: Request):
    """Move node (and its whole subtree) to a new parent"""
    return await _move(node_id, move, _area(request))


async def _move(node_id: int, move: NodeMove, owner):
    db = await get_db()
    try:
        node = await _owned(db, node_id, owner)

        if move.new_parent_id == node['parent_id']:
            return {"success": True, "message": "Node unchanged", "new_code": node['code']}

        descendants = await collect_descendants(db, node_id)

        if move.new_parent_id is not None:
            if move.new_parent_id == node_id or move.new_parent_id in {d['id'] for d in descendants}:
                raise HTTPException(status_code=400, detail="不能移動到自己或自己的子節點底下")
            parent = await _owned(db, move.new_parent_id, owner)
            if parent['node_type'] != 'folder':
                raise HTTPException(status_code=400, detail="目標必須是資料夾")

        old_code = node['code']
        new_code = await generate_code(db, move.new_parent_id)

        await db.execute(
            "UPDATE nodes SET parent_id = ?, code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (move.new_parent_id, new_code, node_id)
        )
        # Re-prefix every descendant so codes keep reflecting the hierarchy
        for d in descendants:
            if d['code'] and d['code'].startswith(old_code + '-'):
                await db.execute(
                    "UPDATE nodes SET code = ? WHERE id = ?",
                    (new_code + d['code'][len(old_code):], d['id'])
                )
        await db.commit()

        return {"success": True, "message": "Node moved", "new_code": new_code}
    finally:
        await db.close()


# ============ 個人區: every signed-in account manages its own links ============
def _me(request: Request) -> int:
    user = getattr(request.state, "user", None) or {}
    if user.get("id") is None:
        raise HTTPException(status_code=400, detail="個人區需要登入（單機版：先連線到伺服器）")
    return user["id"]


@my_router.post("", response_model=NodeResponse)
async def my_create(node: NodeCreate, request: Request):
    if node.url and la.is_file_url(la.normalize_target(node.url)) and C.AUTH:
        raise HTTPException(status_code=400, detail="伺服器上的個人區不能放本機程式")
    return await _create(node, request, _me(request))


@my_router.put("/reorder")
async def my_reorder(reorder: NodeReorder, request: Request):
    return await _reorder(reorder, _me(request))


@my_router.put("/{node_id}", response_model=NodeResponse)
async def my_update(node_id: int, node: NodeUpdate, request: Request):
    return await _update(node_id, node, request, _me(request))


@my_router.delete("/{node_id}")
async def my_delete(node_id: int, request: Request):
    return await _delete(node_id, _me(request))


@my_router.put("/{node_id}/move")
async def my_move(node_id: int, move: NodeMove, request: Request):
    return await _move(node_id, move, _me(request))
