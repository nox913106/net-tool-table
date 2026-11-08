"""
Roles (server edition).

  superadmin    本機最高管理員      local break-glass account (installer); same rights as sysadmin
  sysadmin      系統管理者 (RW)     every admin-panel setting + every board, full rights
  board_admin   看板總管理者 (RW)   every board, full rights (create / edit / delete / assign)
  board_viewer  看板總管理者 (RO)   every board in detail, read only; may comment
  dept_admin    部門看板管理者 (RW) boards of the managed departments, full rights
  dept_viewer   部門看板管理者 (RO) boards of the managed departments in detail, read only; may comment
  user          使用者              own / assigned / @mentioned cards

Read-only roles still work on their *own* cards like any user. A card belongs to the
departments of its creator and its assignees (AD "department"). Department managers manage
their own AD department unless the admin ticks other departments (scope_departments).
"""
import json
from typing import List

ROLES = ("superadmin", "sysadmin", "board_admin", "board_viewer", "dept_admin", "dept_viewer", "user")
ASSIGNABLE = ROLES[1:]
LABELS = {
    "superadmin": "本機最高管理員", "sysadmin": "系統管理者", "board_admin": "看板總管理者（RW）",
    "board_viewer": "看板總管理者（RO）", "dept_admin": "部門看板管理者（RW）", "dept_viewer": "部門看板管理者（RO）",
    "user": "使用者",
}
DEPT_ROLES = ("dept_admin", "dept_viewer")


def is_sysadmin(user: dict) -> bool:
    """May use the admin panel (portal content, settings, accounts, system)."""
    return user.get("role") in ("superadmin", "sysadmin") or user.get("id") is None


def scope_departments(user: dict) -> List[str]:
    raw = user.get("scope_departments")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = None
    depts = [d for d in (raw or []) if isinstance(d, str) and d.strip()]
    return depts or ([user["department"]] if user.get("department") else [])


def board_access(user: dict) -> dict:
    """{'view': all|dept|own, 'edit': all|dept|own, 'depts': [...]} for the task board."""
    role = user.get("role")
    if user.get("id") is None or role in ("superadmin", "sysadmin", "board_admin"):
        return {"view": "all", "edit": "all", "depts": []}
    if role == "board_viewer":
        return {"view": "all", "edit": "own", "depts": []}
    if role == "dept_admin":
        return {"view": "dept", "edit": "dept", "depts": scope_departments(user)}
    if role == "dept_viewer":
        return {"view": "dept", "edit": "own", "depts": scope_departments(user)}
    return {"view": "own", "edit": "own", "depts": []}
