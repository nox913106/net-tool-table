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
import os
import re
from datetime import date, timedelta
from typing import List, Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, field_validator

from .. import images as img
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
           "overdue_from, overdue_ack, owner_id, sort_order, created_at, updated_at, completed_at")


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
        """INSERT INTO tasks (title, description, status, priority, start_at, due_at, remind, repeat, repeat_every, sort_order, owner_id)
           VALUES (?, ?, 'recurring', ?, ?, ?, ?, ?, ?, ?, ?)""",
        (t["title"], t["description"], t["priority"], _shift(t["start_at"], delta), due, t["remind"],
         t["repeat"], t["repeat_every"] or 1, order, t["owner_id"]))
    new_id = cur.lastrowid
    await db.execute("""INSERT INTO task_members (task_id, user_id, role)
                        SELECT ?, user_id, role FROM task_members WHERE task_id = ?""", (new_id, task_id))
    cur = await db.execute("""SELECT user_id, stored, mime, name, size FROM task_images
                              WHERE task_id = ? AND comment_id IS NULL AND pending = 0 ORDER BY id""", (task_id,))
    for im in await cur.fetchall():
        copied = img.copy(im["stored"])
        if copied:
            await db.execute("""INSERT INTO task_images (task_id, user_id, stored, mime, name, size)
                                VALUES (?, ?, ?, ?, ?, ?)""", (new_id, im["user_id"], copied, im["mime"], im["name"], im["size"]))
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


def _remind(v):
    if v is not None and v not in REMINDS:
        raise ValueError("提醒時間無效")
    return v


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
def _involved_sql(alias: str, uid):
    return (f"({alias}.owner_id = ? OR EXISTS (SELECT 1 FROM task_members vm WHERE vm.task_id = {alias}.id AND vm.user_id = ?))",
            [uid, uid])


def _dept_sql(alias: str, depts: List[str]):
    marks = ",".join("?" * len(depts))
    return (f"(EXISTS (SELECT 1 FROM users ou WHERE ou.id = {alias}.owner_id AND ou.department IN ({marks})) "
            f"OR EXISTS (SELECT 1 FROM task_members dm JOIN users du ON du.id = dm.user_id "
            f"WHERE dm.task_id = {alias}.id AND dm.role = 'assignee' AND du.department IN ({marks})))", [*depts, *depts])


def _scope_sql(user: dict, level: str, alias: str = "t"):
    acc = board_access(user)
    if acc[level] == "all":
        return "1 = 1", []
    inv, args = _involved_sql(alias, user.get("id"))
    if acc[level] == "dept" and acc["depts"]:
        d, dargs = _dept_sql(alias, acc["depts"])
        return f"({inv} OR {d})", args + dargs
    return inv, args


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
    if acc["edit"] != "dept":
        raise HTTPException(status_code=403, detail="只有看板管理者可以指派負責人")
    before = await _members(db, task_id, "assignee") if task_id else set()
    depts = await _members_of(db, [p["id"] for p in people])
    outside = [p for p in people if p["id"] not in before and depts.get(p["id"]) not in acc["depts"]]
    if outside:
        raise HTTPException(status_code=403, detail="只能指派你管理的部門（" + "、".join(acc["depts"]) + "）的人："
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
        f"""SELECT m.task_id, m.role, u.id, u.username, u.display_name, u.department FROM task_members m
            JOIN users u ON u.id = m.user_id WHERE m.task_id IN ({marks}) ORDER BY m.created_at""", ids)
    for m in await cur.fetchall():
        people.setdefault(m["task_id"], {"assignee": [], "mention": []})[m["role"]].append(
            {"id": m["id"], "username": m["username"], "name": m["display_name"] or m["username"], "department": m["department"]})
    owners = {}
    owner_ids = list({r["owner_id"] for r in rows if r.get("owner_id")})
    if owner_ids:
        cur = await db.execute(f"SELECT id, username, display_name, department FROM users WHERE id IN ({','.join('?' * len(owner_ids))})", owner_ids)
        owners = {u["id"]: {"id": u["id"], "username": u["username"], "name": u["display_name"] or u["username"],
                            "department": u["department"]} for u in await cur.fetchall()}
    cur = await db.execute(f"SELECT task_id, COUNT(*) AS c FROM task_comments WHERE task_id IN ({marks}) GROUP BY task_id", ids)
    comments = {c["task_id"]: c["c"] for c in await cur.fetchall()}
    pics = {}
    cur = await db.execute(f"""SELECT id, task_id, name FROM task_images
                               WHERE task_id IN ({marks}) AND comment_id IS NULL AND pending = 0 ORDER BY id""", ids)
    for im in await cur.fetchall():
        pics.setdefault(im["task_id"], []).append(image_dict(im))
    me = user.get("id")
    acc = board_access(user)
    for r in rows:
        p = people.get(r["id"], {"assignee": [], "mention": []})
        r["owner"] = owners.get(r.get("owner_id"))
        r["assignees"] = p["assignee"]
        r["mentions"] = p["mention"]
        r["comments"] = comments.get(r["id"], 0)
        r["images"] = pics.get(r["id"], [])
        involved = me is None or r.get("owner_id") == me or any(x["id"] == me for x in p["assignee"] + p["mention"])
        owner = owners.get(r.get("owner_id"))
        card_depts = {d for d in [owner["department"] if owner else None, *[a["department"] for a in p["assignee"]]] if d}
        r["departments"] = sorted(card_depts)
        in_scope = acc["edit"] == "all" or (acc["edit"] == "dept" and bool(card_depts & set(acc["depts"])))
        r["mine"] = involved
        r["can_edit"] = in_scope or involved
        r["can_delete"] = in_scope or (me is not None and r.get("owner_id") == me)
        r["can_assign"] = in_scope
        r["can_comment"] = True                   # only visible cards are ever returned
    return rows


def image_dict(im) -> dict:
    return {"id": im["id"], "name": im["name"], "url": f"/api/tasks/{im['task_id']}/images/{im['id']}"}


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
        if row and row["active"] and row["source"] == "ldap":
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
                                  sort_order, owner_id, completed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'complete' THEN CURRENT_TIMESTAMP END)""",
            (t.title, t.description, t.status, t.priority, t.start_at, t.due_at, t.remind, repeat, t.repeat_every or 1,
             order, user.get("id"), t.status))
        task_id = cur.lastrowid
        if user.get("id") is not None:
            if t.assignees is not None and board_access(user)["edit"] in ("all", "dept"):
                await _check_assignees(db, user, None, await _resolve_people(db, t.assignees))
                await set_assignees(db, task_id, t.assignees, user, t.title)
            elif user.get("source") == "ldap":
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
        if assignees is not None:
            acc = board_access(user)
            if acc["edit"] == "dept":
                d, dargs = _dept_sql("t", acc["depts"])
                cur = await db.execute(f"SELECT 1 FROM tasks t WHERE t.id = ? AND {d}", (task_id, *dargs))
                if not await cur.fetchone():
                    raise HTTPException(status_code=403, detail="這張卡片不屬於你管理的部門，不能改負責人")
            await _check_assignees(db, user, task_id, await _resolve_people(db, assignees))
        for k in ("title", "status", "priority"):
            if k in changes and changes[k] is None:
                raise HTTPException(status_code=400, detail=f"{k} 不能是空的")
        if "repeat_every" in changes and changes["repeat_every"] is None:
            changes["repeat_every"] = 1
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
        await db.commit()
        return await _one(db, task_id, user)
    finally:
        await db.close()


@router.delete("/{task_id}")
async def delete_task(task_id: int, request: Request):
    user = current_user(request)
    db = await get_db()
    try:
        t = await _get_visible(db, task_id, user)
        acc = board_access(user)
        allowed = acc["edit"] == "all" or (user.get("id") is not None and t.get("owner_id") == user.get("id"))
        if not allowed and acc["edit"] == "dept" and acc["depts"]:
            d, dargs = _dept_sql("t", acc["depts"])
            cur = await db.execute(f"SELECT 1 FROM tasks t WHERE t.id = ? AND {d}", (task_id, *dargs))
            allowed = bool(await cur.fetchone())
        if not allowed:
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
class CommentIn(BaseModel):
    body: str = ""
    images: List[int] = []

    @field_validator("body")
    @classmethod
    def v_body(cls, v):
        return (v or "").strip()[:4000]

    @field_validator("images")
    @classmethod
    def v_images(cls, v):
        v = list(dict.fromkeys(v or []))
        if len(v) > img.MAX_PER_COMMENT:
            raise ValueError(f"一則留言最多 {img.MAX_PER_COMMENT} 張圖片")
        return v


@router.get("/{task_id}/comments")
async def list_comments(task_id: int, request: Request):
    user = current_user(request)
    db = await get_db()
    try:
        await _get_visible(db, task_id, user)
        cur = await db.execute("""SELECT c.id, c.body, c.created_at, c.user_id, u.username, u.display_name
                                  FROM task_comments c LEFT JOIN users u ON u.id = c.user_id
                                  WHERE c.task_id = ? ORDER BY c.id""", (task_id,))
        rows = await cur.fetchall()
        cur = await db.execute("""SELECT id, task_id, comment_id, name FROM task_images
                                  WHERE task_id = ? AND comment_id IS NOT NULL ORDER BY id""", (task_id,))
        pics = {}
        for im in await cur.fetchall():
            pics.setdefault(im["comment_id"], []).append(image_dict(im))
        return [{"id": c["id"], "body": c["body"], "created_at": c["created_at"], "images": pics.get(c["id"], []),
                 "author": {"id": c["user_id"], "username": c["username"], "name": c["display_name"] or c["username"] or "本機"},
                 "can_delete": board_access(user)["edit"] == "all" or (c["user_id"] is not None and c["user_id"] == user.get("id"))}
                for c in rows]
    finally:
        await db.close()


@router.post("/{task_id}/comments")
async def add_comment(task_id: int, body: CommentIn, request: Request):
    user = current_user(request)
    db = await get_db()
    try:
        t = await _get_visible(db, task_id, user)
        pics = []
        if body.images:
            cur = await db.execute(f"""SELECT id FROM task_images WHERE task_id = ? AND pending = 1 AND user_id IS ?
                                       AND id IN ({','.join('?' * len(body.images))})""", (task_id, user.get("id"), *body.images))
            pics = [r["id"] for r in await cur.fetchall()]
            if len(pics) != len(body.images):
                raise HTTPException(status_code=400, detail="有圖片已失效，請重新附加")
        if not body.body and not pics:
            raise HTTPException(status_code=400, detail="請輸入留言或附加圖片")
        cur = await db.execute("INSERT INTO task_comments (task_id, user_id, body) VALUES (?, ?, ?)", (task_id, user.get("id"), body.body))
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
            await notify(db, people - already, task_id, user, "comment", f"{_who(user)} 在「{t['title']}」留言：{body.body[:60] or f'（{len(pics)} 張圖片）'}")
        await db.execute("UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (task_id,))
        await db.commit()
        return {"id": comment_id}
    finally:
        await db.close()


@router.delete("/{task_id}/comments/{comment_id}")
async def delete_comment(task_id: int, comment_id: int, request: Request):
    user = current_user(request)
    db = await get_db()
    try:
        await _get_visible(db, task_id, user)
        cur = await db.execute("SELECT user_id FROM task_comments WHERE id = ? AND task_id = ?", (comment_id, task_id))
        c = await cur.fetchone()
        if not c:
            raise HTTPException(status_code=404, detail="找不到這則留言")
        if board_access(user)["edit"] != "all" and c["user_id"] != user.get("id"):
            raise HTTPException(status_code=403, detail="只能刪除自己的留言")
        cur = await db.execute("SELECT stored FROM task_images WHERE comment_id = ?", (comment_id,))
        files = [r["stored"] for r in await cur.fetchall()]
        await db.execute("DELETE FROM task_comments WHERE id = ?", (comment_id,))
        await db.commit()
        img.remove(files)
        return {"success": True}
    finally:
        await db.close()


# -------------------------------------------------------------------- images
# Card images: added / removed by whoever may edit the card, right away (not tied to 儲存).
# Comment images: uploaded as "pending" by the commenter, attached when the comment is posted.
@router.post("/{task_id}/images")
async def upload_image(task_id: int, request: Request, file: UploadFile = File(...), target: str = Form("card")):
    user = current_user(request)
    if target not in ("card", "comment"):
        raise HTTPException(status_code=400, detail="target 只能是 card 或 comment")
    data = await file.read(img.MAX_BYTES + 1)
    db = await get_db()
    try:
        await _get_visible(db, task_id, user)
        if target == "card":
            await _require_edit(db, task_id, user)
            cur = await db.execute("SELECT COUNT(*) AS n FROM task_images WHERE task_id = ? AND comment_id IS NULL AND pending = 0", (task_id,))
            if (await cur.fetchone())["n"] >= img.MAX_PER_CARD:
                raise HTTPException(status_code=400, detail=f"一張卡片最多 {img.MAX_PER_CARD} 張圖片")
        try:
            stored, mime = img.store(data)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        name = os.path.basename((file.filename or "").replace("\\", "/"))[:120] or None
        try:
            cur = await db.execute("""INSERT INTO task_images (task_id, user_id, stored, mime, name, size, pending)
                                      VALUES (?, ?, ?, ?, ?, ?, ?)""",
                                   (task_id, user.get("id"), stored, mime, name, len(data), 1 if target == "comment" else 0))
            if target == "card":
                await db.execute("UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (task_id,))
            await db.commit()
        except Exception:
            img.remove([stored])
            raise
        return {"id": cur.lastrowid, "name": name, "url": f"/api/tasks/{task_id}/images/{cur.lastrowid}"}
    finally:
        await db.close()


async def _image_row(db, task_id: int, image_id: int):
    cur = await db.execute("SELECT * FROM task_images WHERE id = ? AND task_id = ?", (image_id, task_id))
    im = await cur.fetchone()
    if not im:
        raise HTTPException(status_code=404, detail="找不到這張圖片")
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
        raise HTTPException(status_code=404, detail="圖片檔案不見了")
    return FileResponse(p, media_type=im["mime"], headers={
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": "inline",
    })


@router.delete("/{task_id}/images/{image_id}")
async def delete_image(task_id: int, image_id: int, request: Request):
    user = current_user(request)
    db = await get_db()
    try:
        await _get_visible(db, task_id, user)
        im = await _image_row(db, task_id, image_id)
        if im["pending"]:
            if im["user_id"] != user.get("id"):
                raise HTTPException(status_code=403, detail="不是你上傳的圖片")
        elif im["comment_id"] is None:
            await _require_edit(db, task_id, user)
        else:
            raise HTTPException(status_code=400, detail="留言裡的圖片要連同留言一起刪除")
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
        known = {r[0] for r in con.execute("SELECT stored FROM task_images")}
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
            await db.execute(f"UPDATE notifications SET read = 1 WHERE user_id = ? AND id IN ({','.join('?' * len(body.ids))})",
                             (user["id"], *body.ids))
        else:
            await db.execute("UPDATE notifications SET read = 1 WHERE user_id = ?", (user["id"],))
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
                                                   "repeat", "repeat_every") if item.get(k) is not None})
        except Exception:
            continue
        owner = None
        if isinstance(item.get("owner"), str):
            cur = await db.execute("SELECT id FROM users WHERE username = ?", (item["owner"].lower(),))
            row = await cur.fetchone()
            owner = row["id"] if row else None
        cur = await db.execute(
            """INSERT INTO tasks (title, description, status, priority, start_at, due_at, remind, repeat, repeat_every,
                                  sort_order, completed_at, owner_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (t.title, t.description, t.status, t.priority, t.start_at, t.due_at, t.remind,
             t.repeat if t.due_at else None, t.repeat_every or 1,
             item["sort_order"] if isinstance(item.get("sort_order"), int) else n,
             item.get("completed_at") if t.status == "complete" else None, owner))
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
