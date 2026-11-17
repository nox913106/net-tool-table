"""
Reporting lines (上級 / 下級).

users.manager_id points at a person's 上級 — read from AD's "manager" attribute when they sign in
(sysconfig.Ldap.sync_manager), or set by an admin in 帳號與權限 (manager_source = 'manual', which AD
then leaves alone). A supervisor's team is everyone below them, any number of levels down.
Depending on the board_supervisor setting the team's cards are theirs to edit (rw), to view and
comment on (ro), or not shared (off) — see roles.board_access and routes/tasks._scope_sql.
"""
from typing import Dict, List, Optional

MAX_DEPTH = 15


async def team_ids(db, uid) -> List[int]:
    """Everyone below uid (direct and indirect reports), uid itself excluded."""
    if uid is None:
        return []
    cur = await db.execute(f"""
        WITH RECURSIVE below(id, depth) AS (
            SELECT id, 1 FROM users WHERE manager_id = ? AND active = 1
            UNION
            SELECT u.id, b.depth + 1 FROM users u JOIN below b ON u.manager_id = b.id WHERE b.depth < {MAX_DEPTH} AND u.active = 1
        ) SELECT DISTINCT id FROM below WHERE id != ?""", (uid, uid))
    return [r[0] for r in await cur.fetchall()]


async def chain_up(db, uid) -> List[int]:
    """uid's 上級, their 上級, … (nearest first)."""
    out, seen = [], {uid}
    cur_id = uid
    for _ in range(MAX_DEPTH):
        cur = await db.execute("SELECT manager_id FROM users WHERE id = ?", (cur_id,))
        row = await cur.fetchone()
        if not row or not row[0] or row[0] in seen:
            break
        out.append(row[0])
        seen.add(row[0])
        cur_id = row[0]
    return out


async def would_cycle(db, uid: int, manager_id: Optional[int]) -> bool:
    """Setting uid's 上級 to manager_id would put uid above itself."""
    if manager_id is None:
        return False
    return manager_id == uid or manager_id in await team_ids(db, uid)


async def relations(db, uid) -> Dict[int, str]:
    """user id → 上級 / 下級 / 同級 as seen from uid (for the @ list)."""
    if uid is None:
        return {}
    rel: Dict[int, str] = {}
    up = await chain_up(db, uid)
    for i in up:
        rel[i] = "上級"
    for i in await team_ids(db, uid):
        rel.setdefault(i, "下級")
    if up:
        cur = await db.execute("SELECT id FROM users WHERE manager_id = ? AND id != ? AND active = 1", (up[0], uid))
        for r in await cur.fetchall():
            rel.setdefault(r[0], "同級")
    return rel
