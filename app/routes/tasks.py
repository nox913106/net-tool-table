"""
Task board (kanban) — cards in seven columns with start / due dates and reminders.

Recurring cards ("repeat" rule) are anchored on their due date. When one is closed
(status → complete, by the close prompt, the editor or a drag) the next occurrence is
created once, in the "recurring" column (週期工作).

One-off cards that pass their due date while still open are moved to the "overdue"
column (過期未結案) by /sweep, which the browser calls with its local time. If you move
a card out of that column yourself it stays where you put it (until its due date
changes); pushing the due date into the future moves it back to where it came from.

Accounts (server edition): every card has an owner (creator), assignees (set by admins;
a user's own card is assigned to them) and @mentioned collaborators. Admins see every
card; users see the cards they own, are assigned to or were mentioned on.

Dates are local wall-clock strings: "YYYY-MM-DD" (all day) or "YYYY-MM-DDTHH:MM".
The browser works out what is overdue / due soon and shows the reminders, so the
server never has to guess the viewer's time zone.
"""
import asyncio
import calendar
import json
import os
from urllib.parse import quote
import re
from datetime import date, timedelta
from typing import List, Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, field_validator

from .. import images as img
from .. import config as C
from .. import ldapauth
from ..auth import current_user, is_admin
from ..roles import board_access
from ..database import get_db

router = APIRouter(prefix="/api/tasks", tags=["tasks"])

STATUSES = ("recurring", "overdue", "new", "ongoing", "pending", "onhold", "complete", "canceled")
CLOSED = ("complete", "canceled")
PRIORITIES = ("low", "normal", "high")
REMINDS = (0, 15, 60, 1440, 2880, 10080)       # minutes before due; None = no reminder
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$")
REPEAT_RE = re.compile(r"^(daily|weekdays|weekly(:[1-7](,[1-7]){0,6})?|monthly(:\d{1,2})?|yearly)$")
COLUMNS = ("id, title, description, status, priority, start_at, due_at, remind, repeat, repeat_every, next_id, "
           "overdue_from, overdue_ack, owner_id, sort_order, created_at, updated_at, completed_at, "
           "blocked_at, blocked_reason, blocked_by, tags, milestone, deps, base_start, base_due, started_at, win, kind, project_id, rank")


def _repeat(v):
    if v in (None, ""):
        return None
    v = str(v).strip()
    if not REPEAT_RE.match(v):
        raise ValueError("重複規則無效")
    if v.startswith("weekly:"):
        v = "weekly:" + ",".join(sorted(set(v[7:].split(","))))
    return v


def _every(v):
    if v is None:
        return 1
    if not isinstance(v, int) or not 1 <= v <= 365:
        raise ValueError("重複間隔必須是 1–365")
    return v


# ------------------------------------------------------------- recurrence
def _add_months(d: date, months: int, day: int) -> date:
    m = d.month - 1 + months
    y, m = d.year + m // 12, m % 12 + 1
    return date(y, m, min(day, calendar.monthrange(y, m)[1]))


def _step(d: date, rule: str, every: int) -> date:
    """The occurrence after `d`."""
    if rule == "daily":
        return d + timedelta(days=every)
    if rule == "weekdays":
        d += timedelta(days=1)
        while d.weekday() >= 5:
            d += timedelta(days=1)
        return d
    if rule.startswith("weekly"):
        days = sorted(int(x) for x in (rule.split(":")[1] if ":" in rule else str(d.isoweekday())).split(","))
        later = [x for x in days if x > d.isoweekday()]
        if later:                                            # another day in the same week
            return d + timedelta(days=later[0] - d.isoweekday())
        monday = d - timedelta(days=d.isoweekday() - 1)
        return monday + timedelta(weeks=every, days=days[0] - 1)
    if rule.startswith("monthly"):
        day = int(rule.split(":")[1]) if ":" in rule else d.day
        return _add_months(d, every, day)
    if rule == "yearly":
        try:
            return d.replace(year=d.year + every)
        except ValueError:                                   # 29 Feb
            return date(d.year + every, 2, 28)
    raise ValueError(rule)


def next_occurrence(due_at: str, rule: str, every: int = 1, today: Optional[date] = None):
    """Next due string after `due_at` that is not in the past (missed periods are skipped)."""
    d = date.fromisoformat(due_at[:10])
    today = today or date.today()
    nxt = _step(d, rule, every)
    for _ in range(5000):
        if nxt >= today:
            break
        nxt = _step(nxt, rule, every)
    return nxt.isoformat() + due_at[10:], (nxt - d).days


def _shift(v: Optional[str], days: int) -> Optional[str]:
    if not v:
        return None
    return (date.fromisoformat(v[:10]) + timedelta(days=days)).isoformat() + v[10:]


async def spawn_next(db, task_id: int, today: Optional[date] = None) -> Optional[int]:
    """Create the next occurrence of a recurring card (once). Returns the new card id."""
    cur = await db.execute(f"SELECT {COLUMNS} FROM tasks WHERE id = ?", (task_id,))
    t = await cur.fetchone()
    if not t or not t["repeat"] or not t["due_at"]:
        return None
    if t["next_id"]:
        cur = await db.execute("SELECT id FROM tasks WHERE id = ?", (t["next_id"],))
        if await cur.fetchone():
            return t["next_id"]                              # already created
    due, delta = next_occurrence(t["due_at"], t["repeat"], t["repeat_every"] or 1, today)
    cur = await db.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM tasks WHERE status = 'recurring'")
    order = (await cur.fetchone())["n"]
    cur = await db.execute(
        """INSERT INTO tasks (title, description, status, priority, start_at, due_at, remind, repeat, repeat_every, sort_order, owner_id, tags)
           VALUES (?, ?, 'recurring', ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (t["title"], t["description"], t["priority"], _shift(t["start_at"], delta), due, t["remind"],
         t["repeat"], t["repeat_every"] or 1, order, t["owner_id"], t["tags"]))
    new_id = cur.lastrowid
    await db.execute("""INSERT INTO task_members (task_id, user_id, role)
                        SELECT ?, user_id, role FROM task_members WHERE task_id = ?""", (new_id, task_id))
    cur = await db.execute("""SELECT user_id, stored, mime, name, size, kind FROM task_images
                              WHERE task_id = ? AND comment_id IS NULL AND pending = 0 ORDER BY id""", (task_id,))
    for im in await cur.fetchall():
        copied = img.copy(im["stored"])
        if copied:
            await db.execute("""INSERT INTO task_images (task_id, user_id, stored, mime, name, size, kind)
                                VALUES (?, ?, ?, ?, ?, ?, ?)""", (new_id, im["user_id"], copied, im["mime"], im["name"], im["size"], im["kind"]))
    cur = await db.execute("""SELECT id, task_parent_id, user_id, body, title, start_at, due_at, assignee_id, estimate_minutes,
                                     sort_order, priority, remind
                              FROM task_comments WHERE task_id = ? AND is_task = 1 AND parent_id IS NULL
                              AND status != 'canceled' ORDER BY COALESCE(sort_order, id), id""", (task_id,))
    subs = await cur.fetchall()
    copied_ids = {}                                       # the whole subtask tree, parents before children
    pending = list(subs)
    while pending:
        rest = []
        for c in pending:
            if c["task_parent_id"] and c["task_parent_id"] not in copied_ids:
                if any(x["id"] == c["task_parent_id"] for x in subs):
                    rest.append(c)
                continue                                  # its parent was canceled: not copied
            cur2 = await db.execute("""INSERT INTO task_comments (task_id, user_id, body, is_task, title, status, start_at, due_at,
                                                           assignee_id, estimate_minutes, sort_order, priority, remind, task_parent_id)
                                VALUES (?, ?, ?, 1, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?)""",
                             (new_id, c["user_id"], c["body"], c["title"], _shift(c["start_at"], delta), _shift(c["due_at"], delta),
                              c["assignee_id"], c["estimate_minutes"], c["sort_order"], c["priority"], c["remind"],
                              copied_ids.get(c["task_parent_id"])))
            copied_ids[c["id"]] = cur2.lastrowid
        if len(rest) == len(pending):
            break
        pending = rest
    await db.execute("UPDATE tasks SET next_id = ? WHERE id = ?", (new_id, task_id))
    return new_id


def _monthly_anchor(rule: Optional[str], due_at: Optional[str]) -> Optional[str]:
    """'monthly' → 'monthly:<day of the due date>' so 31st stays the last day of short months."""
    if rule == "monthly" and due_at:
        return f"monthly:{int(due_at[8:10])}"
    return rule


def _date(v):
    if v in (None, ""):
        return None
    v = str(v).strip()[:16]
    if not DATE_RE.match(v):
        raise ValueError("日期格式應為 YYYY-MM-DD 或 YYYY-MM-DDTHH:MM")
    return v


def _win(v):
    if v is None:
        return None
    v = re.sub(r"[^A-Za-z0-9_-]", "", str(v))[:24]
    return v                                   # "" clears it


def _title(v):
    v = (v or "").strip()
    if not v:
        raise ValueError("請輸入標題")
    return v[:200]


def _desc(v):
    return (v or "").strip()[:5000] or None


def _status(v):
    if v not in STATUSES:
        raise ValueError(f"狀態必須是 {', '.join(STATUSES)}")
    return v


def _prio(v):
    if v not in PRIORITIES:
        raise ValueError(f"優先順序必須是 {', '.join(PRIORITIES)}")
    return v


TAG_MAX, TAG_LEN = 8, 24


def _tags(v):
    """Custom labels: trimmed, '#' dropped, no duplicates (case-insensitive), at most 8 × 24 characters."""
    if v is None:
        return None
    out, seen = [], set()
    for x in v:
        if not isinstance(x, str):
            continue
        t = re.sub(r"\s+", " ", x.strip().lstrip("#＃").strip())
        if not t:
            continue
        if len(t) > TAG_LEN:
            raise ValueError(f"標籤「{t[:10]}…」太長（最多 {TAG_LEN} 字）")
        if t.lower() not in seen:
            seen.add(t.lower())
            out.append(t)
    if len(out) > TAG_MAX:
        raise ValueError(f"一張卡片最多 {TAG_MAX} 個標籤")
    return out


def tags_json(v) -> Optional[str]:
    return json.dumps(v, ensure_ascii=False) if v else None


def tags_list(raw) -> List[str]:
    try:
        v = json.loads(raw) if raw else []
    except ValueError:
        return []
    return [x for x in v if isinstance(x, str)] if isinstance(v, list) else []


def _remind(v):
    if v is not None and v not in REMINDS:
        raise ValueError("提醒時間無效")
    return v


class DepIn(BaseModel):
    key: str                                       # "t:<card id>" or "s:<subtask id>"
    lag: int = 0                                   # days between the predecessor's end and this start

    @field_validator("lag")
    @classmethod
    def v_lag(cls, v):
        return max(-365, min(365, int(v or 0)))


class TaskIn(BaseModel):
    title: str
    description: Optional[str] = None
    status: str = "new"
    priority: str = "normal"
    start_at: Optional[str] = None
    due_at: Optional[str] = None
    remind: Optional[int] = None
    repeat: Optional[str] = None
    repeat_every: Optional[int] = None
    assignees: Optional[List[str]] = None          # login names (admins only)
    tags: Optional[List[str]] = None               # custom labels shown on the card
    milestone: Optional[bool] = None               # a single date (the due date), drawn as a diamond
    deps: Optional[List[DepIn]] = None             # predecessors
    started_at: Optional[str] = None               # actual start (set automatically; can be corrected)
    win: Optional[str] = None                      # the shared window it needs ("" = none)
    kind: Optional[str] = None                     # ops | project
    project_id: Optional[int] = None               # the project an ops card belongs to (0 / null = none)

    @field_validator("kind")
    @classmethod
    def v_kind(cls, v):
        if v is not None and v not in ("ops", "project"):
            raise ValueError("類型必須是 ops 或 project")
        return v

    @field_validator("win")
    @classmethod
    def v_win(cls, v):
        return _win(v)

    @field_validator("started_at")
    @classmethod
    def v_started(cls, v):
        return _date(v)

    @field_validator("tags")
    @classmethod
    def v_tags(cls, v):
        return _tags(v)

    @field_validator("repeat")
    @classmethod
    def v_repeat(cls, v):
        return _repeat(v)

    @field_validator("repeat_every")
    @classmethod
    def v_every(cls, v):
        return _every(v)

    @field_validator("title")
    @classmethod
    def v_title(cls, v):
        return _title(v)

    @field_validator("description")
    @classmethod
    def v_desc(cls, v):
        return _desc(v)

    @field_validator("status")
    @classmethod
    def v_status(cls, v):
        return _status(v)

    @field_validator("priority")
    @classmethod
    def v_prio(cls, v):
        return _prio(v)

    @field_validator("start_at", "due_at")
    @classmethod
    def v_dates(cls, v):
        return _date(v)

    @field_validator("remind")
    @classmethod
    def v_remind(cls, v):
        return _remind(v)


class TaskUpdate(BaseModel):
    """Partial update: only the fields that were sent are changed."""
    title: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    priority: Optional[str] = None
    start_at: Optional[str] = None
    due_at: Optional[str] = None
    remind: Optional[int] = None
    repeat: Optional[str] = None
    repeat_every: Optional[int] = None
    assignees: Optional[List[str]] = None          # login names (admins only)
    tags: Optional[List[str]] = None               # custom labels shown on the card
    milestone: Optional[bool] = None               # a single date (the due date), drawn as a diamond
    deps: Optional[List[DepIn]] = None             # predecessors
    started_at: Optional[str] = None               # actual start (set automatically; can be corrected)
    win: Optional[str] = None                      # the shared window it needs ("" = none)
    kind: Optional[str] = None                     # ops | project
    project_id: Optional[int] = None               # the project an ops card belongs to (0 / null = none)

    @field_validator("kind")
    @classmethod
    def v_kind(cls, v):
        if v is not None and v not in ("ops", "project"):
            raise ValueError("類型必須是 ops 或 project")
        return v

    @field_validator("win")
    @classmethod
    def v_win(cls, v):
        return _win(v)

    @field_validator("started_at")
    @classmethod
    def v_started(cls, v):
        return _date(v)

    @field_validator("tags")
    @classmethod
    def v_tags(cls, v):
        return _tags(v)

    @field_validator("repeat")
    @classmethod
    def v_repeat(cls, v):
        return _repeat(v)

    @field_validator("repeat_every")
    @classmethod
    def v_every(cls, v):
        return _every(v)

    @field_validator("title")
    @classmethod
    def v_title(cls, v):
        return _title(v)

    @field_validator("description")
    @classmethod
    def v_desc(cls, v):
        return _desc(v)

    @field_validator("status")
    @classmethod
    def v_status(cls, v):
        return _status(v)

    @field_validator("priority")
    @classmethod
    def v_prio(cls, v):
        return _prio(v)

    @field_validator("start_at", "due_at")
    @classmethod
    def v_dates(cls, v):
        return _date(v)

    @field_validator("remind")
    @classmethod
    def v_remind(cls, v):
        return _remind(v)


class Reorder(BaseModel):
    status: str
    ids: List[int]

    @field_validator("status")
    @classmethod
    def v_status(cls, v):
        return _status(v)


def _check_dates(start, due, repeat=None):
    if start and due and start[:10] > due[:10]:
        raise HTTPException(status_code=400, detail="開始日不能晚於到期日")
    if repeat and not due:
        raise HTTPException(status_code=400, detail="重複的卡片需要設定到期日（下一次依到期日推算）")


class SweepIn(BaseModel):
    now: str                         # viewer's local time "YYYY-MM-DDTHH:MM"

    @field_validator("now")
    @classmethod
    def v_now(cls, v):
        v = _date(v)
        if not v or len(v) != 16:
            raise ValueError("now 必須是 YYYY-MM-DDTHH:MM")
        return v


def is_past(due_at: str, now: str) -> bool:
    """All-day cards are overdue the day after; timed cards right after their time."""
    return due_at[:10] < now[:10] if len(due_at) == 10 else due_at < now


class CompleteIn(BaseModel):
    today: Optional[str] = None      # viewer's local date, so missed periods are skipped correctly

    @field_validator("today")
    @classmethod
    def v_today(cls, v):
        v = _date(v)
        return v[:10] if v else None


def row_dict(r) -> dict:
    return {k: r[k] for k in r.keys()}


async def _get(db, task_id: int) -> dict:
    cur = await db.execute(f"SELECT {COLUMNS} FROM tasks WHERE id = ?", (task_id,))
    row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="找不到這張卡片")
    return row_dict(row)


# ------------------------------------------------------------ who sees what
# Roles (app/roles.py): view / edit is "all", "dept" (cards whose creator or an assignee is in a
# managed department) or "own" (cards the viewer created, is assigned to or was @mentioned on).
def _involved_sql(alias: str, uid, edit: bool = False):
    """Creator, assignee, @mentioned — and, for viewing only, people assigned one of its subtasks."""
    only = " AND vm.role != 'subtask'" if edit else ""
    return (f"({alias}.owner_id = ? OR EXISTS (SELECT 1 FROM task_members vm WHERE vm.task_id = {alias}.id AND vm.user_id = ?{only}))",
            [uid, uid])


def _dept_sql(alias: str, depts: List[str]):
    marks = ",".join("?" * len(depts))
    return (f"(EXISTS (SELECT 1 FROM users ou WHERE ou.id = {alias}.owner_id AND ou.department IN ({marks})) "
            f"OR EXISTS (SELECT 1 FROM task_members dm JOIN users du ON du.id = dm.user_id "
            f"WHERE dm.task_id = {alias}.id AND dm.role = 'assignee' AND du.department IN ({marks})))", [*depts, *depts])


def _team_sql(alias: str, team: List[int]):
    """Cards created by, or assigned to, someone in the team (everyone below me in the reporting line)."""
    marks = ",".join("?" * len(team))
    return (f"({alias}.owner_id IN ({marks}) OR EXISTS (SELECT 1 FROM task_members tm WHERE tm.task_id = {alias}.id "
            f"AND tm.role = 'assignee' AND tm.user_id IN ({marks})))", [*team, *team])


def _scope_sql(user: dict, level: str, alias: str = "t"):
    acc = board_access(user)
    if acc[level] == "all":
        return "1 = 1", []
    inv, args = _involved_sql(alias, user.get("id"), edit=level == "edit")
    parts, pargs = [inv], list(args)
    if acc[level] == "dept" and acc["depts"]:
        d, dargs = _dept_sql(alias, acc["depts"])
        parts.append(d); pargs += dargs
    if acc["team_view" if level == "view" else "team_edit"]:
        tsql, targs = _team_sql(alias, acc["team"])
        parts.append(tsql); pargs += targs
    return (parts[0], pargs) if len(parts) == 1 else ("(" + " OR ".join(parts) + ")", pargs)


def _visible_sql(user: dict, alias: str = "t"):
    return _scope_sql(user, "view", alias)


async def _require_edit(db, task_id: int, user: dict):
    where, args = _scope_sql(user, "edit")
    cur = await db.execute(f"SELECT 1 FROM tasks t WHERE t.id = ? AND {where}", (task_id, *args))
    if not await cur.fetchone():
        raise HTTPException(status_code=403, detail="這張卡片你只能檢視（唯讀），可以留言")


async def _members_of(db, user_ids) -> dict:
    ids = [u for u in user_ids if u]
    if not ids:
        return {}
    cur = await db.execute(f"SELECT id, department FROM users WHERE id IN ({','.join('?' * len(ids))})", ids)
    return {r["id"]: r["department"] for r in await cur.fetchall()}


async def _check_assignees(db, user: dict, task_id: Optional[int], people: List[dict]):
    """Board admins assign anyone; department managers only people of the departments they manage."""
    acc = board_access(user)
    if acc["edit"] == "all":
        return
    if acc["edit"] != "dept" and not acc["team_edit"]:
        raise HTTPException(status_code=403, detail="只有看板管理者或上級可以指派負責人")
    before = await _members(db, task_id, "assignee") if task_id else set()
    depts = await _members_of(db, [p["id"] for p in people]) if acc["edit"] == "dept" else {}
    ok = lambda p: (p["id"] in before or p["id"] == user.get("id") or (acc["team_edit"] and p["id"] in acc["team"])
                    or (acc["edit"] == "dept" and depts.get(p["id"]) in acc["depts"]))
    outside = [p for p in people if not ok(p)]
    if outside:
        scope = "、".join(filter(None, ["你的下級" if acc["team_edit"] else "",
                                       ("你管理的部門（" + "、".join(acc["depts"]) + "）") if acc["edit"] == "dept" else ""]))
        raise HTTPException(status_code=403, detail=f"只能指派{scope}的人："
                            + "、".join(p.get("display_name") or p["username"] for p in outside) + " 不在範圍內")


async def _get_visible(db, task_id: int, user: dict) -> dict:
    where, args = _visible_sql(user)
    cur = await db.execute(f"SELECT {COLUMNS} FROM tasks t WHERE t.id = ? AND {where}", (task_id, *args))
    row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="找不到這張卡片（或你沒有權限看到它）")
    return row_dict(row)


async def _enrich(db, rows: List[dict], user: dict) -> List[dict]:
    """Add owner / assignees / mentions / comment count / permissions for the viewer."""
    if not rows:
        return rows
    ids = [r["id"] for r in rows]
    marks = ",".join("?" * len(ids))
    people = {}
    cur = await db.execute(
        f"""SELECT m.task_id, m.role, m.done_at, u.id, u.username, u.display_name, u.department FROM task_members m
            JOIN users u ON u.id = m.user_id WHERE m.task_id IN ({marks}) ORDER BY m.created_at""", ids)
    for m in await cur.fetchall():
        people.setdefault(m["task_id"], {"assignee": [], "mention": [], "subtask": []}).setdefault(m["role"], []).append(
            {"id": m["id"], "username": m["username"], "name": m["display_name"] or m["username"], "department": m["department"],
             "done": bool(m["done_at"])})
    owners = {}
    owner_ids = list({r["owner_id"] for r in rows if r.get("owner_id")})
    if owner_ids:
        cur = await db.execute(f"SELECT id, username, display_name, department FROM users WHERE id IN ({','.join('?' * len(owner_ids))})", owner_ids)
        owners = {u["id"]: {"id": u["id"], "username": u["username"], "name": u["display_name"] or u["username"],
                            "department": u["department"]} for u in await cur.fetchall()}
    cur = await db.execute(f"SELECT task_id, COUNT(*) AS c FROM task_comments WHERE task_id IN ({marks}) GROUP BY task_id", ids)
    comments = {c["task_id"]: c["c"] for c in await cur.fetchall()}
    rollup = await _rollup(db, ids, user.get("id"))
    dep_map = await deps_out(db, [r.get("deps") for r in rows])
    pics = {}
    cur = await db.execute(f"""SELECT id, task_id, name, size, kind FROM task_images
                               WHERE task_id IN ({marks}) AND comment_id IS NULL AND pending = 0 ORDER BY id""", ids)
    for im in await cur.fetchall():
        pics.setdefault((im["task_id"], im["kind"]), []).append(image_dict(im))
    blockers = {}
    bids = list({r["blocked_by"] for r in rows if r.get("blocked_by")})
    if bids:
        cur = await db.execute(f"SELECT id, username, display_name FROM users WHERE id IN ({','.join('?' * len(bids))})", bids)
        blockers = {u["id"]: u["display_name"] or u["username"] for u in await cur.fetchall()}
    me = user.get("id")
    acc = board_access(user)
    for r in rows:
        r["tags"] = tags_list(r.get("tags"))
        r["milestone"] = bool(r.get("milestone"))
        r["deps"] = dep_map.get(r.get("deps") or "", [])
        r["blocked"] = {"since": r["blocked_at"], "reason": r.get("blocked_reason") or "",
                        "by": blockers.get(r.get("blocked_by"))} if r.get("blocked_at") else None
        p = people.get(r["id"], {"assignee": [], "mention": [], "subtask": []})
        r["owner"] = owners.get(r.get("owner_id"))
        r["assignees"] = p["assignee"]
        r["mentions"] = p["mention"]
        r["comments"] = comments.get(r["id"], 0)
        r["images"] = pics.get((r["id"], "image"), [])
        r["files"] = pics.get((r["id"], "file"), [])
        r["subtasks"] = rollup.get(r["id"])
        involved = me is None or r.get("owner_id") == me or any(x["id"] == me for x in p["assignee"] + p["mention"])
        owner = owners.get(r.get("owner_id"))
        card_depts = {d for d in [owner["department"] if owner else None, *[a["department"] for a in p["assignee"]]] if d}
        r["departments"] = sorted(card_depts)
        card_people = {r.get("owner_id"), *[a["id"] for a in p["assignee"]]}
        in_scope = (acc["edit"] == "all" or (acc["edit"] == "dept" and bool(card_depts & set(acc["depts"])))
                    or (acc["team_edit"] and bool(card_people & set(acc["team"]))))
        r["team"] = bool(card_people & set(acc["team"])) and me not in card_people   # a card of someone below me
        r["mine"] = involved
        r["can_edit"] = in_scope or involved
        r["can_delete"] = in_scope or (me is not None and r.get("owner_id") == me)
        r["can_assign"] = in_scope or (acc["team_edit"] and involved)
        r["can_comment"] = True                   # only visible cards are ever returned
    return rows


async def _rollup(db, ids: List[int], me) -> dict:
    """Summary-task roll-up per card: subtask counts, hours, date span; my open subtasks; my running timer."""
    marks = ",".join("?" * len(ids))
    cur = await db.execute(f"""
        SELECT c.id, c.task_id, c.title, c.status, c.start_at, c.due_at, c.assignee_id, c.estimate_minutes, c.remind, c.priority,
               (SELECT COALESCE(SUM(minutes), 0) FROM task_time tt WHERE tt.comment_id = c.id) AS spent,
               u.username AS a_username, u.display_name AS a_name, u.department AS a_department
        FROM task_comments c LEFT JOIN users u ON u.id = c.assignee_id
        WHERE c.task_id IN ({marks}) AND c.is_task = 1 AND c.parent_id IS NULL AND c.task_parent_id IS NULL
        ORDER BY COALESCE(c.sort_order, c.id), c.id""", ids)
    out = {}
    for c in await cur.fetchall():
        s = out.setdefault(c["task_id"], {"total": 0, "done": 0, "canceled": 0, "estimate": 0, "spent": 0,
                                           "start": None, "end": None, "mine": [], "timer": None, "items": []})
        # every subtask, for the task tree on the card and the people counts
        s["items"].append({"id": c["id"], "title": c["title"], "status": c["status"] or "new", "due_at": c["due_at"],
                           "estimate": c["estimate_minutes"], "spent": c["spent"], "priority": c["priority"] or "normal",
                           "assignee": {"id": c["assignee_id"], "username": c["a_username"], "name": c["a_name"] or c["a_username"],
                                        "department": c["a_department"]} if c["assignee_id"] else None})
        s["total"] += 1
        s["done"] += c["status"] == "complete"
        s["canceled"] += c["status"] == "canceled"
        s["estimate"] += c["estimate_minutes"] or 0
        s["spent"] += c["spent"]
        if c["start_at"] and (not s["start"] or c["start_at"] < s["start"]):
            s["start"] = c["start_at"]
        if c["due_at"] and (not s["end"] or c["due_at"] > s["end"]):
            s["end"] = c["due_at"]
        if me is not None and c["assignee_id"] == me and c["status"] not in CLOSED:
            s["mine"].append({"id": c["id"], "title": c["title"], "status": c["status"], "priority": c["priority"],
                              "start_at": c["start_at"], "due_at": c["due_at"], "remind": c["remind"]})
    # subtasks below subtasks (L3, L4): for the radar / overdue counts and my reminders
    cur = await db.execute(f"""SELECT c.id, c.task_id, c.task_parent_id, c.title, c.status, c.start_at, c.due_at, c.assignee_id,
                                      c.priority, c.remind
                               FROM task_comments c WHERE c.task_id IN ({marks}) AND c.is_task = 1 AND c.task_parent_id IS NOT NULL
                               ORDER BY COALESCE(c.sort_order, c.id), c.id""", ids)
    for c in await cur.fetchall():
        s = out.get(c["task_id"])
        if s is None:
            continue
        s.setdefault("below", []).append({"id": c["id"], "parent": c["task_parent_id"], "title": c["title"],
                                          "status": c["status"] or "new", "due_at": c["due_at"]})
        if me is not None and c["assignee_id"] == me and (c["status"] or "new") not in CLOSED:
            s["mine"].append({"id": c["id"], "title": c["title"], "status": c["status"], "priority": c["priority"],
                              "start_at": c["start_at"], "due_at": c["due_at"], "remind": c["remind"]})
    # my running timer (standalone edition: the timer's user is NULL)
    if True:
        cur = await db.execute(f"""SELECT t.task_id, t.comment_id, c.title,
                                          CAST((julianday('now') - julianday(t.started_at)) * 86400 AS INTEGER) AS elapsed
                                   FROM task_time t JOIN task_comments c ON c.id = t.comment_id
                                   WHERE t.user_id IS ? AND t.ended_at IS NULL AND t.started_at IS NOT NULL AND t.task_id IN ({marks})""", (me, *ids))
        for r in await cur.fetchall():
            if r["task_id"] in out:
                out[r["task_id"]]["timer"] = {"subtask": r["comment_id"], "title": r["title"], "elapsed": r["elapsed"]}
    return out


def image_dict(im) -> dict:
    return {"id": im["id"], "name": im["name"], "kind": im["kind"], "size": im["size"],
            "url": f"/api/tasks/{im['task_id']}/images/{im['id']}"}


async def _one(db, task_id: int, user: dict) -> dict:
    return (await _enrich(db, [await _get(db, task_id)], user))[0]


# ----------------------------------------------------------- people on cards
MENTION_RE = re.compile(r"(?<![\w@])@([A-Za-z0-9._\-]{1,64})")


async def _resolve_people(db, usernames: List[str]) -> List[dict]:
    """Known active accounts by login name; AD accounts that never signed in are added (directory)."""
    out, seen = [], set()
    for raw in usernames[:20]:
        name = ldapauth.normalize(raw)
        if not name or name in seen:
            continue
        seen.add(name)
        cur = await db.execute("SELECT id, username, display_name, active, source FROM users WHERE username = ?", (name,))
        row = await cur.fetchone()
        if row is None and ldapauth.directory_enabled():
            info = await asyncio.get_running_loop().run_in_executor(None, ldapauth.lookup, name)
            if info:
                from .auth import upsert_ldap_user
                row = await upsert_ldap_user(db, info)
        if row is None and C.AUTH:                    # Microsoft Entra ID directory (read only)
            from .. import entra
            if entra.directory_enabled():
                try:
                    hits = await asyncio.get_running_loop().run_in_executor(None, entra.search_directory, name, 5)
                except entra.EntraError:
                    hits = []
                hit = next((h for h in hits if name in (h["username"], h["upn"].split("@")[0], h["sam"])), None)
                if hit:
                    cur = await db.execute("INSERT INTO users (username, source, display_name, email, department, role, active) "
                                           "VALUES (?, 'entra', ?, ?, ?, 'user', 1)", (hit["username"], hit["display_name"], hit["email"], hit["department"]))
                    cur = await db.execute("SELECT id, username, display_name, active, source FROM users WHERE id = ?", (cur.lastrowid,))
                    row = await cur.fetchone()
        if row is None and not C.AUTH:                # linked copy: ask the server's directory (AD) while online
            from .. import syncclient
            hit = next((p for p in await syncclient.remote_people(name) if (p.get("username") or "").lower() == name), None)
            if hit:
                cur = await db.execute("INSERT INTO users (username, source, display_name, department, role, active) "
                                       "VALUES (?, 'ldap', ?, ?, 'user', 1)", (hit["username"], hit.get("display_name"), hit.get("department")))
                cur = await db.execute("SELECT id, username, display_name, active, source FROM users WHERE id = ?", (cur.lastrowid,))
                row = await cur.fetchone()
        if row and row["active"] and row["source"] in ("ldap", "entra"):
            out.append(dict(row))
    return out


async def notify(db, user_ids, task_id: int, actor: dict, kind: str, text: str):
    for uid in {u for u in user_ids if u and u != actor.get("id")}:
        await db.execute("INSERT INTO notifications (user_id, task_id, actor_id, kind, text) VALUES (?, ?, ?, ?, ?)",
                         (uid, task_id, actor.get("id"), kind, text[:300]))


def _who(actor: dict) -> str:
    return actor.get("display_name") or actor.get("username") or "有人"


async def _members(db, task_id: int, role: str) -> set:
    cur = await db.execute("SELECT user_id FROM task_members WHERE task_id = ? AND role = ?", (task_id, role))
    return {r["user_id"] for r in await cur.fetchall()}


async def set_assignees(db, task_id: int, usernames: List[str], actor: dict, title: str):
    people = await _resolve_people(db, usernames)
    before = await _members(db, task_id, "assignee")
    after = {p["id"] for p in people}
    await db.execute("DELETE FROM task_members WHERE task_id = ? AND role = 'assignee'", (task_id,))
    for uid in after:
        await db.execute("INSERT OR IGNORE INTO task_members (task_id, user_id, role) VALUES (?, ?, 'assignee')", (task_id, uid))
    await notify(db, after - before, task_id, actor, "assigned", f"{_who(actor)} 把「{title}」指派給你")


async def add_mentions(db, task_id: int, text: Optional[str], actor: dict, title: str, where: str):
    names = MENTION_RE.findall(text or "")
    if not names:
        return
    people = await _resolve_people(db, names)
    before = await _members(db, task_id, "mention")
    for p in people:
        await db.execute("INSERT OR IGNORE INTO task_members (task_id, user_id, role) VALUES (?, ?, 'mention')", (task_id, p["id"]))
    await notify(db, {p["id"] for p in people} - before if where == "說明" else {p["id"] for p in people},
                 task_id, actor, "mention", f"{_who(actor)} 在「{title}」的{where}提到你")


# ---------------------------------------------------------------- endpoints
@router.get("")
async def list_tasks(request: Request):
    user = current_user(request)
    where, args = _visible_sql(user)
    db = await get_db()
    try:
        cur = await db.execute(f"SELECT {COLUMNS} FROM tasks t WHERE {where} ORDER BY sort_order, id", args)
        return await _enrich(db, [row_dict(r) for r in await cur.fetchall()], user)
    finally:
        await db.close()


def _snippet(text: str, kw: str, width: int = 60) -> str:
    text = " ".join((text or "").split())
    i = text.lower().find(kw.lower())
    if i < 0:
        return text[:width]
    start = max(0, i - width // 3)
    return ("…" if start else "") + text[start:start + width] + ("…" if start + width < len(text) else "")


class ExportIn(BaseModel):
    ids: List[int] = []                    # empty = every card I can see
    layout: str = "report"                 # kept for old clients; there is one layout now


@router.post("/export.xlsx")
async def export_xlsx(body: ExportIn, request: Request):
    """Selected cards (only ones this user may see) → a one-sheet progress report (card > subtasks / collaborators)."""
    from fastapi.responses import Response
    from .. import xlsx_export
    user = current_user(request)
    ids = list(dict.fromkeys(body.ids))[:2000]
    where, args = _visible_sql(user)
    db = await get_db()
    try:
        q = f"SELECT {COLUMNS} FROM tasks t WHERE {where}"
        if ids:
            q += f" AND t.id IN ({','.join('?' * len(ids))})"
        cur = await db.execute(q, (*args, *ids))
        rows = [row_dict(r) for r in await cur.fetchall()]
        if not rows:
            raise HTTPException(status_code=404, detail="沒有可以匯出的卡片")
        rows.sort(key=lambda r: (STATUSES.index(r["status"]) if r["status"] in STATUSES else 99, r["sort_order"] or 0, r["id"]))   # board order
        cards = await _enrich(db, rows, user)
        found = [c["id"] for c in cards]
        marks = ",".join("?" * len(found))
        cur = await db.execute(f"SELECT * FROM task_comments WHERE task_id IN ({marks}) ORDER BY id", found)
        comments, subtasks = {}, {}
        for c in await cur.fetchall():
            comments.setdefault(c["task_id"], []).append(c)
            if c["is_task"] and c["parent_id"] is None:
                subtasks.setdefault(c["task_id"], []).append(c)
        for lst in subtasks.values():
            lst.sort(key=lambda c: (c["sort_order"] if c["sort_order"] is not None else c["id"], c["id"]))
        all_subs = [c for lst in subtasks.values() for c in lst]
        dep_map = await deps_out(db, [c["deps"] for c in all_subs])
        sub_deps = {c["id"]: dep_map[c["deps"]] for c in all_subs if c["deps"] and dep_map.get(c["deps"])}
        cur = await db.execute(f"SELECT * FROM task_time WHERE task_id IN ({marks}) AND minutes IS NOT NULL", found)
        times = {}
        for e in await cur.fetchall():
            times.setdefault(e["task_id"], []).append(e)
        cur = await db.execute("SELECT id, username, display_name FROM users")
        names = {u["id"]: u["display_name"] or u["username"] for u in await cur.fetchall()}
        from .. import projects as pj
        analysis = await pj.analyze(db, found)
        pids = list({c["project_id"] for c in cards if c.get("project_id")})
        project_titles = {}
        if pids:
            cur = await db.execute(f"SELECT id, title FROM tasks WHERE id IN ({','.join('?' * len(pids))})", pids)
            project_titles = {r[0]: r[1] for r in await cur.fetchall()}
    finally:
        await db.close()
    from datetime import datetime
    author = user.get("display_name") or user.get("username") or ""
    import contextvars
    ctx = contextvars.copy_context()                   # the worker thread keeps the request's language
    data = await asyncio.get_running_loop().run_in_executor(
        None, lambda: ctx.run(xlsx_export.build_report, cards, subtasks, comments, times, names, author, sub_deps=sub_deps,
                              analysis=analysis, project_titles=project_titles))
    from .. import i18n
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    safe = re.sub(r'[\\/:*?"<>|\s]+', "_", cards[0]["title"])[:60]
    name = i18n.tr("工作進度報告-{0}.xlsx", stamp) if len(cards) > 1 else f"{safe}-{stamp}.xlsx"
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={
        "Content-Disposition": f"attachment; filename=\"report-{stamp}.xlsx\"; filename*=UTF-8''{quote(name)}",
        "Cache-Control": "no-store",
    })


# ------------------------------------------------------------------ Excel import (same report format)
IMPORT_MAX = 5 * 1024 * 1024
ZH = {"recurring": "週期工作", "overdue": "過期未結案", "new": "新建", "ongoing": "進行中", "pending": "待確認",
      "onhold": "暫緩", "complete": "完成", "canceled": "取消"}
PRIO_ZH = {"low": "低", "normal": "一般", "high": "高"}


class _People:
    def __init__(self, rows):
        self.by_id = {r["id"]: r for r in rows}
        self.rows = rows

    def name(self, uid):
        u = self.by_id.get(uid)
        return (u["display_name"] or u["username"]) if u else None

    def resolve(self, text: str):
        """'王小明' / 'usera' / '王小明 (usera)' → user row; raises ValueError."""
        t = (text or "").strip()
        m = re.search(r"[（(]\s*([^()（）]+?)\s*[)）]\s*$", t)
        if m:
            t = m.group(1)
        hits = [u for u in self.rows if (u["username"] or "").lower() == t.lower()]
        if not hits:
            hits = [u for u in self.rows if (u["display_name"] or "") == t]
        if not hits:
            hits = [u for u in self.rows if t and t in (u["display_name"] or "")]
        if len(hits) == 1:
            return hits[0]
        raise ValueError(f"找不到人員「{text}」" if not hits else f"「{text}」對應到多個帳號，請改寫帳號（例如 王小明 (usera)）")


def _diff(label, old, new, fmt=lambda v: v or "—"):
    return f"{label}：{fmt(old)} → {fmt(new)}"


async def _import_plan(items: List[dict], user: dict) -> List[dict]:
    """Decide what each row would do. Returns rows for the preview, each with a private '_op' for apply."""
    db = await get_db()
    try:
        cur = await db.execute("SELECT id, username, display_name FROM users WHERE COALESCE(active, 1) = 1")
        people = _People([dict(r) for r in await cur.fetchall()])
        acc = board_access(user)
        can_assign = user.get("id") is None or acc["edit"] in ("all", "dept") or acc["team_edit"]
        me = user.get("id")
        plan, ctx = [], None
        # which cards get subtasks in this file (their status is computed, not imported)
        has_sub_rows = set()
        owner = None
        for it in items:
            if it["kind"] == "card":
                owner = it["row"]
            elif it["kind"] == "sub" and owner:
                has_sub_rows.add(owner)
        by_num = {}                                    # 編號 → index in plan (for 前置任務 and parents)
        for it in items:
            out = {"row": it["row"], "kind": it["kind"], "title": it.get("title") or "", "action": "unchanged",
                   "changes": [], "warnings": [], "errors": list(it["errors"]), "_op": None}
            plan.append(out)
            if it.get("num") and it["kind"] != "collab":
                by_num.setdefault(it["num"], len(plan) - 1)
            if it.get("id") and it["kind"] in ("card", "sub"):
                out["id"] = ("T" if it["kind"] == "card" else "S") + str(it["id"])
            person = None
            if it.get("person"):
                try:
                    person = people.resolve(it["person"])
                except ValueError as e:
                    # someone this system does not know (a file from another site): the row is still imported, unassigned
                    (out["errors"] if it["kind"] == "collab" else out["warnings"]).append(str(e) + ("" if it["kind"] == "collab" else "，這一列不指派負責人"))
            if it["kind"] == "card":
                ctx = {"row": it["row"], "id": None, "error": False, "subs": {}, "members": {}, "edit": True, "summary": False,
                       "index": len(plan) - 1}
                if it["id"]:
                    try:
                        t = await _get_visible(db, it["id"], user)
                    except HTTPException:
                        out["errors"].append(f"找不到卡片 T{it['id']}，或你沒有權限看")
                        t = None
                    if t:
                        ctx.update(id=t["id"], edit=await _can_edit(db, t["id"], user))
                        cur = await db.execute("""SELECT id, title, status, priority, start_at, due_at, assignee_id, estimate_minutes, milestone
                                                  FROM task_comments WHERE task_id = ? AND is_task = 1 AND parent_id IS NULL""", (t["id"],))
                        ctx["subs"] = {r["id"]: dict(r) for r in await cur.fetchall()}
                        cur = await db.execute("SELECT user_id, role, done_at FROM task_members WHERE task_id = ? AND role IN ('assignee', 'mention')", (t["id"],))
                        for r in await cur.fetchall():
                            ctx["members"].setdefault(r["user_id"], {"roles": set(), "done": bool(r["done_at"])})["roles"].add(r["role"])
                        ctx["summary"] = any((s["status"] or "new") != "canceled" for s in ctx["subs"].values()) or it["row"] in has_sub_rows
                        out["title"] = it["title"] or t["title"]
                        changes = {}
                        if it["title"] and it["title"] != t["title"]:
                            changes["title"] = it["title"]; out["changes"].append(_diff("名稱", t["title"], it["title"]))
                        if it.get("priority") and it["priority"] != t["priority"]:
                            changes["priority"] = it["priority"]; out["changes"].append(_diff("優先", PRIO_ZH.get(t["priority"]), PRIO_ZH[it["priority"]]))
                        for k, label in (("start_at", "開始"), ("due_at", "到期")):
                            if it.get(k) and it[k] != (t[k] or ""):
                                changes[k] = it[k]; out["changes"].append(_diff(label, t[k], it[k]))
                        if it.get("card_kind") and it["card_kind"] != (t.get("kind") or "ops"):
                            changes["kind"] = it["card_kind"]
                            out["changes"].append(_diff("類型", "專案" if t.get("kind") == "project" else "一般", "專案" if it["card_kind"] == "project" else "一般"))
                        if it.get("milestone") is not None and it["milestone"] != bool(t.get("milestone")):
                            changes["milestone"] = it["milestone"]; out["changes"].append(_diff("里程碑", "是" if t.get("milestone") else "否", "是" if it["milestone"] else "否"))
                            changes.pop("start_at", None)
                        if it.get("status") and it["status"] != t["status"]:
                            changes["status"] = it["status"]; out["changes"].append(_diff("狀態", ZH.get(t["status"]), ZH.get(it["status"])))
                            if ctx["summary"]:
                                out["warnings"].append("有子任務的卡片：之後子任務有變動時，狀態會再依子任務自動更新")
                        if it.get("tags") is not None:
                            try:
                                new_tags = _tags(it["tags"]) or []
                            except ValueError as e:
                                out["errors"].append(str(e)); new_tags = None
                            old_tags = tags_list(t.get("tags"))
                            if new_tags is not None and [x.lower() for x in new_tags] != [x.lower() for x in old_tags]:
                                changes["tags"] = new_tags
                                out["changes"].append(_diff("標籤", "、".join(old_tags), "、".join(new_tags)))
                        if person and person["id"] not in ctx["members"] and person["id"] != t["owner_id"]:
                            out["warnings"].append("主責人變更請在系統內調整，負責人欄已略過")
                        if changes and not ctx["edit"]:
                            out["errors"].append("你沒有權限修改這張卡片")
                        elif changes:
                            out["action"], out["_op"] = "update", ("card_update", t["id"], changes)
                else:
                    fields = {"title": it["title"]}
                    for k in ("priority", "start_at", "due_at"):
                        if it.get(k):
                            fields[k] = it[k]
                    if it.get("milestone"):
                        fields["milestone"] = True
                        out["changes"].append("里程碑")
                    if it.get("card_kind") == "project":
                        fields["kind"] = "project"
                        out["changes"].append("專案")
                    if it.get("tags"):
                        try:
                            fields["tags"] = _tags(it["tags"])
                            out["changes"].append("標籤：" + "、".join(fields["tags"]))
                        except ValueError as e:
                            out["errors"].append(str(e))
                    if it.get("status"):
                        if it["row"] in has_sub_rows and it["status"] != "canceled":
                            out["warnings"].append("有子任務的卡片狀態依子任務自動計算")
                        else:
                            fields["status"] = it["status"]
                    if person:
                        if can_assign:
                            fields["assignees"] = [person["username"]]
                            out["changes"].append(f"負責人：{people.name(person['id'])}")
                        elif person["id"] != me:
                            out["warnings"].append("你沒有指派權限，卡片會指派給你自己")
                    out["action"], out["_op"] = "create", ("card_create", fields)
                    out["changes"][:0] = [f"{ZH.get(fields.get('status', 'new'))}" + (f"，到期 {fields['due_at']}" if fields.get("due_at") else "")]
                if out["errors"]:
                    ctx["error"] = True
                continue
            # ---- children
            if ctx is None:
                out["errors"].append("這一列前面沒有主任務")
                continue
            if ctx["error"]:
                out["action"] = "skip"
                out["warnings"].append(f"所屬主任務（第 {ctx['row']} 列）有錯誤，略過")
                continue
            if it["kind"] == "sub":
                fields = {}
                if it["id"]:
                    s = ctx["subs"].get(it["id"])
                    if not s:
                        out["errors"].append(f"S{it['id']} 不是這張卡片的子任務")
                        continue
                    out["title"] = it["title"] or s["title"]
                    if it["title"] and it["title"] != s["title"]:
                        fields["title"] = it["title"]; out["changes"].append(_diff("名稱", s["title"], it["title"]))
                    if it.get("status") and it["status"] != (s["status"] or "new"):
                        fields["status"] = it["status"]; out["changes"].append(_diff("狀態", ZH.get(s["status"] or "new"), ZH.get(it["status"])))
                    if it.get("priority") and it["priority"] != (s["priority"] or "normal"):
                        fields["priority"] = it["priority"]; out["changes"].append(_diff("優先", PRIO_ZH.get(s["priority"] or "normal"), PRIO_ZH[it["priority"]]))
                    for k, label in (("start_at", "開始"), ("due_at", "到期")):
                        if it.get(k) and it[k] != (s[k] or ""):
                            fields[k] = it[k]; out["changes"].append(_diff(label, s[k], it[k]))
                    if it.get("milestone") is not None and it["milestone"] != bool(s["milestone"]):
                        fields["milestone"] = it["milestone"]; out["changes"].append(_diff("里程碑", "是" if s["milestone"] else "否", "是" if it["milestone"] else "否"))
                        fields.pop("start_at", None)
                    if "estimate_minutes" in it and (it["estimate_minutes"] or None) != (s["estimate_minutes"] or None):
                        fields["estimate_minutes"] = it["estimate_minutes"]
                        out["changes"].append(_diff("預估", s["estimate_minutes"] and f"{s['estimate_minutes'] / 60:g}h", it["estimate_minutes"] and f"{it['estimate_minutes'] / 60:g}h"))
                    if person and person["id"] != s["assignee_id"]:
                        fields["assignee"] = person["username"]; out["changes"].append(_diff("負責人", people.name(s["assignee_id"]), people.name(person["id"])))
                    if fields and not (ctx["edit"] or s["assignee_id"] == me) or ("assignee" in fields and not ctx["edit"]):
                        out["errors"].append("你沒有權限修改這個子任務")
                    elif fields:
                        out["action"], out["_op"] = "update", ("sub_update", it["id"], fields)
                else:
                    parent = None
                    if it.get("depth", 1) >= 2:
                        if it["depth"] > SUB_MAX_DEPTH:
                            out["errors"].append("最多四層（主卡＋三層子任務），編號最多四段，例如 1.2.3.4")
                            continue
                        pnum = (it.get("num") or "").rsplit(".", 1)[0]
                        pi = by_num.get(pnum)
                        if pi is None or plan[pi]["kind"] != "sub" or pi < ctx["index"]:
                            out["errors"].append(f"找不到上一層子任務（編號 {pnum}）：上一層要寫在這一列之前")
                            continue
                        parent = pi
                    if ctx["id"] and not ctx["edit"]:
                        out["errors"].append("你沒有權限在這張卡片加子任務")
                        continue
                    fields = {k: it[k] for k in ("status", "priority", "start_at", "due_at", "estimate_minutes", "milestone") if it.get(k)}
                    if person:
                        fields["assignee"] = person["username"]
                    out["action"], out["_op"] = "create", ("sub_create", it["title"], fields, parent)
                    out["changes"].append("、".join(x for x in [ZH.get(fields.get("status", "new")), person and f"負責人 {people.name(person['id'])}",
                                                                 fields.get("due_at") and f"到期 {fields['due_at']}"] if x))
                continue
            # collaborator
            uid = it["id"] or (person and person["id"])
            if not uid:
                out["errors"].append("協作列需要負責人（人員）或系統ID")
                continue
            out["title"] = f"協作：{people.name(uid) or uid}"
            m = ctx["members"].get(uid)
            if m:
                if it.get("done") is not None and it["done"] != m["done"]:
                    out["changes"].append("標記為完成" if it["done"] else "改回未完成")
                    if not (ctx["edit"] or uid == me):
                        out["errors"].append("只有協作人自己或能編輯卡片的人可以改")
                    else:
                        out["action"], out["_op"] = "update", ("collab_done", uid, it["done"])
            elif it["id"] and ctx["id"]:
                out["errors"].append(f"C{it['id']} 不是這張卡片的協作人")
            else:
                if not can_assign:
                    out["errors"].append("你沒有指派權限，無法加入協作人（可在卡片說明用 @帳號）")
                    continue
                out["action"], out["_op"] = "create", ("collab_add", people.by_id[uid]["username"], uid, bool(it.get("done")))
                out["changes"].append("加入為共同負責" + ("，標記完成" if it.get("done") else ""))
        # 前置任務: by the numbers of rows in this file
        uid_of = {}
        for idx, (o, it) in enumerate(zip(plan, items)):
            if it.get("deps") is None or it["kind"] == "collab" or o["errors"] or o["action"] == "skip":
                continue
            if it.get("deps_other"):
                if it["deps"]:
                    o["warnings"].append("前置任務含有檔案外的項目（「…」），前置任務維持不變")
                continue
            refs, bad = [], []
            for num, lag in it["deps"]:
                j = by_num.get(num)
                if j is None or j == idx:
                    bad.append(num)
                else:
                    refs.append((j, lag))
            if bad:
                o["warnings"].append("前置任務的編號找不到，已略過：" + "、".join(bad))
            if it.get("id"):                              # unchanged predecessors are not a change
                want = []
                for j, lag in refs:
                    ref = plan[j].get("id")
                    if not ref:
                        want = None
                        break
                    if ref not in uid_of:
                        tbl = "tasks" if ref[0] == "T" else "task_comments"
                        cur = await db.execute(f"SELECT uid FROM {tbl} WHERE id = ?", (int(ref[1:]),))
                        r = await cur.fetchone()
                        uid_of[ref] = r[0] if r else None
                    want.append({"u": uid_of[ref], "lag": lag})
                tbl = "tasks" if it["kind"] == "card" else "task_comments"
                cur = await db.execute(f"SELECT deps FROM {tbl} WHERE id = ?", (it["id"],))
                r = await cur.fetchone()
                try:
                    have = [{"u": d["u"], "lag": int(d.get("lag") or 0)} for d in json.loads(r[0])] if r and r[0] else []
                except (ValueError, TypeError, KeyError):
                    have = []
                if want is not None and sorted(map(json.dumps, want)) == sorted(map(json.dumps, have)):
                    continue
            o["_deps"] = refs
            o["changes"].append("前置：" + ("、".join(items[j].get("num") + (f"（{'+' if lag > 0 else ''}{lag} 天）" if lag else "") for j, lag in refs) or "（清除）"))
            if o["action"] == "unchanged":
                o["action"] = "update"
        for o in plan:
            if o["errors"]:
                o["action"], o["_op"] = "error", None
                o.pop("_deps", None)
        return plan
    finally:
        await db.close()


async def _import_apply(plan: List[dict], request: Request):
    card_id = None
    for o in plan:
        op = o["_op"]
        if o["kind"] == "card":
            card_id = None
        try:
            if o["kind"] == "card":
                if op and op[0] == "card_create":
                    card_id = (await create_task(TaskIn(**op[1]), request))["id"]
                    o["id"] = f"T{card_id}"
                else:
                    if op:
                        await update_task(op[1], TaskUpdate(**op[2]), request)
                    card_id = int(o.get("_card") or 0) or (op[1] if op else None)
                o["_cardid"] = card_id
                if op:
                    o["done"] = True
                continue
            o["_cardid"] = card_id
            if not op:
                continue
            if card_id is None:
                raise HTTPException(status_code=400, detail="所屬主任務沒有建立")
            if op[0] == "sub_create":
                if op[3] is not None:                    # below another subtask of this file
                    pid = plan[op[3]].get("id")
                    if not pid:
                        raise HTTPException(status_code=400, detail="上一層子任務沒有建立")
                    cid = (await create_subtask(card_id, SubtaskNew(title=op[1], parent=int(pid[1:])), request))["id"]
                    await update_subtask(card_id, cid, SubtaskIn(**op[2]), request)
                else:
                    cid = (await add_comment(card_id, CommentIn(body=op[1]), request))["id"]
                    await update_subtask(card_id, cid, SubtaskIn(is_task=True, title=op[1], **op[2]), request)
                o["id"] = f"S{cid}"
            elif op[0] == "sub_update":
                await update_subtask(card_id, op[1], SubtaskIn(**op[2]), request)
            elif op[0] == "collab_done":
                await collab_done(card_id, op[1], CollabDoneIn(done=op[2]), request)
            elif op[0] == "collab_add":
                db = await get_db()
                try:
                    cur = await db.execute("""SELECT u.username FROM task_members m JOIN users u ON u.id = m.user_id
                                              WHERE m.task_id = ? AND m.role = 'assignee' ORDER BY m.created_at""", (card_id,))
                    current = [r[0] for r in await cur.fetchall()]
                finally:
                    await db.close()
                await update_task(card_id, TaskUpdate(assignees=current + [op[1]]), request)
                if op[3]:
                    await collab_done(card_id, op[2], CollabDoneIn(done=True), request)
            o["done"] = True
        except HTTPException as e:
            o["action"] = "error"
            o["errors"].append(str(e.detail))
            o["done"] = False
    # predecessors last: every row they point to exists by now
    for o in plan:
        if "_deps" not in o or o["action"] == "error" or not o.get("id") or not o.get("_cardid"):
            continue
        deps = [DepIn(key=("t:" if plan[j]["id"][0] == "T" else "s:") + plan[j]["id"][1:], lag=lag)
                for j, lag in o["_deps"] if plan[j].get("id") and plan[j]["action"] != "error"]
        try:
            if o["kind"] == "card":
                await update_task(o["_cardid"], TaskUpdate(deps=deps), request)
            else:
                await update_subtask(o["_cardid"], int(o["id"][1:]), SubtaskIn(deps=deps), request)
            o["done"] = True
        except HTTPException as e:
            o["warnings"].append("前置任務沒有設定：" + str(e.detail))


@router.post("/import.xlsx")
async def import_xlsx(request: Request, file: UploadFile = File(...), apply: bool = Form(False)):
    """Read a report made by export.xlsx (possibly edited): apply=false → preview what would change;
    apply=true → do it. Rows with 系統ID update those items, rows without one are created."""
    from .. import xlsx_export
    current_user(request)
    data = await file.read(IMPORT_MAX + 1)
    if len(data) > IMPORT_MAX:
        raise HTTPException(status_code=400, detail="檔案太大（上限 5 MB）")
    try:
        items = await asyncio.get_running_loop().run_in_executor(None, xlsx_export.parse, data)
    except xlsx_export.ImportError_ as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not items:
        raise HTTPException(status_code=400, detail="檔案裡沒有任何項目")
    user = current_user(request)
    plan = await _import_plan(items, user)
    # remember which existing card each child belongs to (apply walks the rows in order)
    for o, it in zip(plan, items):
        if it["kind"] == "card" and it.get("id"):
            o["_card"] = it["id"]
    if apply:
        await _import_apply(plan, request)
    counts = {}
    for o in plan:
        counts[o["action"]] = counts.get(o["action"], 0) + 1
    return {"applied": apply, "counts": counts,
            "rows": [{k: v for k, v in o.items() if not k.startswith("_")} for o in plan]}


# ------------------------------------------------------------------ projects
def can_rank(user: dict) -> bool:
    """Who sets the projects' order of importance: board administrators and department managers."""
    return board_access(user)["edit"] in ("all", "dept")


async def _project_fields(db, task_id: int, cur: dict, changes: dict, user: dict):
    """Validate kind / project_id in changes (in place). A project belongs to no other project;
    an ops card may belong to one project the user can see."""
    kind = changes.get("kind", cur.get("kind") or "ops")
    if "project_id" in changes:
        pid = changes["project_id"] or None
        if pid:
            if pid == task_id:
                raise HTTPException(status_code=400, detail="卡片不能歸屬自己")
            p = await _get_visible(db, pid, user)
            if (p.get("kind") or "ops") != "project":
                raise HTTPException(status_code=400, detail="只能歸屬到「專案」類型的卡片")
        changes["project_id"] = pid
    if kind == "project":
        if changes.get("project_id") or (cur.get("project_id") and "project_id" not in changes):
            changes["project_id"] = None                        # a project is not part of another project
        if (cur.get("kind") or "ops") != "project" and cur.get("rank") is None:
            cur2 = await db.execute("SELECT COALESCE(MAX(rank), 0) + 1 FROM tasks WHERE kind = 'project'")
            changes["rank"] = (await cur2.fetchone())[0]
    if (cur.get("kind") or "ops") == "project" and kind == "ops":
        # back to an ops card: the cards that belonged to it are let go
        await db.execute("UPDATE tasks SET project_id = NULL WHERE project_id = ?", (task_id,))


class OrderIds(BaseModel):
    ids: List[int]


@router.post("/projects/order")
async def order_projects(body: OrderIds, request: Request):
    """Order of importance of the projects (most important first); projects not sent keep their order after them."""
    user = current_user(request)
    if not can_rank(user):
        raise HTTPException(status_code=403, detail="專案排序由看板管理員或部門主管調整")
    db = await get_db()
    try:
        where, args = _visible_sql(user)
        cur = await db.execute(f"SELECT t.id FROM tasks t WHERE t.kind = 'project' AND {where} ORDER BY COALESCE(t.rank, 1e9), t.id", args)
        mine = [r[0] for r in await cur.fetchall()]
        cur = await db.execute("SELECT id FROM tasks WHERE kind = 'project' AND id NOT IN (%s) ORDER BY COALESCE(rank, 1e9), id"
                               % (",".join("?" * len(mine)) or "NULL"), mine)
        others = [r[0] for r in await cur.fetchall()]
        sent = [i for i in dict.fromkeys(body.ids) if i in mine]
        order = sent + [i for i in mine if i not in sent] + others
        for n, i in enumerate(order, start=1):
            await db.execute("UPDATE tasks SET rank = ? WHERE id = ? AND COALESCE(rank, -1) != ?", (n, i, n))
        await db.commit()
        return {"order": order}
    finally:
        await db.close()


@router.get("/projects/analysis")
async def projects_analysis(request: Request):
    """Projects' health, every problem, people load and shared windows for the cards the viewer can see
    (one computation for the radar, the alert list, the project pages and the Excel report)."""
    from .. import projects as pj
    user = current_user(request)
    where, args = _visible_sql(user)
    db = await get_db()
    try:
        cur = await db.execute(f"SELECT t.id FROM tasks t WHERE {where}", args)
        ids = [r[0] for r in await cur.fetchall()]
        out = await pj.analyze(db, ids)
        out["can_rank"] = can_rank(user)
        return out
    finally:
        await db.close()


class WatchIn(BaseModel):
    mode: str

    @field_validator("mode")
    @classmethod
    def v_mode(cls, v):
        if v not in ("all", "mine", "digest", "off", "default"):
            raise ValueError("通知模式只能是 all / mine / digest / off")
        return v


@router.get("/{task_id}/watch")
async def get_watch(task_id: int, request: Request):
    """My notification mode for a project (全部 / 只跟我有關 / 每日摘要 / 關閉) and whether it is the default."""
    from .. import projects as pj
    user = current_user(request)
    db = await get_db()
    try:
        t = await _get_visible(db, task_id, user)
        if (t.get("kind") or "ops") != "project":
            raise HTTPException(status_code=400, detail="只有專案可以設定通知")
        mode, default = await pj.watch_mode(db, task_id, user.get("id"))
        return {"mode": mode, "default": default, "lead": user.get("id") in await pj.leads_of(db, task_id)}
    finally:
        await db.close()


@router.put("/{task_id}/watch")
async def set_watch(task_id: int, body: WatchIn, request: Request):
    """Set (or, with "default", clear) my notification mode for a project."""
    from .. import projects as pj
    user = current_user(request)
    if user.get("id") is None:
        raise HTTPException(status_code=400, detail="請先登入")
    db = await get_db()
    try:
        t = await _get_visible(db, task_id, user)
        if (t.get("kind") or "ops") != "project":
            raise HTTPException(status_code=400, detail="只有專案可以設定通知")
        if body.mode == "default":
            await db.execute("DELETE FROM task_watch WHERE task_id = ? AND user_id = ?", (task_id, user["id"]))
        else:
            await db.execute("""INSERT INTO task_watch (task_id, user_id, mode) VALUES (?, ?, ?)
                                ON CONFLICT(task_id, user_id) DO UPDATE SET mode = excluded.mode, updated_at = CURRENT_TIMESTAMP""",
                             (task_id, user["id"], body.mode))
        await db.commit()
        mode, default = await pj.watch_mode(db, task_id, user["id"])
        return {"mode": mode, "default": default}
    finally:
        await db.close()


@router.post("/projects/events/run")
async def run_project_events(request: Request):
    """Admin: send today's project notifications now (normally once a day at the daily reminder time)."""
    from .. import projects as pj
    user = current_user(request)
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="只有管理員可以執行")
    db = await get_db()
    try:
        n = await pj.daily_events(db)
        await db.commit()
        return {"sent": n}
    finally:
        await db.close()


@router.get("/projects/suspected")
async def suspected_projects(request: Request):
    """Everyday cards that look like projects (baseline, predecessors, a third level of subtasks, or many subtasks)."""
    user = current_user(request)
    where, args = _visible_sql(user)
    db = await get_db()
    try:
        cur = await db.execute(f"""SELECT t.id, t.title,
                (t.base_due IS NOT NULL OR t.base_start IS NOT NULL) AS has_base,
                (t.deps IS NOT NULL OR EXISTS (SELECT 1 FROM task_comments c WHERE c.task_id = t.id AND c.deps IS NOT NULL)) AS has_deps,
                EXISTS (SELECT 1 FROM task_comments c WHERE c.task_id = t.id AND c.task_parent_id IS NOT NULL) AS deep,
                (SELECT COUNT(*) FROM task_comments c WHERE c.task_id = t.id AND c.is_task = 1) AS subs
            FROM tasks t WHERE COALESCE(t.kind, 'ops') = 'ops' AND t.status NOT IN ('complete', 'canceled') AND {where}""", args)
        out = []
        for r in await cur.fetchall():
            why = [w for w, on in (("有基準線", r["has_base"]), ("有前置任務", r["has_deps"]), ("有三層以上子任務", r["deep"]),
                                   (f"{r['subs']} 個子任務", r["subs"] >= 10)) if on]
            if why:
                out.append({"id": r["id"], "title": r["title"], "why": why})
        return out
    finally:
        await db.close()


# ------------------------------------------------------------------ Gantt
DEP_RE = re.compile(r"^([ts]):(\d+)$")


async def _uid_of(db, kind: str, rid: int, user: dict):
    """(uid, card id) of a card ("t") or subtask ("s") the user can see; 400 if there is none."""
    if kind == "t":
        cur = await db.execute("SELECT uid, id FROM tasks WHERE id = ?", (rid,))
    else:
        cur = await db.execute("SELECT uid, task_id FROM task_comments WHERE id = ? AND is_task = 1", (rid,))
    r = await cur.fetchone()
    if not r or not r[0]:
        raise HTTPException(status_code=400, detail="找不到這個前置任務")
    await _get_visible(db, r[1], user)
    return r[0]


async def deps_in(db, deps, me: tuple, user: dict) -> Optional[str]:
    """Predecessors from the API ([{key, lag}]) to what is stored: uids, which mean the same row on the
    server and every copy. Refuses itself and loops."""
    if not deps:
        return None
    my_uid = await _uid_of(db, me[0], me[1], user)
    out, seen = [], set()
    for d in deps[:20]:
        m = DEP_RE.match(d.key or "")
        if not m:
            raise HTTPException(status_code=400, detail="前置任務格式不正確")
        uid = await _uid_of(db, m.group(1), int(m.group(2)), user)
        if uid == my_uid:
            raise HTTPException(status_code=400, detail="不能把自己設為前置任務")
        if uid not in seen:
            seen.add(uid)
            out.append({"u": uid, "lag": d.lag})
    # no loops: walk the predecessors of the new predecessors
    graph = {}
    for table in ("tasks", "task_comments"):
        cur = await db.execute(f"SELECT uid, deps FROM {table} WHERE deps IS NOT NULL")
        for r in await cur.fetchall():
            try:
                graph[r[0]] = [x["u"] for x in json.loads(r[1]) if isinstance(x, dict)]
            except (ValueError, TypeError):
                pass
    graph[my_uid] = [x["u"] for x in out]
    stack, visited = list(graph[my_uid]), set()
    while stack:
        u = stack.pop()
        if u == my_uid:
            raise HTTPException(status_code=400, detail="前置任務會形成循環（A 等 B、B 又等 A）")
        if u not in visited:
            visited.add(u)
            stack.extend(graph.get(u, []))
    return json.dumps(out) if out else None


async def deps_out(db, raws) -> dict:
    """Stored predecessors → [{key, lag, title, card}] for the viewer (rows that no longer exist drop out)."""
    parsed, uids = {}, set()
    for raw in raws:
        if not raw or raw in parsed:
            continue
        try:
            lst = [x for x in json.loads(raw) if isinstance(x, dict) and x.get("u")]
        except (ValueError, TypeError):
            lst = []
        parsed[raw] = lst
        uids |= {x["u"] for x in lst}
    if not uids:
        return {}
    where = {}
    part = list(uids)
    for i in range(0, len(part), 400):
        chunk = part[i:i + 400]
        marks = ",".join("?" * len(chunk))
        cur = await db.execute(f"SELECT uid, id, title FROM tasks WHERE uid IN ({marks})", chunk)
        for r in await cur.fetchall():
            where[r[0]] = {"key": f"t:{r[1]}", "title": r[2], "card": r[1]}
        cur = await db.execute(f"SELECT uid, id, title, task_id FROM task_comments WHERE is_task = 1 AND uid IN ({marks})", chunk)
        for r in await cur.fetchall():
            where[r[0]] = {"key": f"s:{r[1]}", "title": r[2], "card": r[3]}
    return {raw: [{**where[x["u"]], "lag": int(x.get("lag") or 0)} for x in lst if x["u"] in where]
            for raw, lst in parsed.items()}


@router.get("/gantt")
async def gantt(request: Request):
    """Every subtask (all levels) of the cards the viewer can see, with the Gantt fields.
    The cards themselves come from GET /api/tasks (same fields)."""
    user = current_user(request)
    me = user.get("id")
    where, args = _visible_sql(user)
    db = await get_db()
    try:
        cur = await db.execute(f"""SELECT c.id, c.task_id, c.task_parent_id, c.title, c.status, c.priority, c.start_at, c.due_at,
                                          c.milestone, c.deps, c.base_start, c.base_due, c.started_at, c.completed_at, c.win,
                                          c.estimate_minutes, c.sort_order, c.assignee_id, u.username, u.display_name,
                                          (SELECT COALESCE(SUM(minutes), 0) FROM task_time tt WHERE tt.comment_id = c.id) AS spent
                                   FROM task_comments c JOIN tasks t ON t.id = c.task_id LEFT JOIN users u ON u.id = c.assignee_id
                                   WHERE c.is_task = 1 AND c.parent_id IS NULL AND {where}
                                   ORDER BY c.task_id, COALESCE(c.sort_order, c.id), c.id""", args)
        rows = [dict(r) for r in await cur.fetchall()]
        dep_map = await deps_out(db, [r["deps"] for r in rows])
        by = {r["id"]: r for r in rows}

        def owners(cid):
            got, n = set(), 0
            while cid in by and n < 10:
                if by[cid]["assignee_id"] is not None:
                    got.add(by[cid]["assignee_id"])
                cid, n = by[cid]["task_parent_id"], n + 1
            return got
        return [{"id": r["id"], "card": r["task_id"], "parent": r["task_parent_id"], "title": r["title"],
                 "status": r["status"] or "new", "priority": r["priority"] or "normal",
                 "start_at": r["start_at"], "due_at": r["due_at"], "milestone": bool(r["milestone"]),
                 "deps": dep_map.get(r["deps"] or "", []), "base_start": r["base_start"], "base_due": r["base_due"],
                 "started_at": r["started_at"], "completed_at": r["completed_at"], "estimate": r["estimate_minutes"],
                 "spent": r["spent"], "assignee": {"id": r["assignee_id"], "username": r["username"],
                                                    "name": r["display_name"] or r["username"]} if r["assignee_id"] else None,
                 "win": r["win"], "mine_edit": me is not None and me in owners(r["id"])} for r in rows]
    finally:
        await db.close()


class BaselineIn(BaseModel):
    clear: bool = False


@router.post("/{task_id}/baseline")
async def set_baseline(task_id: int, body: BaselineIn, request: Request):
    """Save the card's and all its subtasks' current dates as the planned dates (or clear them)."""
    user = current_user(request)
    db = await get_db()
    try:
        await _get_visible(db, task_id, user)
        await _require_edit(db, task_id, user)
        if body.clear:
            await db.execute("UPDATE tasks SET base_start = NULL, base_due = NULL WHERE id = ?", (task_id,))
            await db.execute("UPDATE task_comments SET base_start = NULL, base_due = NULL WHERE task_id = ? AND is_task = 1", (task_id,))
        else:
            await db.execute("UPDATE tasks SET base_start = COALESCE(start_at, due_at), base_due = due_at WHERE id = ?", (task_id,))
            await db.execute("""UPDATE task_comments SET base_start = COALESCE(start_at, due_at), base_due = due_at
                                WHERE task_id = ? AND is_task = 1""", (task_id,))
        await db.execute("UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (task_id,))
        await db.commit()
        return await _one(db, task_id, user)
    finally:
        await db.close()


@router.get("/tags")
async def list_tags(request: Request):
    """Labels used on cards the viewer can see (most used first) — suggestions in the editor."""
    user = current_user(request)
    where, args = _visible_sql(user)
    db = await get_db()
    try:
        cur = await db.execute(f"SELECT t.tags FROM tasks t WHERE t.tags IS NOT NULL AND {where}", args)
        counts, names = {}, {}
        for r in await cur.fetchall():
            for x in tags_list(r[0]):
                counts[x.lower()] = counts.get(x.lower(), 0) + 1
                names.setdefault(x.lower(), x)
        return [{"name": names[k], "count": c} for k, c in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]
    finally:
        await db.close()


@router.get("/search")
async def search_tasks(request: Request, q: str = "", limit: int = 30):
    """Cards the viewer may see whose title, description, comments or people match q."""
    user = current_user(request)
    kw = q.strip()[:100]
    if not kw:
        return []
    like = "%" + kw.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    where, args = _visible_sql(user)
    db = await get_db()
    try:
        cur = await db.execute(f"""
            SELECT t.id, t.title, t.description, t.status, t.due_at, t.updated_at, t.tags,
                   (SELECT COALESCE(c.title || '：', '') || c.body FROM task_comments c WHERE c.task_id = t.id AND (c.body LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\')
                     ORDER BY c.id DESC LIMIT 1) AS hit_comment,
                   (SELECT COALESCE(u.display_name, u.username) FROM users u
                     WHERE (u.id = t.owner_id OR u.id IN (SELECT m.user_id FROM task_members m WHERE m.task_id = t.id))
                       AND (u.display_name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\') LIMIT 1) AS hit_person
            FROM tasks t WHERE {where}""", (like, like, like, like, *args))
        out = []
        low = kw.lower()
        for r in await cur.fetchall():
            title = r["title"] or ""
            if title.lower() == low:
                score, field, snip = 100, "標題", ""
            elif title.lower().startswith(low):
                score, field, snip = 80, "標題", ""
            elif low in title.lower():
                score, field, snip = 60, "標題", ""
            elif any(low.lstrip("#＃") == x.lower() for x in tags_list(r["tags"])):
                score, field, snip = 70, "標籤", "#" + next(x for x in tags_list(r["tags"]) if x.lower() == low.lstrip("#＃"))
            elif low in (r["description"] or "").lower():
                score, field, snip = 40, "說明", _snippet(r["description"], kw)
            elif any(low.lstrip("#＃") in x.lower() for x in tags_list(r["tags"])):
                score, field, snip = 35, "標籤", "、".join("#" + x for x in tags_list(r["tags"]))
            elif r["hit_comment"]:
                score, field, snip = 30, "留言", _snippet(r["hit_comment"], kw)
            elif r["hit_person"]:
                score, field, snip = 20, "人員", r["hit_person"]
            else:
                continue
            if r["status"] in ("complete", "canceled"):
                score -= 5                                  # open work first
            out.append({"id": r["id"], "title": title, "status": r["status"], "due_at": r["due_at"],
                        "match": field, "snippet": snip, "score": score, "updated_at": r["updated_at"]})
        out.sort(key=lambda x: (-x["score"], -(x["id"])))
        return out[:max(1, min(limit, 100))]
    finally:
        await db.close()


@router.post("")
async def create_task(t: TaskIn, request: Request):
    user = current_user(request)
    _check_dates(t.start_at, t.due_at, t.repeat)
    repeat = _monthly_anchor(t.repeat, t.due_at)
    db = await get_db()
    try:
        cur = await db.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM tasks WHERE status = ?", (t.status,))
        order = (await cur.fetchone())["n"]
        cur = await db.execute(
            """INSERT INTO tasks (title, description, status, priority, start_at, due_at, remind, repeat, repeat_every,
                                  sort_order, owner_id, completed_at, tags)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'complete' THEN CURRENT_TIMESTAMP END, ?)""",
            (t.title, t.description, t.status, t.priority, t.start_at, t.due_at, t.remind, repeat, t.repeat_every or 1,
             order, user.get("id"), t.status, tags_json(t.tags)))
        task_id = cur.lastrowid
        extra = {}
        if t.milestone:
            extra.update(milestone=1, start_at=None)
        if t.deps:
            extra["deps"] = await deps_in(db, t.deps, ("t", task_id), user)
        if t.started_at:
            extra["started_at"] = t.started_at
        if t.win:
            extra["win"] = t.win
        if t.kind or t.project_id:
            pj = {k: v for k, v in (("kind", t.kind), ("project_id", t.project_id)) if v is not None}
            await _project_fields(db, task_id, {"id": task_id, "kind": "ops", "project_id": None, "rank": None}, pj, user)
            extra.update(pj)
        if extra:
            await db.execute(f"UPDATE tasks SET {', '.join(k + ' = ?' for k in extra)} WHERE id = ?", (*extra.values(), task_id))
        if user.get("id") is not None:
            acc_c = board_access(user)
            if t.assignees is not None and (acc_c["edit"] in ("all", "dept") or acc_c["team_edit"]):
                await _check_assignees(db, user, None, await _resolve_people(db, t.assignees))
                await set_assignees(db, task_id, t.assignees, user, t.title)
            elif user.get("source") in ("ldap", "entra"):
                # a user's own card is assigned to them (counts on the dashboard under their name)
                await db.execute("INSERT INTO task_members (task_id, user_id, role) VALUES (?, ?, 'assignee')", (task_id, user["id"]))
            await add_mentions(db, task_id, t.description, user, t.title, "說明")
        await db.commit()
        return await _one(db, task_id, user)
    finally:
        await db.close()


@router.put("/{task_id}")
async def update_task(task_id: int, t: TaskUpdate, request: Request):
    user = current_user(request)
    db = await get_db()
    try:
        cur_task = await _get_visible(db, task_id, user)
        await _require_edit(db, task_id, user)
        changes = {k: getattr(t, k) for k in t.model_fields_set if k != "assignees"}
        assignees = t.assignees if "assignees" in t.model_fields_set else None
        if "deps" in changes:
            changes["deps"] = await deps_in(db, t.deps, ("t", task_id), user)
        if "milestone" in changes:
            changes["milestone"] = 1 if changes["milestone"] else 0
        if "win" in changes:
            changes["win"] = changes["win"] or None
        await _project_fields(db, task_id, cur_task, changes, user)
        if changes.get("milestone") or (cur_task.get("milestone") and "start_at" in changes):
            changes["start_at"] = None                 # a milestone is one date: its due date
        if assignees is not None:
            acc = board_access(user)
            if acc["edit"] != "all":
                checks = []
                if acc["edit"] == "dept":
                    checks.append(_dept_sql("t", acc["depts"]))
                if acc["team_edit"]:
                    checks.append(_team_sql("t", acc["team"]))
                    checks.append(_involved_sql("t", user.get("id"), edit=True))   # a supervisor's own card: assign the team
                allowed = False
                for sql, sargs in checks:
                    cur = await db.execute(f"SELECT 1 FROM tasks t WHERE t.id = ? AND {sql}", (task_id, *sargs))
                    allowed = allowed or bool(await cur.fetchone())
                if not allowed:
                    raise HTTPException(status_code=403, detail="這張卡片不屬於你管理的部門或下級，不能改負責人")
            await _check_assignees(db, user, task_id, await _resolve_people(db, assignees))
        for k in ("title", "status", "priority"):
            if k in changes and changes[k] is None:
                raise HTTPException(status_code=400, detail=f"{k} 不能是空的")
        if "repeat_every" in changes and changes["repeat_every"] is None:
            changes["repeat_every"] = 1
        if "tags" in changes:
            changes["tags"] = tags_json(changes["tags"])
        merged = {**cur_task, **changes}
        _check_dates(merged["start_at"], merged["due_at"], merged["repeat"])
        rule = merged["repeat"] or ""
        if rule.startswith("monthly") and ("repeat" in changes or "due_at" in changes):
            changes["repeat"] = _monthly_anchor("monthly", merged["due_at"])   # follow the (new) due day
        if changes:
            sets = [f"{k} = ?" for k in changes]
            vals = list(changes.values())
            if "status" in changes and changes["status"] != cur_task["status"]:
                if cur_task["status"] == "overdue":           # moved out by hand: don't pull it back for this due date
                    sets.append("overdue_ack = ?")
                    vals.append(merged["due_at"])
                    sets.append("overdue_from = NULL")
                cur = await db.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM tasks WHERE status = ?", (changes["status"],))
                sets.append("sort_order = ?")
                vals.append((await cur.fetchone())["n"])
                sets.append("completed_at = CASE WHEN ? = 'complete' THEN CURRENT_TIMESTAMP END")
                vals.append(changes["status"])
            sets.append("updated_at = CURRENT_TIMESTAMP")
            await db.execute(f"UPDATE tasks SET {', '.join(sets)} WHERE id = ?", (*vals, task_id))
        if user.get("id") is not None:
            if assignees is not None:
                await set_assignees(db, task_id, assignees, user, merged["title"])
            if "description" in changes:
                await add_mentions(db, task_id, changes["description"], user, merged["title"], "說明")
        if changes.get("status") == "complete" and cur_task["status"] != "complete":
            await spawn_next(db, task_id)
        if "status" not in changes:               # a status set by hand stays until a subtask / collaborator changes
            await rollup_status(db, task_id)      # (collaborators changed)
        await db.commit()
        return await _one(db, task_id, user)
    finally:
        await db.close()


async def can_delete(db, t: dict, user: dict) -> bool:
    """Board admins, the creator, department managers of the card's departments, supervisors (rw) of its people."""
    acc = board_access(user)
    task_id = t["id"]
    allowed = acc["edit"] == "all" or (user.get("id") is not None and t.get("owner_id") == user.get("id"))
    if not allowed and acc["edit"] == "dept" and acc["depts"]:
        d, dargs = _dept_sql("t", acc["depts"])
        cur = await db.execute(f"SELECT 1 FROM tasks t WHERE t.id = ? AND {d}", (task_id, *dargs))
        allowed = bool(await cur.fetchone())
    if not allowed and acc["team_edit"]:
        d, dargs = _team_sql("t", acc["team"])
        cur = await db.execute(f"SELECT 1 FROM tasks t WHERE t.id = ? AND {d}", (task_id, *dargs))
        allowed = bool(await cur.fetchone())
    return allowed


@router.delete("/{task_id}")
async def delete_task(task_id: int, request: Request):
    user = current_user(request)
    db = await get_db()
    try:
        t = await _get_visible(db, task_id, user)
        if not await can_delete(db, t, user):
            raise HTTPException(status_code=403, detail="只能刪除自己建立的卡片（其他卡片可以改成 Canceled）")
        cur = await db.execute("SELECT stored FROM task_images WHERE task_id = ?", (task_id,))
        files = [r["stored"] for r in await cur.fetchall()]
        await db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        await db.commit()
        img.remove(files)
        return {"success": True}
    finally:
        await db.close()


@router.post("/reorder")
async def reorder(r: Reorder, request: Request):
    """Put `ids` (in this order) into column `status` — used after a drag and drop."""
    user = current_user(request)
    db = await get_db()
    try:
        where, args = _scope_sql(user, "edit")
        if r.ids:
            cur = await db.execute(f"SELECT t.id FROM tasks t WHERE t.id IN ({','.join('?' * len(r.ids))}) AND {where}", (*r.ids, *args))
            allowed = {row["id"] for row in await cur.fetchall()}
            ids = [i for i in r.ids if i in allowed]       # never touch cards the viewer cannot edit
        else:
            ids = []
        if r.status != "overdue" and ids:             # dragged out of 過期未結案 by hand
            marks = ",".join("?" * len(ids))
            await db.execute(f"""UPDATE tasks SET overdue_ack = due_at, overdue_from = NULL
                                 WHERE status = 'overdue' AND id IN ({marks})""", ids)
        closing = []
        if r.status == "complete" and ids:
            marks = ",".join("?" * len(ids))
            cur = await db.execute(f"SELECT id FROM tasks WHERE status != 'complete' AND id IN ({marks})", ids)
            closing = [row["id"] for row in await cur.fetchall()]
        for i, task_id in enumerate(ids):
            await db.execute(
                """UPDATE tasks SET
                       completed_at = CASE WHEN ? = 'complete' THEN COALESCE(CASE WHEN status = 'complete' THEN completed_at END, CURRENT_TIMESTAMP) END,
                       updated_at = CASE WHEN status != ? THEN CURRENT_TIMESTAMP ELSE updated_at END,
                       status = ?, sort_order = ?
                   WHERE id = ?""",
                (r.status, r.status, r.status, i, task_id))
        created = [n for n in [await spawn_next(db, tid) for tid in closing] if n]
        await db.commit()
        return {"success": True, "created": created}
    finally:
        await db.close()


@router.post("/sweep")
async def sweep(body: SweepIn, request: Request):
    """Move open one-off cards past their due date to 過期未結案, and move cards whose due
    date was pushed into the future back out. Idempotent; safe to call often."""
    current_user(request)
    db = await get_db()
    try:
        cur = await db.execute(f"SELECT {COLUMNS} FROM tasks WHERE due_at IS NOT NULL AND status NOT IN ('complete', 'canceled')")
        rows = [row_dict(r) for r in await cur.fetchall()]
        cur = await db.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM tasks WHERE status = 'overdue'")
        order = (await cur.fetchone())["n"]
        moved, restored = [], []
        for t in rows:
            past = is_past(t["due_at"], body.now)
            if t["status"] == "overdue":
                if not past:
                    back = t["overdue_from"] if t["overdue_from"] in STATUSES and t["overdue_from"] not in ("overdue",) + CLOSED else "new"
                    await db.execute("""UPDATE tasks SET status = ?, overdue_from = NULL, updated_at = CURRENT_TIMESTAMP
                                        WHERE id = ?""", (back, t["id"]))
                    restored.append(t["id"])
            elif past and not t["repeat"] and t["overdue_ack"] != t["due_at"]:
                await db.execute("""UPDATE tasks SET status = 'overdue', overdue_from = ?, sort_order = ?,
                                    updated_at = CURRENT_TIMESTAMP WHERE id = ?""", (t["status"], order, t["id"]))
                order += 1
                moved.append(t["id"])
        await db.commit()
        return {"moved": moved, "restored": restored}
    finally:
        await db.close()


@router.post("/{task_id}/complete")
async def complete_task(task_id: int, request: Request, body: Optional[CompleteIn] = None):
    """Close a card; for a recurring card also create the next occurrence (once)."""
    user = current_user(request)
    db = await get_db()
    try:
        t = await _get_visible(db, task_id, user)
        await _require_edit(db, task_id, user)
        if t["status"] != "complete":
            cur = await db.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM tasks WHERE status = 'complete'")
            order = (await cur.fetchone())["n"]
            await db.execute("""UPDATE tasks SET status = 'complete', sort_order = ?, completed_at = CURRENT_TIMESTAMP,
                                updated_at = CURRENT_TIMESTAMP WHERE id = ?""", (order, task_id))
        today = date.fromisoformat(body.today) if body and body.today else None
        next_id = await spawn_next(db, task_id, today)
        await db.commit()
        return {"task": await _one(db, task_id, user), "next": await _one(db, next_id, user) if next_id else None}
    finally:
        await db.close()


# ------------------------------------------------------------------ comments
# A card is a summary task. Comments are threaded (one level: a reply to a reply joins the same
# thread) and a top-level comment can be turned into a subtask of the card with its own title,
# status, assignee, start / due dates, estimate and logged time. The card rolls them up (_rollup).
SUB_STATUSES = ("new", "ongoing", "pending", "onhold", "complete", "canceled")


class CommentIn(BaseModel):
    body: str = ""
    images: List[int] = []
    parent_id: Optional[int] = None

    @field_validator("body")
    @classmethod
    def v_body(cls, v):
        return (v or "").strip()[:4000]

    @field_validator("images")
    @classmethod
    def v_images(cls, v):
        v = list(dict.fromkeys(v or []))
        if len(v) > img.MAX_PER_COMMENT:
            raise ValueError(f"一則留言最多 {img.MAX_PER_COMMENT} 個附件")
        return v


class SubtaskIn(BaseModel):
    """Only the fields sent are changed."""
    is_task: Optional[bool] = None
    title: Optional[str] = None
    status: Optional[str] = None
    start_at: Optional[str] = None
    due_at: Optional[str] = None
    assignee: Optional[str] = None          # username; "" = nobody
    estimate_minutes: Optional[int] = None  # 0 / null = none
    priority: Optional[str] = None          # low | normal | high
    remind: Optional[int] = None            # minutes before due; null = none
    milestone: Optional[bool] = None        # a single date (the due date)
    deps: Optional[List[DepIn]] = None      # predecessors
    started_at: Optional[str] = None        # actual start (set automatically; can be corrected)
    win: Optional[str] = None               # the shared window it needs ("" = none)

    @field_validator("win")
    @classmethod
    def v_win(cls, v):
        return _win(v)

    @field_validator("started_at")
    @classmethod
    def v_started(cls, v):
        return _date(v)

    @field_validator("priority")
    @classmethod
    def v_prio(cls, v):
        return None if v is None else _prio(v)

    @field_validator("remind")
    @classmethod
    def v_remind(cls, v):
        return _remind(v)

    @field_validator("title")
    @classmethod
    def v_title(cls, v):
        return None if v is None else (v.strip()[:200] or None)

    @field_validator("status")
    @classmethod
    def v_status(cls, v):
        if v is not None and v not in SUB_STATUSES:
            raise ValueError(f"子任務狀態必須是 {', '.join(SUB_STATUSES)}")
        return v

    @field_validator("start_at", "due_at")
    @classmethod
    def v_dates(cls, v):
        return _date(v)

    @field_validator("estimate_minutes")
    @classmethod
    def v_est(cls, v):
        if v is not None and not 0 <= v <= 100000:
            raise ValueError("預估工時超出範圍")
        return v or None


class TimeIn(BaseModel):
    minutes: int
    note: Optional[str] = None
    work_date: Optional[str] = None

    @field_validator("minutes")
    @classmethod
    def v_minutes(cls, v):
        if not 1 <= v <= 24 * 60:
            raise ValueError("工時要在 1 分鐘到 24 小時之間")
        return v

    @field_validator("note")
    @classmethod
    def v_note(cls, v):
        return (v or "").strip()[:200] or None

    @field_validator("work_date")
    @classmethod
    def v_day(cls, v):
        if v and not re.match(r"^\d{4}-\d{2}-\d{2}$", v):
            raise ValueError("日期格式應為 YYYY-MM-DD")
        return v or None


class TimerIn(BaseModel):
    action: str                             # start | stop
    work_date: Optional[str] = None

    @field_validator("action")
    @classmethod
    def v_action(cls, v):
        if v not in ("start", "stop"):
            raise ValueError("action 只能是 start 或 stop")
        return v


async def _can_edit(db, task_id: int, user: dict) -> bool:
    where, args = _scope_sql(user, "edit")
    cur = await db.execute(f"SELECT 1 FROM tasks t WHERE t.id = ? AND {where}", (task_id, *args))
    return bool(await cur.fetchone())


async def _comment_rights(db, task_id: int, c, user: dict) -> dict:
    """What this user may do with comment c.
    edit_body: the author; for a subtask also card editors and its assignee (its text is the description).
    edit_task: card editors and the subtask's assignee (every field but the assignee).
    assign: card editors."""
    me = user.get("id")
    editor = await _can_edit(db, task_id, user)
    author = me is None or (c["user_id"] is not None and c["user_id"] == me)
    above = me is not None and bool(c["is_task"]) and me in await _owners_above(db, c["task_parent_id"])
    mine = me is not None and bool(c["is_task"]) and (c["assignee_id"] == me or above)
    task_edit = bool(c["is_task"]) and (editor or mine)
    return {"editor": editor, "edit_body": author or task_edit or (board_access(user)["edit"] == "all"),
            "edit_task": task_edit, "assign": editor or above}


async def _owners_above(db, comment_id) -> set:
    """Assignees of this subtask and of every subtask above it: they look after everything below."""
    out, cid, n = set(), comment_id, 0
    while cid and n < 10:
        cur = await db.execute("SELECT assignee_id, task_parent_id FROM task_comments WHERE id = ?", (cid,))
        r = await cur.fetchone()
        if not r:
            break
        if r["assignee_id"] is not None:
            out.add(r["assignee_id"])
        cid, n = r["task_parent_id"], n + 1
    return out


async def _comment(db, task_id: int, comment_id: int):
    cur = await db.execute("SELECT * FROM task_comments WHERE id = ? AND task_id = ?", (comment_id, task_id))
    c = await cur.fetchone()
    if not c:
        raise HTTPException(status_code=404, detail="找不到這則留言")
    return c


async def _sync_subtask_members(db, task_id: int):
    """People assigned a subtask can see the card (role 'subtask': view + comment, not edit)."""
    await db.execute("DELETE FROM task_members WHERE task_id = ? AND role = 'subtask'", (task_id,))
    await db.execute("""INSERT OR IGNORE INTO task_members (task_id, user_id, role)
                        SELECT DISTINCT task_id, assignee_id, 'subtask' FROM task_comments
                        WHERE task_id = ? AND is_task = 1 AND assignee_id IS NOT NULL""", (task_id,))


async def _card_people(db, task_id: int, owner_id) -> set:
    return await _members(db, task_id, "assignee") | {owner_id}


def _person(uid, username, name):
    return {"id": uid, "username": username, "name": name or username or "本機"} if (uid or username) else None


@router.get("/{task_id}/comments")
async def list_comments(task_id: int, request: Request):
    """Threads (oldest first; replies under their comment), with subtask fields and time logs."""
    user = current_user(request)
    me = user.get("id")
    db = await get_db()
    try:
        await _get_visible(db, task_id, user)
        editor = await _can_edit(db, task_id, user)
        acc_all = board_access(user)["edit"] == "all"
        cur = await db.execute("""SELECT c.*, u.username, u.display_name, a.username AS a_username, a.display_name AS a_name,
                                         a.department AS a_department
                                  FROM task_comments c LEFT JOIN users u ON u.id = c.user_id
                                  LEFT JOIN users a ON a.id = c.assignee_id
                                  WHERE c.task_id = ? ORDER BY c.id""", (task_id,))
        rows = await cur.fetchall()
        cur = await db.execute("""SELECT id, task_id, comment_id, name, size, kind FROM task_images
                                  WHERE task_id = ? AND comment_id IS NOT NULL ORDER BY id""", (task_id,))
        pics = {}
        for im in await cur.fetchall():
            pics.setdefault(im["comment_id"], []).append(image_dict(im))
        cur = await db.execute("""SELECT t.id, t.comment_id, t.user_id, t.minutes, t.note, t.work_date, t.started_at, t.ended_at,
                                         CAST((julianday('now') - julianday(t.started_at)) * 86400 AS INTEGER) AS elapsed,
                                         u.username, u.display_name
                                  FROM task_time t LEFT JOIN users u ON u.id = t.user_id
                                  WHERE t.task_id = ? ORDER BY COALESCE(t.work_date, t.created_at) DESC, t.id DESC""", (task_id,))
        times = {}
        for e in await cur.fetchall():
            times.setdefault(e["comment_id"], []).append(e)
        row_by = {c["id"]: c for c in rows}
        dep_map = await deps_out(db, [c["deps"] for c in rows if c["is_task"]])

        def owners(cid, above_only=False):
            got, n = set(), 0
            if above_only:
                cid = row_by[cid]["task_parent_id"] if cid in row_by else None
            while cid in row_by and n < 10:
                if row_by[cid]["assignee_id"] is not None:
                    got.add(row_by[cid]["assignee_id"])
                cid, n = row_by[cid]["task_parent_id"], n + 1
            return got
        out, by_id = [], {}
        for c in rows:
            item = {
                "id": c["id"], "body": c["body"], "created_at": c["created_at"], "images": pics.get(c["id"], []),
                "parent_id": c["parent_id"], "task_parent_id": c["task_parent_id"],
                "author": _person(c["user_id"], c["username"], c["display_name"]) or {"id": None, "name": "本機"},
                "can_delete": acc_all or (c["user_id"] is not None and c["user_id"] == me) or (me is None)
                              or (bool(c["is_task"]) and c["parent_id"] is None and (editor or (me is not None and me in owners(c["id"], True)))),
                "can_reply": True,
                "edited_at": c["edited_at"],
                "can_edit_body": acc_all or me is None or (c["user_id"] is not None and c["user_id"] == me)
                                 or (bool(c["is_task"]) and c["parent_id"] is None and (editor or (me is not None and me in owners(c["id"])))),
            }
            if c["parent_id"] is None:
                item["replies"] = []
                item["can_make_task"] = editor
                if c["is_task"]:
                    entries = times.get(c["id"], [])
                    assignee = _person(c["assignee_id"], c["a_username"], c["a_name"])
                    if assignee:
                        assignee["department"] = c["a_department"]
                    mine = me is not None and me in owners(c["id"])
                    above = me is not None and me in owners(c["id"], True)
                    item["task"] = {
                        "title": c["title"], "status": c["status"] or "new", "start_at": c["start_at"], "due_at": c["due_at"],
                        "sort_order": c["sort_order"], "priority": c["priority"] or "normal", "remind": c["remind"],
                        "assignee": assignee, "estimate_minutes": c["estimate_minutes"], "completed_at": c["completed_at"],
                        "spent_minutes": sum(e["minutes"] or 0 for e in entries),
                        "entries": [{"id": e["id"], "minutes": e["minutes"], "note": e["note"], "work_date": e["work_date"],
                                     "running": e["ended_at"] is None and e["started_at"] is not None,
                                     "elapsed": e["elapsed"] if e["ended_at"] is None and e["started_at"] is not None else None,
                                     "user": _person(e["user_id"], e["username"], e["display_name"]),
                                     "can_delete": editor or (e["user_id"] is not None and e["user_id"] == me) or me is None}
                                    for e in entries],
                        "my_timer": next(({"id": e["id"], "elapsed": e["elapsed"]} for e in entries
                                          if e["ended_at"] is None and e["started_at"] is not None and e["user_id"] == me), None),
                        "milestone": bool(c["milestone"]), "base_start": c["base_start"], "base_due": c["base_due"],
                        "started_at": c["started_at"], "deps": dep_map.get(c["deps"] or "", []), "win": c["win"],
                        "can_edit": editor or mine,             # every field but the assignee
                        "can_assign": editor or above,
                        "can_update": editor or mine,           # status + time log
                    }
                out.append(item)
                by_id[c["id"]] = item
            elif c["parent_id"] in by_id:
                by_id[c["parent_id"]]["replies"].append(item)
        return out
    finally:
        await db.close()


@router.post("/{task_id}/comments")
async def add_comment(task_id: int, body: CommentIn, request: Request):
    user = current_user(request)
    db = await get_db()
    try:
        t = await _get_visible(db, task_id, user)
        parent = None
        if body.parent_id:
            parent = await _comment(db, task_id, body.parent_id)
            if parent["parent_id"]:                                   # replies stay one level deep
                parent = await _comment(db, task_id, parent["parent_id"])
        pics = []
        if body.images:
            cur = await db.execute(f"""SELECT id FROM task_images WHERE task_id = ? AND pending = 1 AND user_id IS ?
                                       AND id IN ({','.join('?' * len(body.images))})""", (task_id, user.get("id"), *body.images))
            pics = [r["id"] for r in await cur.fetchall()]
            if len(pics) != len(body.images):
                raise HTTPException(status_code=400, detail="有附件已失效，請重新附加")
        if not body.body and not pics:
            raise HTTPException(status_code=400, detail="請輸入留言或附加檔案")
        cur = await db.execute("INSERT INTO task_comments (task_id, user_id, body, parent_id) VALUES (?, ?, ?, ?)",
                               (task_id, user.get("id"), body.body, parent["id"] if parent else None))
        comment_id = cur.lastrowid
        if pics:
            await db.execute(f"UPDATE task_images SET comment_id = ?, pending = 0 WHERE id IN ({','.join('?' * len(pics))})",
                             (comment_id, *pics))
        if user.get("id") is not None:
            mentioned = MENTION_RE.findall(body.body)
            await add_mentions(db, task_id, body.body, user, t["title"], "留言")
            # everyone already on the card hears about the comment (mentioned people got a mention already)
            people = await _members(db, task_id, "assignee") | await _members(db, task_id, "mention") | {t.get("owner_id")}
            cur2 = await db.execute(f"SELECT id FROM users WHERE username IN ({','.join('?' * len(mentioned)) or 'NULL'})",
                                    [ldapauth.normalize(m) for m in mentioned])
            already = {r["id"] for r in await cur2.fetchall()}
            text = body.body[:60] or f"（{len(pics)} 個附件）"
            if parent:
                # the thread: who wrote the comment, who replied before, who owns the subtask
                cur2 = await db.execute("SELECT DISTINCT user_id FROM task_comments WHERE id = ? OR parent_id = ?", (parent["id"], parent["id"]))
                thread = {r["user_id"] for r in await cur2.fetchall()} | {parent["assignee_id"]}
                await notify(db, thread - already, task_id, user, "comment", f"{_who(user)} 在「{t['title']}」回覆：{text}")
                people -= thread
            await notify(db, people - already, task_id, user, "comment", f"{_who(user)} 在「{t['title']}」留言：{text}")
        await db.execute("UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (task_id,))
        await db.commit()
        return {"id": comment_id, "parent_id": parent["id"] if parent else None}
    finally:
        await db.close()


class CommentEdit(BaseModel):
    body: str

    @field_validator("body")
    @classmethod
    def v_body(cls, v):
        return (v or "").strip()[:4000]


@router.put("/{task_id}/comments/{comment_id}")
async def edit_comment(task_id: int, comment_id: int, body: CommentEdit, request: Request):
    """Change a comment's text (a subtask's text is its description)."""
    user = current_user(request)
    db = await get_db()
    try:
        t = await _get_visible(db, task_id, user)
        c = await _comment(db, task_id, comment_id)
        if not (await _comment_rights(db, task_id, c, user))["edit_body"]:
            raise HTTPException(status_code=403, detail="只能修改自己的留言")
        cur = await db.execute("SELECT COUNT(*) AS n FROM task_images WHERE comment_id = ?", (comment_id,))
        if not body.body and not c["is_task"] and not (await cur.fetchone())["n"]:
            raise HTTPException(status_code=400, detail="留言不能是空的（要刪除請按刪除）")
        if body.body != (c["body"] or ""):
            await db.execute("UPDATE task_comments SET body = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?", (body.body, comment_id))
            if user.get("id") is not None:
                await add_mentions(db, task_id, body.body, user, t["title"], "留言")
            await db.execute("UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (task_id,))
            await db.commit()
        return {"success": True}
    finally:
        await db.close()


@router.delete("/{task_id}/comments/{comment_id}")
async def delete_comment(task_id: int, comment_id: int, request: Request):
    """Deleting a comment also deletes its replies, attachments and logged time."""
    user = current_user(request)
    db = await get_db()
    try:
        await _get_visible(db, task_id, user)
        c = await _comment(db, task_id, comment_id)
        me = user.get("id")
        if board_access(user)["edit"] != "all" and c["user_id"] != me and not (
                c["is_task"] and (await _can_edit(db, task_id, user) or (me is not None and me in await _owners_above(db, c["task_parent_id"])))):
            raise HTTPException(status_code=403, detail="只能刪除自己的留言")
        # the comment, its replies, the subtasks below it (any depth) and their replies
        cur = await db.execute("""WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT c.id FROM task_comments c JOIN tree ON c.task_parent_id = tree.id)
                                  SELECT stored FROM task_images WHERE comment_id IN (SELECT id FROM tree)
                                  OR comment_id IN (SELECT id FROM task_comments WHERE parent_id IN (SELECT id FROM tree))""", (comment_id,))
        files = [r["stored"] for r in await cur.fetchall()]
        await db.execute("DELETE FROM task_comments WHERE id = ?", (comment_id,))
        await _sync_subtask_members(db, task_id)
        if c["task_parent_id"]:
            await rollup_subtask(db, c["task_parent_id"])
        await rollup_dates(db, task_id, c["task_parent_id"])
        await rollup_status(db, task_id)
        await db.commit()
        img.remove(files)
        return {"success": True}
    finally:
        await db.close()


# ------------------------------------------------------------------ subtasks
@router.put("/{task_id}/comments/{comment_id}/task")
async def update_subtask(task_id: int, comment_id: int, body: SubtaskIn, request: Request):
    """Turn a comment into a subtask (or back), or change its fields.
    Card editors change everything; the subtask's assignee may change its status."""
    user = current_user(request)
    me = user.get("id")
    sent = body.model_fields_set
    db = await get_db()
    try:
        t = await _get_visible(db, task_id, user)
        c = await _comment(db, task_id, comment_id)
        if c["parent_id"]:
            raise HTTPException(status_code=400, detail="回覆不能設為子任務，請用原本的留言")
        rights = await _comment_rights(db, task_id, c, user)
        editor = rights["editor"]
        if not editor and ("is_task" in sent or not rights["edit_task"] or ("assignee" in sent and not rights["assign"])):
            raise HTTPException(status_code=403, detail="只有能編輯這張卡片的人可以設定或指派子任務；子任務負責人可以修改其他內容（上層子任務的負責人也可以指派下層）")
        is_task = bool(c["is_task"]) if body.is_task is None else body.is_task
        if not is_task:
            cur = await db.execute("SELECT 1 FROM task_comments WHERE task_parent_id = ? LIMIT 1", (comment_id,))
            if await cur.fetchone():
                raise HTTPException(status_code=400, detail="這個子任務底下還有子任務，請先刪除或移走它們")
            if c["task_parent_id"]:
                raise HTTPException(status_code=400, detail="下層子任務不能改回一般留言，可以直接刪除")
            await db.execute("UPDATE task_comments SET is_task = 0 WHERE id = ?", (comment_id,))
            await db.execute("UPDATE task_time SET ended_at = CURRENT_TIMESTAMP, minutes = MAX(1, CAST(ROUND((julianday('now') - julianday(started_at)) * 1440) AS INTEGER)) WHERE comment_id = ? AND ended_at IS NULL AND started_at IS NOT NULL", (comment_id,))
            await _sync_subtask_members(db, task_id)
            await rollup_status(db, task_id)
            await db.commit()
            return {"success": True, "is_task": False}

        fields = {}
        if not c["is_task"]:
            fields["is_task"] = 1
            cur = await db.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM task_comments WHERE task_id = ? AND is_task = 1", (task_id,))
            fields["sort_order"] = (await cur.fetchone())["n"]
            if not c["status"]:
                fields["status"] = "new"
            if not c["title"] and "title" not in sent:
                first = next((ln.strip() for ln in (c["body"] or "").splitlines() if ln.strip()), "")
                fields["title"] = (first[:120] or "子任務")
        for k in ("title", "status", "start_at", "due_at", "estimate_minutes", "priority", "remind", "started_at"):
            if k in sent:
                fields[k] = getattr(body, k)
        if sent & {"start_at", "due_at"}:
            cur = await db.execute("SELECT 1 FROM task_comments WHERE task_parent_id = ? AND is_task = 1 LIMIT 1", (comment_id,))
            if await cur.fetchone():
                fields.pop("start_at", None); fields.pop("due_at", None)    # it spans its subtasks
        if "milestone" in sent:
            fields["milestone"] = 1 if body.milestone else 0
        if "win" in sent:
            fields["win"] = body.win or None
        if fields.get("milestone") or (c["milestone"] and "start_at" in fields):
            fields["start_at"] = None
        if "deps" in sent:
            fields["deps"] = await deps_in(db, body.deps, ("s", comment_id), user)
        if "title" in sent and not body.title:
            raise HTTPException(status_code=400, detail="請輸入子任務名稱")
        start = fields.get("start_at", c["start_at"])
        due = fields.get("due_at", c["due_at"])
        if start and due and start[:10] > due[:10]:
            raise HTTPException(status_code=400, detail="開始日不能晚於到期日")
        new_assignee = c["assignee_id"]
        if "assignee" in sent:
            if body.assignee:
                people = await _resolve_people(db, [body.assignee])
                if not people:
                    raise HTTPException(status_code=400, detail=f"找不到帳號 {body.assignee}")
                person = people[0]
                if person["id"] != c["assignee_id"]:
                    await _check_subtask_assignee(db, user, t, person)
                new_assignee = person["id"]
            else:
                new_assignee = None
            fields["assignee_id"] = new_assignee
        status_before = c["status"] or "new"
        if "status" in fields and fields["status"] != status_before:
            fields["completed_at"] = None
        sets = ", ".join(f"{k} = ?" for k in fields)
        if sets:
            await db.execute(f"UPDATE task_comments SET {sets} WHERE id = ?", (*fields.values(), comment_id))
        if fields.get("status") == "complete" and status_before != "complete":
            await db.execute("UPDATE task_comments SET completed_at = CURRENT_TIMESTAMP WHERE id = ?", (comment_id,))
        if "assignee_id" in fields and c["assignee_id"] and fields["assignee_id"] != c["assignee_id"]:
            # the previous assignee's timer on this subtask stops (they may no longer see the card)
            await db.execute(STOP_SQL + "comment_id = ? AND user_id = ?", (comment_id, c["assignee_id"]))
        if fields.get("status") in CLOSED:      # closing stops running timers
            await db.execute("UPDATE task_time SET ended_at = CURRENT_TIMESTAMP, minutes = MAX(1, CAST(ROUND((julianday('now') - julianday(started_at)) * 1440) AS INTEGER)) WHERE comment_id = ? AND ended_at IS NULL AND started_at IS NOT NULL", (comment_id,))
        await _sync_subtask_members(db, task_id)
        if c["task_parent_id"] and "status" in fields:      # a subtask of a subtask: its parents follow
            await rollup_subtask(db, c["task_parent_id"])
        if fields.keys() & {"start_at", "due_at", "status", "milestone"}:
            await rollup_dates(db, task_id, comment_id)
        await rollup_status(db, task_id)

        title = fields.get("title") or c["title"] or "子任務"
        if me is not None:
            if new_assignee and new_assignee != c["assignee_id"]:
                await notify(db, {new_assignee}, task_id, user, "assigned", f"{_who(user)} 指派子任務「{title}」給你（卡片「{t['title']}」）")
            if fields.get("status") == "complete" and status_before != "complete":
                await notify(db, await _card_people(db, task_id, t.get("owner_id")), task_id, user, "subtask",
                             f"{_who(user)} 完成了子任務「{title}」（卡片「{t['title']}」）")
        await db.execute("UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (task_id,))
        await db.commit()
        return {"success": True, "is_task": True}
    finally:
        await db.close()


class CollabDoneIn(BaseModel):
    done: bool


@router.post("/{task_id}/collab/{user_id}/done")
async def collab_done(task_id: int, user_id: int, body: CollabDoneIn, request: Request):
    """A collaborator (co-assignee or @mentioned) marks their part of the card done; counts toward its %."""
    user = current_user(request)
    db = await get_db()
    try:
        t = await _get_visible(db, task_id, user)
        if user.get("id") != user_id and not await _can_edit(db, task_id, user):
            raise HTTPException(status_code=403, detail="只有協作人自己或能編輯卡片的人可以標記完成")
        cur = await db.execute("""UPDATE task_members SET done_at = CASE WHEN ? THEN CURRENT_TIMESTAMP END
                                  WHERE task_id = ? AND user_id = ? AND role IN ('assignee', 'mention')""", (body.done, task_id, user_id))
        if not cur.rowcount:
            raise HTTPException(status_code=404, detail="這個人不是這張卡片的協作人")
        if body.done and user.get("id") is not None:
            await notify(db, {t.get("owner_id")}, task_id, user, "subtask", f"{_who(user)} 完成了「{t['title']}」裡的協作部分")
        await db.execute("UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (task_id,))
        await rollup_status(db, task_id)
        await db.commit()
        return {"success": True}
    finally:
        await db.close()


class BlockedIn(BaseModel):
    blocked: bool
    reason: str = ""

    @field_validator("reason")
    @classmethod
    def v_reason(cls, v):
        return " ".join((v or "").split())[:300]


@router.post("/{task_id}/blocked")
async def set_blocked(task_id: int, body: BlockedIn, request: Request):
    """Mark a card 卡住 (with what it is waiting for) or clear it. The card's people and anyone who can
    edit it (their supervisors included) may do this; the card's people and the lead's 上級 are told."""
    user = current_user(request)
    db = await get_db()
    try:
        t = await _get_visible(db, task_id, user)
        if not await _can_edit(db, task_id, user):
            raise HTTPException(status_code=403, detail="只有負責人、協作人或上級可以標記卡住")
        if body.blocked:
            if t["status"] in ("complete", "canceled"):
                raise HTTPException(status_code=400, detail="已結案的卡片不能標記卡住")
            if not body.reason:
                raise HTTPException(status_code=400, detail="請寫一下卡在哪裡、在等誰")
            await db.execute("""UPDATE tasks SET blocked_at = COALESCE(blocked_at, CURRENT_TIMESTAMP), blocked_reason = ?, blocked_by = ?,
                                updated_at = CURRENT_TIMESTAMP WHERE id = ?""", (body.reason, user.get("id"), task_id))
            text = f"⛔ 卡住：{body.reason}"
        else:
            if not t["blocked_at"]:
                return {"success": True}
            await db.execute("""UPDATE tasks SET blocked_at = NULL, blocked_reason = NULL, blocked_by = NULL,
                                updated_at = CURRENT_TIMESTAMP WHERE id = ?""", (task_id,))
            text = "✅ 解除卡住" + (f"：{body.reason}" if body.reason else "")
        await db.execute("INSERT INTO task_comments (task_id, user_id, body) VALUES (?, ?, ?)", (task_id, user.get("id"), text))
        people = {t.get("owner_id")} | await _members(db, task_id, "assignee") | await _members(db, task_id, "mention")
        if people - {None}:
            marks = ",".join("?" * len(people - {None}))
            cur = await db.execute(f"SELECT manager_id FROM users WHERE id IN ({marks}) AND manager_id IS NOT NULL", list(people - {None}))
            people |= {r[0] for r in await cur.fetchall()}
        await notify(db, people, task_id, user, "comment", f"{_who(user)} 在「{t['title']}」{text}")
        await db.commit()
        return {"success": True}
    finally:
        await db.close()


class OrderIn(BaseModel):
    ids: List[int]
    parent: Optional[int] = None            # order the subtasks below this subtask; empty = the card's own


@router.post("/{task_id}/subtasks/order")
async def order_subtasks(task_id: int, body: OrderIn, request: Request):
    """Put the card's subtasks in this order (drag and drop in the card editor)."""
    user = current_user(request)
    db = await get_db()
    try:
        await _get_visible(db, task_id, user)
        if body.parent:
            if not await _can_edit(db, task_id, user) and user.get("id") not in await _owners_above(db, body.parent):
                raise HTTPException(status_code=403, detail="只有能編輯卡片的人或上層子任務的負責人可以調整順序")
        else:
            await _require_edit(db, task_id, user)
        cur = await db.execute("SELECT id FROM task_comments WHERE task_id = ? AND is_task = 1 AND parent_id IS NULL AND task_parent_id IS ?",
                               (task_id, body.parent))
        mine = {r["id"] for r in await cur.fetchall()}
        ids = [i for i in dict.fromkeys(body.ids) if i in mine]
        rest = sorted(mine - set(ids))                    # anything not sent keeps its place at the end
        for n, cid in enumerate(ids + rest):
            await db.execute("UPDATE task_comments SET sort_order = ? WHERE id = ?", (n, cid))
        await db.execute("UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (task_id,))
        await db.commit()
        return {"success": True, "order": ids + rest}
    finally:
        await db.close()


# ------------------------------------------------- summary cards (roll-up)
# A card with subtasks is a summary task: its status follows its subtasks whenever a subtask or a
# collaborator changes; it can still be set by hand (it stays until the next such change)
# (except Canceled, for dropping the whole thing). Collaborators (co-assignees / @mentioned without a
# subtask) do not move the status but the card only completes once they marked their part done;
# until then a card whose subtasks are all done waits in Pending.
async def _subtask_states(db, task_id: int) -> List[str]:
    cur = await db.execute("""SELECT COALESCE(status, 'new') AS s FROM task_comments
                              WHERE task_id = ? AND is_task = 1 AND parent_id IS NULL AND task_parent_id IS NULL
                              AND COALESCE(status, 'new') != 'canceled'""", (task_id,))
    return [r["s"] for r in await cur.fetchall()]


async def _open_collaborators(db, task_id: int, owner_id) -> int:
    """Collaborators who have not marked their part done (people with a subtask are counted by it)."""
    cur = await db.execute("""SELECT user_id, role, done_at FROM task_members WHERE task_id = ? AND role IN ('assignee', 'mention')
                              ORDER BY created_at""", (task_id,))
    rows = await cur.fetchall()
    assignees = [r["user_id"] for r in rows if r["role"] == "assignee"]
    lead = owner_id if owner_id in assignees else (assignees[0] if assignees else owner_id)
    cur = await db.execute("SELECT DISTINCT assignee_id FROM task_comments WHERE task_id = ? AND is_task = 1 AND assignee_id IS NOT NULL", (task_id,))
    with_sub = {r[0] for r in await cur.fetchall()}
    seen, open_ = set(), 0
    for r in rows:
        if r["user_id"] == lead or r["user_id"] in with_sub or r["user_id"] in seen:
            continue
        seen.add(r["user_id"])
        open_ += not r["done_at"]
    return open_


def derive_status(states: List[str], open_collab: int) -> str:
    if all(s == "complete" for s in states):
        return "pending" if open_collab else "complete"
    if all(s == "new" for s in states):
        return "new"
    for s in ("ongoing", "pending", "onhold"):
        if s in states:
            return s
    return "ongoing"                                  # some done, some not started


async def rollup_status(db, task_id: int) -> Optional[str]:
    """Set a summary card's status from its subtasks (no-op for cards without subtasks or canceled ones)."""
    cur = await db.execute("SELECT id, status, repeat, owner_id FROM tasks WHERE id = ?", (task_id,))
    t = await cur.fetchone()
    if not t or t["status"] == "canceled":
        return None
    states = await _subtask_states(db, task_id)
    if not states:
        return None
    want = derive_status(states, await _open_collaborators(db, task_id, t["owner_id"]))
    have = t["status"]
    if want != "complete" and have in ("overdue", "recurring"):
        return have                                   # those columns stay until the work is done
    if want == have:
        return have
    if have == "complete" and t["repeat"]:
        want = "recurring" if want != "complete" else want
    cur = await db.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM tasks WHERE status = ?", (want,))
    order = (await cur.fetchone())["n"]
    await db.execute("""UPDATE tasks SET status = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP,
                        completed_at = CASE WHEN ? = 'complete' THEN CURRENT_TIMESTAMP END WHERE id = ?""", (want, order, want, task_id))
    if want == "complete":
        await spawn_next(db, task_id)
    return want


SUB_MAX_DEPTH = 3          # subtask levels below the card (card + 3 = 4 levels)


async def subtask_depth(db, comment_id) -> int:
    """1 = a subtask of the card, 2 = its subtask, …"""
    depth, cid = 0, comment_id
    while cid and depth < 10:
        cur = await db.execute("SELECT task_parent_id FROM task_comments WHERE id = ?", (cid,))
        r = await cur.fetchone()
        if not r:
            break
        depth += 1
        cid = r["task_parent_id"]
    return depth


async def rollup_dates(db, task_id: int, comment_id=None):
    """A subtask with subtasks spans them (earliest start → latest due), up the chain;
    a project card spans all its subtasks. Items without dates do not count."""
    cid, n = comment_id, 0
    while cid and n <= SUB_MAX_DEPTH:
        cur = await db.execute("""SELECT MIN(COALESCE(start_at, due_at)), MAX(COALESCE(due_at, start_at)) FROM task_comments
                                  WHERE task_parent_id = ? AND is_task = 1 AND COALESCE(status, 'new') != 'canceled'""", (cid,))
        lo, hi = await cur.fetchone()
        if lo or hi:
            await db.execute("""UPDATE task_comments SET start_at = ?, due_at = ?, milestone = 0
                                WHERE id = ? AND (COALESCE(start_at, '') != COALESCE(?, '') OR COALESCE(due_at, '') != COALESCE(?, ''))""",
                             (lo, hi, cid, lo, hi))
        cur = await db.execute("SELECT task_parent_id FROM task_comments WHERE id = ?", (cid,))
        r = await cur.fetchone()
        cid, n = (r[0] if r else None), n + 1
    cur = await db.execute("SELECT kind FROM tasks WHERE id = ?", (task_id,))
    r = await cur.fetchone()
    if r and r[0] == "project":
        cur = await db.execute("""SELECT MIN(COALESCE(start_at, due_at)), MAX(COALESCE(due_at, start_at)) FROM task_comments
                                  WHERE task_id = ? AND task_parent_id IS NULL AND is_task = 1 AND parent_id IS NULL
                                  AND COALESCE(status, 'new') != 'canceled'""", (task_id,))
        lo, hi = await cur.fetchone()
        if lo or hi:
            await db.execute("""UPDATE tasks SET start_at = ?, due_at = ?, milestone = 0 WHERE id = ?
                                AND (COALESCE(start_at, '') != COALESCE(?, '') OR COALESCE(due_at, '') != COALESCE(?, ''))""", (lo, hi, task_id, lo, hi))


class ShiftIn(BaseModel):
    keys: List[str]                          # "t:<card>" / "s:<subtask>"
    days: int

    @field_validator("days")
    @classmethod
    def v_days(cls, v):
        if not -365 <= v <= 365 or v == 0:
            raise ValueError("順延天數要在 ±365 天內且不為 0")
        return v


@router.post("/shift")
async def shift_items(body: ShiftIn, request: Request):
    """Move items by N days (the successors of a predecessor that slipped). Items one may not edit are skipped."""
    from datetime import timedelta
    user = current_user(request)
    me = user.get("id")
    db = await get_db()
    moved, skipped = [], []
    try:
        def mv(v):
            if not v:
                return v
            d = (date.fromisoformat(v[:10]) + timedelta(days=body.days)).isoformat()
            return d + v[10:]
        touched = set()
        for key in list(dict.fromkeys(body.keys))[:200]:
            m = DEP_RE.match(key or "")
            if not m:
                continue
            kind, rid = m.group(1), int(m.group(2))
            try:
                if kind == "t":
                    t = await _get_visible(db, rid, user)
                    if not await _can_edit(db, rid, user):
                        skipped.append(key); continue
                    await db.execute("UPDATE tasks SET start_at = ?, due_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (mv(t["start_at"]), mv(t["due_at"]), rid))
                    touched.add((rid, None))
                else:
                    c = await _comment(db, *(await (await db.execute("SELECT task_id, id FROM task_comments WHERE id = ?", (rid,))).fetchone()))
                    await _get_visible(db, c["task_id"], user)
                    if not (await _can_edit(db, c["task_id"], user) or (me is not None and me in await _owners_above(db, rid))):
                        skipped.append(key); continue
                    await db.execute("UPDATE task_comments SET start_at = ?, due_at = ? WHERE id = ?", (mv(c["start_at"]), mv(c["due_at"]), rid))
                    touched.add((c["task_id"], c["task_parent_id"]))
                moved.append(key)
            except (HTTPException, TypeError):
                skipped.append(key)
        for task_id, parent in touched:
            await rollup_dates(db, task_id, parent)
        await db.commit()
        return {"moved": moved, "skipped": skipped}
    finally:
        await db.close()


async def rollup_subtask(db, comment_id: int):
    """A subtask with subtasks of its own follows them like a card follows its subtasks (and so on up)."""
    for _ in range(SUB_MAX_DEPTH):
        cur = await db.execute("SELECT id, status, task_parent_id FROM task_comments WHERE id = ? AND is_task = 1", (comment_id,))
        c = await cur.fetchone()
        if not c or (c["status"] or "new") == "canceled":
            return
        cur = await db.execute("""SELECT COALESCE(status, 'new') AS s FROM task_comments
                                  WHERE task_parent_id = ? AND is_task = 1 AND COALESCE(status, 'new') != 'canceled'""", (comment_id,))
        states = [r["s"] for r in await cur.fetchall()]
        if states:
            want = derive_status(states, 0)
            if want != (c["status"] or "new"):
                await db.execute("""UPDATE task_comments SET status = ?,
                                    completed_at = CASE WHEN ? = 'complete' THEN CURRENT_TIMESTAMP END WHERE id = ?""",
                                 (want, want, comment_id))
                if want in CLOSED:
                    await db.execute(STOP_SQL + "comment_id = ?", (comment_id,))
        if not c["task_parent_id"]:
            return
        comment_id = c["task_parent_id"]


class SubtaskNew(BaseModel):
    title: str
    parent: Optional[int] = None            # a subtask's id: the new one goes below it; empty = directly on the card
    assignee: Optional[str] = None
    due_at: Optional[str] = None

    @field_validator("title")
    @classmethod
    def v_title(cls, v):
        v = (v or "").strip()
        if not v:
            raise ValueError("請輸入子任務名稱")
        return v[:200]

    @field_validator("due_at")
    @classmethod
    def v_due(cls, v):
        return _date(v)


@router.post("/{task_id}/subtasks")
async def create_subtask(task_id: int, body: SubtaskNew, request: Request):
    """New subtask on the card, or below another subtask (card + 3 levels at most).
    Card editors may add anywhere; a subtask's assignee may add below their own subtask."""
    user = current_user(request)
    me = user.get("id")
    db = await get_db()
    try:
        t = await _get_visible(db, task_id, user)
        editor = await _can_edit(db, task_id, user)
        if body.parent:
            p = await _comment(db, task_id, body.parent)
            if not p["is_task"] or p["parent_id"]:
                raise HTTPException(status_code=400, detail="只能在子任務底下新增子任務")
            if await subtask_depth(db, body.parent) >= SUB_MAX_DEPTH:
                raise HTTPException(status_code=400, detail="最多四層（主卡＋三層子任務）")
            if not editor and not (me is not None and me in await _owners_above(db, body.parent)):
                raise HTTPException(status_code=403, detail="只有能編輯卡片的人或這個子任務的負責人可以新增下層子任務")
        elif not editor:
            raise HTTPException(status_code=403, detail="只有能編輯這張卡片的人可以新增子任務")
        assignee = None
        if body.assignee:
            people = await _resolve_people(db, [body.assignee])
            if not people:
                raise HTTPException(status_code=400, detail=f"找不到帳號 {body.assignee}")
            assignee = people[0]
            if assignee["id"] != me:
                await _check_subtask_assignee(db, user, t, assignee)
        cur = await db.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM task_comments WHERE task_id = ? AND is_task = 1 AND task_parent_id IS ?",
                               (task_id, body.parent))
        order = (await cur.fetchone())["n"]
        cur = await db.execute("""INSERT INTO task_comments (task_id, user_id, body, is_task, title, status, due_at, assignee_id, sort_order, task_parent_id)
                                  VALUES (?, ?, '', 1, ?, 'new', ?, ?, ?, ?)""",
                               (task_id, me, body.title, body.due_at, assignee["id"] if assignee else None, order, body.parent))
        new_id = cur.lastrowid
        await _sync_subtask_members(db, task_id)
        if body.parent:
            await rollup_subtask(db, body.parent)
        await rollup_dates(db, task_id, body.parent)
        await rollup_status(db, task_id)
        if assignee and me is not None and assignee["id"] != me:
            await notify(db, {assignee["id"]}, task_id, user, "assigned", f"{_who(user)} 指派子任務「{body.title}」給你（卡片「{t['title']}」）")
        await db.execute("UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (task_id,))
        await db.commit()
        return {"id": new_id}
    finally:
        await db.close()


async def rollup_all() -> int:
    """Bring every summary card in line with its subtasks (run once at startup, e.g. after an upgrade)."""
    db = await get_db()
    try:
        cur = await db.execute("""SELECT DISTINCT c.task_id FROM task_comments c JOIN tasks t ON t.id = c.task_id
                                  WHERE c.is_task = 1 AND c.parent_id IS NULL AND c.task_parent_id IS NULL AND t.status != 'canceled'""")
        ids = [r[0] for r in await cur.fetchall()]
        changed = 0
        for i in ids:
            cur = await db.execute("SELECT status FROM tasks WHERE id = ?", (i,))
            before = (await cur.fetchone())[0]
            changed += (await rollup_status(db, i)) not in (None, before)
        await db.commit()
        return changed
    finally:
        await db.close()


async def _is_summary(db, task_id: int) -> bool:
    return bool(await _subtask_states(db, task_id))


SUMMARY_MSG = "這張卡片有子任務，狀態依子任務自動計算（要放棄整個任務可以改成 Canceled）"


async def _check_subtask_assignee(db, user: dict, card: dict, person: dict):
    """Board admins: anyone. Department managers: people of their departments or already on the card.
    Everyone else who may edit the card: people already on it (creator, assignees, @mentioned) or themselves."""
    acc = board_access(user)
    if acc["edit"] == "all" or person["id"] == user.get("id"):
        return
    on_card = {card.get("owner_id")} | await _members(db, card["id"], "assignee") | await _members(db, card["id"], "mention")
    if person["id"] in on_card:
        return
    if acc["edit"] == "dept" and (await _members_of(db, [person["id"]])).get(person["id"]) in acc["depts"]:
        return
    if acc["team_edit"] and person["id"] in acc["team"]:
        return
    who = person.get("display_name") or person["username"]
    raise HTTPException(status_code=403, detail=f"{who} 不在這張卡片上，也不是你的下級：先在說明或留言 @{person['username']} 邀請他協作，再指派子任務")


async def _subtask_for_time(db, task_id: int, comment_id: int, user: dict):
    await _get_visible(db, task_id, user)
    c = await _comment(db, task_id, comment_id)
    if not c["is_task"]:
        raise HTTPException(status_code=400, detail="這則留言不是子任務")
    editor = await _can_edit(db, task_id, user)
    if not editor and not (user.get("id") is not None and user.get("id") in await _owners_above(db, comment_id)):
        raise HTTPException(status_code=403, detail="只有子任務（或上層子任務）負責人或能編輯卡片的人可以記錄工時")
    return c, editor


STOP_SQL = """UPDATE task_time SET ended_at = CURRENT_TIMESTAMP,
              minutes = MAX(1, CAST(ROUND((julianday('now') - julianday(started_at)) * 1440) AS INTEGER))
              WHERE ended_at IS NULL AND started_at IS NOT NULL AND """


@router.post("/{task_id}/comments/{comment_id}/timer")
async def subtask_timer(task_id: int, comment_id: int, body: TimerIn, request: Request):
    """Start / stop my timer on a subtask. Starting one stops any other timer I have running."""
    user = current_user(request)
    db = await get_db()
    try:
        c, _ = await _subtask_for_time(db, task_id, comment_id, user)
        uid = user.get("id")
        if body.action == "start":
            if (c["status"] or "new") in CLOSED:
                raise HTTPException(status_code=400, detail="子任務已結案，不能再計時")
            await db.execute(STOP_SQL + "user_id IS ?", (uid,))
            await db.execute("""INSERT INTO task_time (task_id, comment_id, user_id, work_date, started_at)
                                VALUES (?, ?, ?, COALESCE(?, date('now', 'localtime')), CURRENT_TIMESTAMP)""",
                             (task_id, comment_id, uid, body.work_date))
            if (c["status"] or "new") == "new":
                await db.execute("UPDATE task_comments SET status = 'ongoing' WHERE id = ?", (comment_id,))
                await rollup_status(db, task_id)
        else:
            cur = await db.execute("SELECT id FROM task_time WHERE ended_at IS NULL AND started_at IS NOT NULL AND user_id IS ? AND comment_id = ?",
                                   (uid, comment_id))
            running = [r["id"] for r in await cur.fetchall()]
            await db.execute(STOP_SQL + "user_id IS ? AND comment_id = ?", (uid, comment_id))
            if running:                           # hand the entry back so the person can say what the time was for
                cur = await db.execute("SELECT id, minutes, note, work_date FROM task_time WHERE id = ?", (running[-1],))
                e = await cur.fetchone()
                await db.commit()
                return {"success": True, "entry": dict(e) if e else None}
        await db.commit()
        return {"success": True}
    finally:
        await db.close()


@router.post("/{task_id}/comments/{comment_id}/time")
async def add_time(task_id: int, comment_id: int, body: TimeIn, request: Request):
    user = current_user(request)
    db = await get_db()
    try:
        await _subtask_for_time(db, task_id, comment_id, user)
        cur = await db.execute("""INSERT INTO task_time (task_id, comment_id, user_id, minutes, note, work_date, ended_at)
                                  VALUES (?, ?, ?, ?, ?, COALESCE(?, date('now', 'localtime')), CURRENT_TIMESTAMP)""",
                               (task_id, comment_id, user.get("id"), body.minutes, body.note, body.work_date))
        await db.commit()
        return {"id": cur.lastrowid}
    finally:
        await db.close()


class TimeEdit(BaseModel):
    minutes: Optional[int] = None
    note: Optional[str] = None
    work_date: Optional[str] = None

    @field_validator("minutes")
    @classmethod
    def v_minutes(cls, v):
        if v is not None and not 1 <= v <= 24 * 60:
            raise ValueError("工時要在 1 分鐘到 24 小時之間")
        return v

    @field_validator("note")
    @classmethod
    def v_note(cls, v):
        return (v or "").strip()[:200]

    @field_validator("work_date")
    @classmethod
    def v_day(cls, v):
        if v and not re.match(r"^\d{4}-\d{2}-\d{2}$", v):
            raise ValueError("日期格式應為 YYYY-MM-DD")
        return v or None


@router.put("/{task_id}/comments/{comment_id}/time/{entry_id}")
async def edit_time(task_id: int, comment_id: int, entry_id: int, body: TimeEdit, request: Request):
    """Fix a work-log entry: what it was for, how long, which day (own entries, or card editors)."""
    user = current_user(request)
    db = await get_db()
    try:
        await _get_visible(db, task_id, user)
        cur = await db.execute("SELECT user_id, ended_at, started_at FROM task_time WHERE id = ? AND comment_id = ? AND task_id = ?",
                               (entry_id, comment_id, task_id))
        e = await cur.fetchone()
        if not e:
            raise HTTPException(status_code=404, detail="找不到這筆工時")
        if not await _can_edit(db, task_id, user) and not (user.get("id") is not None and e["user_id"] == user.get("id")):
            raise HTTPException(status_code=403, detail="只能修改自己記錄的工時")
        if e["ended_at"] is None and e["started_at"] is not None and body.minutes is not None:
            raise HTTPException(status_code=400, detail="計時中的工時要先停止才能改時數")
        sets, vals = [], []
        for k in ("minutes", "note", "work_date"):
            if k in body.model_fields_set and (k != "minutes" or body.minutes is not None):
                sets.append(f"{k} = ?")
                vals.append(getattr(body, k) or (None if k != "minutes" else getattr(body, k)))
        if sets:
            await db.execute(f"UPDATE task_time SET {', '.join(sets)} WHERE id = ?", (*vals, entry_id))
            await db.commit()
        return {"success": True}
    finally:
        await db.close()


@router.delete("/{task_id}/comments/{comment_id}/time/{entry_id}")
async def delete_time(task_id: int, comment_id: int, entry_id: int, request: Request):
    user = current_user(request)
    db = await get_db()
    try:
        await _get_visible(db, task_id, user)
        cur = await db.execute("SELECT user_id FROM task_time WHERE id = ? AND comment_id = ? AND task_id = ?", (entry_id, comment_id, task_id))
        e = await cur.fetchone()
        if not e:
            raise HTTPException(status_code=404, detail="找不到這筆工時")
        if not await _can_edit(db, task_id, user) and not (user.get("id") is not None and e["user_id"] == user.get("id")):
            raise HTTPException(status_code=403, detail="只能刪除自己記錄的工時")
        await db.execute("DELETE FROM task_time WHERE id = ?", (entry_id,))
        await db.commit()
        return {"success": True}
    finally:
        await db.close()


# -------------------------------------------------------------------- images
# Card images: added / removed by whoever may edit the card, right away (not tied to 儲存).
# Comment images: uploaded as "pending" by the commenter, attached when the comment is posted.
@router.post("/{task_id}/images")
async def upload_image(task_id: int, request: Request, file: UploadFile = File(...), target: str = Form("card"),
                       comment_id: Optional[int] = Form(None)):
    """target=card: on the card; target=comment: pending, attached when the comment is posted;
    target=comment with comment_id: added to that existing comment / subtask right away."""
    user = current_user(request)
    if target not in ("card", "comment"):
        raise HTTPException(status_code=400, detail="target 只能是 card 或 comment")
    data = await file.read(img.MAX_FILE_BYTES + 1)
    db = await get_db()
    try:
        await _get_visible(db, task_id, user)
        if target == "card":
            await _require_edit(db, task_id, user)
            cur = await db.execute("SELECT COUNT(*) AS n FROM task_images WHERE task_id = ? AND comment_id IS NULL AND pending = 0", (task_id,))
            if (await cur.fetchone())["n"] >= img.MAX_PER_CARD:
                raise HTTPException(status_code=400, detail=f"一張卡片最多 {img.MAX_PER_CARD} 個附件")
        elif comment_id:
            c = await _comment(db, task_id, comment_id)
            if not (await _comment_rights(db, task_id, c, user))["edit_body"]:
                raise HTTPException(status_code=403, detail="不能修改這則留言的附件")
            cur = await db.execute("SELECT COUNT(*) AS n FROM task_images WHERE comment_id = ?", (comment_id,))
            limit = img.MAX_PER_CARD if c["is_task"] else img.MAX_PER_COMMENT
            if (await cur.fetchone())["n"] >= limit:
                raise HTTPException(status_code=400, detail=f"最多 {limit} 個附件")
        try:
            stored, mime, kind = img.store(data, file.filename or "")
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        name = os.path.basename((file.filename or "").replace("\\", "/"))[:120] or None
        try:
            cur = await db.execute("""INSERT INTO task_images (task_id, user_id, stored, mime, name, size, pending, kind, comment_id)
                                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                                   (task_id, user.get("id"), stored, mime, name, len(data),
                                    1 if target == "comment" and not comment_id else 0, kind, comment_id if target == "comment" else None))
            if target == "card" or comment_id:
                await db.execute("UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (task_id,))
            await db.commit()
        except Exception:
            img.remove([stored])
            raise
        return {"id": cur.lastrowid, "name": name, "kind": kind, "size": len(data),
                "url": f"/api/tasks/{task_id}/images/{cur.lastrowid}"}
    finally:
        await db.close()


def _ascii_name(name: str) -> str:
    """Fallback filename for old clients: ASCII only, no quotes; keeps the extension."""
    base, dot, ext = name.rpartition(".")
    if not dot:
        base, ext = name, ""
    safe = "".join(c if c.isascii() and c.isprintable() and c not in '"\\;' else "_" for c in base).strip("_ ") or "file"
    return safe + (("." + "".join(c for c in ext if c.isascii() and c.isalnum())) if ext else "")


async def _image_row(db, task_id: int, image_id: int):
    cur = await db.execute("SELECT * FROM task_images WHERE id = ? AND task_id = ?", (image_id, task_id))
    im = await cur.fetchone()
    if not im:
        raise HTTPException(status_code=404, detail="找不到這個附件")
    return im


@router.get("/{task_id}/images/{image_id}")
async def get_image(task_id: int, image_id: int, request: Request):
    user = current_user(request)
    db = await get_db()
    try:
        await _get_visible(db, task_id, user)
        im = await _image_row(db, task_id, image_id)
    finally:
        await db.close()
    p = img.path(im["stored"])
    if not p or not p.is_file():
        raise HTTPException(status_code=404, detail="附件檔案不見了")
    name = im["name"] or im["stored"]
    disposition = "inline" if img.inline(im["stored"]) and request.query_params.get("download") != "1" else "attachment"
    headers = {
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": f"{disposition}; filename=\"{_ascii_name(name)}\"; filename*=UTF-8''{quote(name)}",
    }
    if disposition == "inline" and not im["stored"].endswith(".pdf"):
        # images / text opened in a tab can never run script here. Not sent on downloads (they never
        # render, and Chromium then drops the file name) nor on PDFs (browsers refuse to show a
        # sandboxed PDF; their PDF viewers never run a document's script in this origin).
        headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    return FileResponse(p, media_type=im["mime"], headers=headers)


@router.delete("/{task_id}/images/{image_id}")
async def delete_image(task_id: int, image_id: int, request: Request):
    user = current_user(request)
    db = await get_db()
    try:
        await _get_visible(db, task_id, user)
        im = await _image_row(db, task_id, image_id)
        if im["pending"]:
            if im["user_id"] != user.get("id"):
                raise HTTPException(status_code=403, detail="不是你上傳的附件")
        elif im["comment_id"] is None:
            await _require_edit(db, task_id, user)
        else:
            c = await _comment(db, task_id, im["comment_id"])
            if not (await _comment_rights(db, task_id, c, user))["edit_body"]:
                raise HTTPException(status_code=403, detail="不能修改這則留言的附件")
        await db.execute("DELETE FROM task_images WHERE id = ?", (image_id,))
        if not im["pending"]:
            await db.execute("UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (task_id,))
        await db.commit()
        img.remove([im["stored"]])
        return {"success": True}
    finally:
        await db.close()


def cleanup_images(db_path) -> int:
    """Drop comment images never posted (older than a day) and files no row points at. Sync; for the scheduler."""
    import sqlite3
    con = sqlite3.connect(db_path)
    try:
        cutoff = f"-{img.PENDING_HOURS} hours"
        stale = [r[0] for r in con.execute("SELECT stored FROM task_images WHERE pending = 1 AND created_at < datetime('now', ?)", (cutoff,))]
        con.execute("DELETE FROM task_images WHERE pending = 1 AND created_at < datetime('now', ?)", (cutoff,))
        con.commit()
        img.remove(stale)
        # files uploaded by a standalone copy whose row never arrived (a day is plenty)
        gone = [r[0] for r in con.execute("SELECT stored FROM sync_blobs WHERE created < datetime('now', '-1 day')")]
        con.execute("DELETE FROM sync_blobs WHERE created < datetime('now', '-1 day')")
        con.commit()
        img.remove(gone)
        known = {r[0] for r in con.execute("SELECT stored FROM task_images")} | {r[0] for r in con.execute("SELECT stored FROM sync_blobs")}
    finally:
        con.close()
    return len(stale) + img.sweep_orphans(known)


# ------------------------------------------------------------- notifications
notes_router = APIRouter(prefix="/api/notifications", tags=["tasks"])


class ReadIn(BaseModel):
    ids: Optional[List[int]] = None              # None = all


@notes_router.get("")
async def list_notifications(request: Request):
    user = current_user(request)
    if user.get("id") is None:
        return []
    db = await get_db()
    try:
        cur = await db.execute("""SELECT n.id, n.task_id, n.kind, n.text, n.read, n.created_at
                                  FROM notifications n WHERE n.user_id = ? ORDER BY n.read, n.id DESC LIMIT 50""", (user["id"],))
        return [dict(r) for r in await cur.fetchall()]
    finally:
        await db.close()


@notes_router.post("/read")
async def read_notifications(body: ReadIn, request: Request):
    user = current_user(request)
    if user.get("id") is None:
        return {"success": True}
    db = await get_db()
    try:
        if body.ids:
            await db.execute(f"UPDATE notifications SET read = 1, synced = 0 WHERE read = 0 AND user_id = ? AND id IN ({','.join('?' * len(body.ids))})",
                             (user["id"], *body.ids))
        else:
            await db.execute("UPDATE notifications SET read = 1, synced = 0 WHERE read = 0 AND user_id = ?", (user["id"],))
        await db.execute("DELETE FROM notifications WHERE user_id = ? AND read = 1 AND id NOT IN "
                         "(SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 200)", (user["id"], user["id"]))
        await db.commit()
        return {"success": True}
    finally:
        await db.close()


# ---- backup helpers (used by settings export / import) ----
EXPORT_FIELDS = ("title", "description", "status", "priority", "start_at", "due_at", "remind", "repeat", "repeat_every",
                 "sort_order", "completed_at")


async def export_tasks(db) -> List[dict]:
    cur = await db.execute(f"""SELECT {COLUMNS}, (SELECT username FROM users WHERE id = t.owner_id) AS owner_name
                               FROM tasks t ORDER BY status, sort_order, id""")
    rows = await cur.fetchall()
    out = []
    for r in rows:
        item = {k: r[k] for k in EXPORT_FIELDS if r[k] is not None}
        if r["owner_name"]:
            item["owner"] = r["owner_name"]
        if tags_list(r["tags"]):
            item["tags"] = tags_list(r["tags"])
        cur2 = await db.execute("""SELECT u.username, m.role FROM task_members m JOIN users u ON u.id = m.user_id
                                   WHERE m.task_id = ?""", (r["id"],))
        members = await cur2.fetchall()
        if members:
            item["assignees"] = [m["username"] for m in members if m["role"] == "assignee"]
            item["mentions"] = [m["username"] for m in members if m["role"] == "mention"]
        out.append(item)
    return out


async def import_tasks(db, items) -> int:
    n = 0
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        try:
            t = TaskIn(**{k: item.get(k) for k in ("title", "description", "status", "priority", "start_at", "due_at", "remind",
                                                   "repeat", "repeat_every", "tags") if item.get(k) is not None})
        except Exception:
            continue
        owner = None
        if isinstance(item.get("owner"), str):
            cur = await db.execute("SELECT id FROM users WHERE username = ?", (item["owner"].lower(),))
            row = await cur.fetchone()
            owner = row["id"] if row else None
        cur = await db.execute(
            """INSERT INTO tasks (title, description, status, priority, start_at, due_at, remind, repeat, repeat_every,
                                  sort_order, completed_at, owner_id, tags)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (t.title, t.description, t.status, t.priority, t.start_at, t.due_at, t.remind,
             t.repeat if t.due_at else None, t.repeat_every or 1,
             item["sort_order"] if isinstance(item.get("sort_order"), int) else n,
             item.get("completed_at") if t.status == "complete" else None, owner, tags_json(t.tags)))
        for role, key in (("assignee", "assignees"), ("mention", "mentions")):
            for name in item.get(key) or []:
                if isinstance(name, str):
                    cur2 = await db.execute("SELECT id FROM users WHERE username = ?", (name.lower(),))
                    u = await cur2.fetchone()
                    if u:
                        await db.execute("INSERT OR IGNORE INTO task_members (task_id, user_id, role) VALUES (?, ?, ?)",
                                         (cur.lastrowid, u["id"], role))
        n += 1
    return n
