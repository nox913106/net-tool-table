"""
Task board (kanban) — cards in seven columns with start / due dates and reminders.

Recurring cards ("repeat" rule) are anchored on their due date. When one is closed
(status → complete, by the close prompt, the editor or a drag) the next occurrence is
created once, in the "recurring" column (週期工作).

One-off cards that pass their due date while still open are moved to the "overdue"
column (過期未結案) by /sweep, which the browser calls with its local time. If you move
a card out of that column yourself it stays where you put it (until its due date
changes); pushing the due date into the future moves it back to where it came from.

Dates are local wall-clock strings: "YYYY-MM-DD" (all day) or "YYYY-MM-DDTHH:MM".
The browser works out what is overdue / due soon and shows the reminders, so the
server never has to guess the viewer's time zone.
"""
import calendar
import re
from datetime import date, timedelta
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

from ..database import get_db

router = APIRouter(prefix="/api/tasks", tags=["tasks"])

STATUSES = ("recurring", "overdue", "new", "ongoing", "pending", "onhold", "complete", "canceled")
CLOSED = ("complete", "canceled")
PRIORITIES = ("low", "normal", "high")
REMINDS = (0, 15, 60, 1440, 2880, 10080)       # minutes before due; None = no reminder
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$")
REPEAT_RE = re.compile(r"^(daily|weekdays|weekly:[1-7](,[1-7]){0,6}|monthly(:\d{1,2})?|yearly)$")
COLUMNS = ("id, title, description, status, priority, start_at, due_at, remind, repeat, repeat_every, next_id, "
           "overdue_from, overdue_ack, sort_order, created_at, updated_at, completed_at")


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
        """INSERT INTO tasks (title, description, status, priority, start_at, due_at, remind, repeat, repeat_every, sort_order)
           VALUES (?, ?, 'recurring', ?, ?, ?, ?, ?, ?, ?)""",
        (t["title"], t["description"], t["priority"], _shift(t["start_at"], delta), due, t["remind"],
         t["repeat"], t["repeat_every"] or 1, order))
    new_id = cur.lastrowid
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


@router.get("")
async def list_tasks():
    db = await get_db()
    try:
        cur = await db.execute(f"SELECT {COLUMNS} FROM tasks ORDER BY sort_order, id")
        return [row_dict(r) for r in await cur.fetchall()]
    finally:
        await db.close()


@router.post("")
async def create_task(t: TaskIn):
    _check_dates(t.start_at, t.due_at, t.repeat)
    repeat = _monthly_anchor(t.repeat, t.due_at)
    db = await get_db()
    try:
        cur = await db.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM tasks WHERE status = ?", (t.status,))
        order = (await cur.fetchone())["n"]
        cur = await db.execute(
            """INSERT INTO tasks (title, description, status, priority, start_at, due_at, remind, repeat, repeat_every,
                                  sort_order, completed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'complete' THEN CURRENT_TIMESTAMP END)""",
            (t.title, t.description, t.status, t.priority, t.start_at, t.due_at, t.remind, repeat, t.repeat_every or 1,
             order, t.status))
        await db.commit()
        return await _get(db, cur.lastrowid)
    finally:
        await db.close()


@router.put("/{task_id}")
async def update_task(task_id: int, t: TaskUpdate):
    db = await get_db()
    try:
        cur_task = await _get(db, task_id)
        changes = {k: getattr(t, k) for k in t.model_fields_set}
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
        if not changes:
            return cur_task
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
        if changes.get("status") == "complete" and cur_task["status"] != "complete":
            await spawn_next(db, task_id)
        await db.commit()
        return await _get(db, task_id)
    finally:
        await db.close()


@router.delete("/{task_id}")
async def delete_task(task_id: int):
    db = await get_db()
    try:
        await _get(db, task_id)
        await db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        await db.commit()
        return {"success": True}
    finally:
        await db.close()


@router.post("/reorder")
async def reorder(r: Reorder):
    """Put `ids` (in this order) into column `status` — used after a drag and drop."""
    db = await get_db()
    try:
        if r.status != "overdue" and r.ids:             # dragged out of 過期未結案 by hand
            marks = ",".join("?" * len(r.ids))
            await db.execute(f"""UPDATE tasks SET overdue_ack = due_at, overdue_from = NULL
                                 WHERE status = 'overdue' AND id IN ({marks})""", r.ids)
        closing = []
        if r.status == "complete":
            marks = ",".join("?" * len(r.ids)) or "NULL"
            cur = await db.execute(f"SELECT id FROM tasks WHERE status != 'complete' AND id IN ({marks})", r.ids)
            closing = [row["id"] for row in await cur.fetchall()]
        for i, task_id in enumerate(r.ids):
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
async def sweep(body: SweepIn):
    """Move open one-off cards past their due date to 過期未結案, and move cards whose due
    date was pushed into the future back out. Idempotent; safe to call often."""
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
async def complete_task(task_id: int, body: Optional[CompleteIn] = None):
    """Close a card; for a recurring card also create the next occurrence (once)."""
    db = await get_db()
    try:
        t = await _get(db, task_id)
        if t["status"] != "complete":
            cur = await db.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM tasks WHERE status = 'complete'")
            order = (await cur.fetchone())["n"]
            await db.execute("""UPDATE tasks SET status = 'complete', sort_order = ?, completed_at = CURRENT_TIMESTAMP,
                                updated_at = CURRENT_TIMESTAMP WHERE id = ?""", (order, task_id))
        today = date.fromisoformat(body.today) if body and body.today else None
        next_id = await spawn_next(db, task_id, today)
        await db.commit()
        return {"task": await _get(db, task_id), "next": await _get(db, next_id) if next_id else None}
    finally:
        await db.close()


# ---- backup helpers (used by settings export / import) ----
EXPORT_FIELDS = ("title", "description", "status", "priority", "start_at", "due_at", "remind", "repeat", "repeat_every",
                 "sort_order", "completed_at")


async def export_tasks(db) -> List[dict]:
    cur = await db.execute(f"SELECT {COLUMNS} FROM tasks ORDER BY status, sort_order, id")
    return [{k: r[k] for k in EXPORT_FIELDS if r[k] is not None} for r in await cur.fetchall()]


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
        await db.execute(
            """INSERT INTO tasks (title, description, status, priority, start_at, due_at, remind, repeat, repeat_every,
                                  sort_order, completed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (t.title, t.description, t.status, t.priority, t.start_at, t.due_at, t.remind,
             t.repeat if t.due_at else None, t.repeat_every or 1,
             item["sort_order"] if isinstance(item.get("sort_order"), int) else n, item.get("completed_at") if t.status == "complete" else None))
        n += 1
    return n
