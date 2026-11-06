"""
Nodes API Routes
CRUD operations for hierarchical nodes (categories and links)
"""
from fastapi import APIRouter, HTTPException, Depends
from typing import List, Optional
import aiosqlite

from ..database import get_db
from ..models import (
    NodeCreate, NodeUpdate, NodeMove, NodeResponse, 
    NodeTreeItem, NodeReorder, APIResponse
)

router = APIRouter(prefix="/api/nodes", tags=["nodes"])

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

async def build_tree(db, include_inactive: bool = False) -> List[dict]:
    """Whole tree in one query. Inactive nodes (and their subtrees) are skipped
    unless include_inactive is set (admin view)."""
    where = "" if include_inactive else "WHERE is_active = TRUE"
    cursor = await db.execute(f"SELECT * FROM nodes {where} ORDER BY sort_order, id")
    rows = [dict(r) for r in await cursor.fetchall()]
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
async def get_root_nodes():
    """Get all root nodes"""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM nodes WHERE parent_id IS NULL AND is_active = TRUE ORDER BY sort_order, code"
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]
    finally:
        await db.close()

@router.get("/tree")
async def get_full_tree(include_inactive: bool = False):
    """Get complete tree structure (?include_inactive=true for the admin view)"""
    db = await get_db()
    try:
        return await build_tree(db, include_inactive)
    finally:
        await db.close()

@router.get("/{node_id}", response_model=NodeResponse)
async def get_node(node_id: int):
    """Get single node by ID"""
    db = await get_db()
    try:
        cursor = await db.execute("SELECT * FROM nodes WHERE id = ?", (node_id,))
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Node not found")
        return dict(row)
    finally:
        await db.close()

@router.get("/{node_id}/children", response_model=List[NodeResponse])
async def get_children(node_id: int):
    """Get children of a node"""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM nodes WHERE parent_id = ? AND is_active = TRUE ORDER BY sort_order, code",
            (node_id,)
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]
    finally:
        await db.close()

@router.get("/code/{code}")
async def get_by_code(code: str):
    """Get node by code (e.g., 3-2-1)"""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM nodes WHERE code = ? AND is_active = TRUE", (code,)
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
async def create_node(node: NodeCreate):
    """Create a new node"""
    db = await get_db()
    try:
        # Validate link type requires URL
        if node.node_type == 'link' and not node.url:
            raise HTTPException(status_code=400, detail="Link type requires URL")
        if node.parent_id is not None:
            cursor = await db.execute("SELECT node_type FROM nodes WHERE id = ?", (node.parent_id,))
            parent = await cursor.fetchone()
            if not parent:
                raise HTTPException(status_code=404, detail="Parent not found")
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
                                          description, color, new_tab, sort_order, is_active)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (node.parent_id, code, node.name, node.node_type,
                     node.icon, node.url, node.description, node.color or None,
                     node.new_tab, node.sort_order, node.is_active)
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
async def reorder_nodes(reorder: NodeReorder):
    """Batch reorder nodes (declared before /{node_id} so it is matched first)"""
    db = await get_db()
    try:
        for item in reorder.items:
            await db.execute(
                "UPDATE nodes SET sort_order = ? WHERE id = ?",
                (item['sort_order'], item['id'])
            )
        await db.commit()
        return {"success": True, "message": "Nodes reordered"}
    finally:
        await db.close()

@router.put("/{node_id}", response_model=NodeResponse)
async def update_node(node_id: int, node: NodeUpdate):
    """Update a node"""
    db = await get_db()
    try:
        # Check exists
        cursor = await db.execute("SELECT * FROM nodes WHERE id = ?", (node_id,))
        existing = await cursor.fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Node not found")
        
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
async def delete_node(node_id: int):
    """Delete a node and its children"""
    db = await get_db()
    try:
        cursor = await db.execute("SELECT * FROM nodes WHERE id = ?", (node_id,))
        if not await cursor.fetchone():
            raise HTTPException(status_code=404, detail="Node not found")
        
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
async def move_node(node_id: int, move: NodeMove):
    """Move node (and its whole subtree) to a new parent"""
    db = await get_db()
    try:
        cursor = await db.execute("SELECT * FROM nodes WHERE id = ?", (node_id,))
        node = await cursor.fetchone()
        if not node:
            raise HTTPException(status_code=404, detail="Node not found")

        if move.new_parent_id == node['parent_id']:
            return {"success": True, "message": "Node unchanged", "new_code": node['code']}

        descendants = await collect_descendants(db, node_id)

        if move.new_parent_id is not None:
            if move.new_parent_id == node_id or move.new_parent_id in {d['id'] for d in descendants}:
                raise HTTPException(status_code=400, detail="不能移動到自己或自己的子節點底下")
            cursor = await db.execute("SELECT node_type FROM nodes WHERE id = ?", (move.new_parent_id,))
            parent = await cursor.fetchone()
            if not parent:
                raise HTTPException(status_code=404, detail="Parent not found")
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
