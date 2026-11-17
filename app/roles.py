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
    """{'view': all|dept|own, 'edit': all|dept|own, 'depts': [...], 'team': [...], 'team_view': bool, 'team_edit': bool}.
    team = everyone below this person in the reporting line (app/team.py); on top of the role, a
    supervisor sees (team_view) and, with board_supervisor = rw, edits (team_edit) their team's cards."""
    role = user.get("role")
    if user.get("id") is None or role in ("superadmin", "sysadmin", "board_admin"):
        acc = {"view": "all", "edit": "all", "depts": []}
    elif role == "board_viewer":
        acc = {"view": "all", "edit": "own", "depts": []}
    elif role == "dept_admin":
        acc = {"view": "dept", "edit": "dept", "depts": scope_departments(user)}
    elif role == "dept_viewer":
        acc = {"view": "dept", "edit": "own", "depts": scope_departments(user)}
    else:
        acc = {"view": "own", "edit": "own", "depts": []}
    mode = user.get("supervisor", "rw")
    team = [i for i in (user.get("team") or []) if isinstance(i, int)]
    acc["team"] = team if mode != "off" else []
    acc["team_view"] = bool(acc["team"])
    acc["team_edit"] = bool(acc["team"]) and mode == "rw"
    return acc
