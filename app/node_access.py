"""
Who sees which public portal links (公用區).

A public folder or link may carry visible_to = {"departments": [...], "users": [usernames]}.
Empty / NULL: everyone signed in sees it. Otherwise only people in one of those departments or
named there see it — and a restriction on a folder applies to everything inside it (each level
that has one must let the person in). System administrators see everything (they manage it).

On the server every read of the tree, a folder, a node or the search goes through hidden_ids();
a linked standalone copy only ever receives what its account may see (app/routes/sync.py pull).
"""
import json
from typing import Optional, Set

from . import config as C


def parse(raw) -> Optional[dict]:
    """The stored rule as {"departments": [...], "users": [...]}, or None for everyone."""
    if not raw:
        return None
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return None
    if not isinstance(raw, dict):
        return None
    deps = [str(d).strip() for d in raw.get("departments") or [] if str(d).strip()]
    users = [str(u).strip().lower() for u in raw.get("users") or [] if str(u).strip()]
    if not deps and not users:
        return None
    return {"departments": sorted(set(deps))[:200], "users": sorted(set(users))[:500]}


def dump(rule) -> Optional[str]:
    rule = parse(rule)
    return json.dumps(rule, ensure_ascii=False) if rule else None


def sees_all(user: Optional[dict]) -> bool:
    if not C.AUTH:
        return True                     # a standalone copy holds only what its account may see
    from .roles import is_sysadmin
    return bool(user) and is_sysadmin(user)


def allowed(rule: Optional[dict], user: Optional[dict]) -> bool:
    if not rule:
        return True
    if not user:
        return False
    dept = (user.get("department") or "").strip()
    name = (user.get("username") or "").strip().lower()
    return (bool(dept) and dept in rule["departments"]) or (bool(name) and name in rule["users"])


async def hidden_ids(db, user: Optional[dict], force: bool = False) -> Set[int]:
    """Ids of public nodes this person may not see (a hidden folder hides its whole subtree).
    force: apply the rules even to an administrator (what a linked device of theirs receives stays the same)."""
    if not force and sees_all(user):
        return set()
    cur = await db.execute("SELECT id, parent_id, visible_to FROM nodes WHERE owner_id IS NULL")
    rows = {r[0]: (r[1], r[2]) for r in await cur.fetchall()}
    if not any(v for _, v in rows.values()):
        return set()
    memo: dict = {}

    def hidden(i, depth=0) -> bool:
        if i in memo:
            return memo[i]
        parent, raw = rows.get(i, (None, None))
        h = not allowed(parse(raw), user)
        if not h and parent is not None and parent in rows and depth < 64:
            h = hidden(parent, depth + 1)
        memo[i] = h
        return h
    return {i for i in rows if hidden(i)}


async def departments(db) -> list:
    cur = await db.execute("SELECT DISTINCT department FROM users WHERE department IS NOT NULL AND department != '' "
                           "AND active = 1 ORDER BY department")
    return [r[0] for r in await cur.fetchall()]
