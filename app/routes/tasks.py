"""
Task board (kanban) — cards in six columns with start / due dates and reminders.

Dates are local wall-clock strings: "YYYY-MM-DD" (all day) or "YYYY-MM-DDTHH:MM".
The browser works out what is overdue / due soon and shows the reminders, so the
server never has to guess the viewer's time zone.
"""
import re
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

from ..database import get_db

router = APIRouter(prefix="/api/tasks", tags=["tasks"])

STATUSES = ("new", "ongoing", "pending", "onhold", "complete", "canceled")
PRIORITIES = ("low", "normal", "high")
REMINDS = (0, 15, 60, 1440, 2880, 10080)       # minutes before due; None = no reminder
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$")
COLUMNS = "id, title, description, status, priority, start_at, due_at, remind, sort_order, created_at, updated_at, completed_at"


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


def _check_dates(start, due):
    if start and due and start[:10] > due[:10]:
        raise HTTPException(status_code=400, detail="開始日不能晚於到期日")


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
    _check_dates(t.start_at, t.due_at)
    db = await get_db()
    try:
        cur = await db.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM tasks WHERE status = ?", (t.status,))
        order = (await cur.fetchone())["n"]
        cur = await db.execute(
            """INSERT INTO tasks (title, description, status, priority, start_at, due_at, remind, sort_order, completed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'complete' THEN CURRENT_TIMESTAMP END)""",
            (t.title, t.description, t.status, t.priority, t.start_at, t.due_at, t.remind, order, t.status))
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
        merged = {**cur_task, **changes}
        _check_dates(merged["start_at"], merged["due_at"])
        if not changes:
            return cur_task
        sets = [f"{k} = ?" for k in changes]
        vals = list(changes.values())
        if "status" in changes and changes["status"] != cur_task["status"]:
            cur = await db.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM tasks WHERE status = ?", (changes["status"],))
            sets.append("sort_order = ?")
            vals.append((await cur.fetchone())["n"])
            sets.append("completed_at = CASE WHEN ? = 'complete' THEN CURRENT_TIMESTAMP END")
            vals.append(changes["status"])
        sets.append("updated_at = CURRENT_TIMESTAMP")
        await db.execute(f"UPDATE tasks SET {', '.join(sets)} WHERE id = ?", (*vals, task_id))
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
        for i, task_id in enumerate(r.ids):
            await db.execute(
                """UPDATE tasks SET
                       completed_at = CASE WHEN ? = 'complete' THEN COALESCE(CASE WHEN status = 'complete' THEN completed_at END, CURRENT_TIMESTAMP) END,
                       updated_at = CASE WHEN status != ? THEN CURRENT_TIMESTAMP ELSE updated_at END,
                       status = ?, sort_order = ?
                   WHERE id = ?""",
                (r.status, r.status, r.status, i, task_id))
        await db.commit()
        return {"success": True}
    finally:
        await db.close()


# ---- backup helpers (used by settings export / import) ----
EXPORT_FIELDS = ("title", "description", "status", "priority", "start_at", "due_at", "remind", "sort_order", "completed_at")


async def export_tasks(db) -> List[dict]:
    cur = await db.execute(f"SELECT {COLUMNS} FROM tasks ORDER BY status, sort_order, id")
    return [{k: r[k] for k in EXPORT_FIELDS if r[k] is not None} for r in await cur.fetchall()]


async def import_tasks(db, items) -> int:
    n = 0
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        try:
            t = TaskIn(**{k: item.get(k) for k in ("title", "description", "status", "priority", "start_at", "due_at", "remind") if item.get(k) is not None})
        except Exception:
            continue
        await db.execute(
            """INSERT INTO tasks (title, description, status, priority, start_at, due_at, remind, sort_order, completed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (t.title, t.description, t.status, t.priority, t.start_at, t.due_at, t.remind,
             item["sort_order"] if isinstance(item.get("sort_order"), int) else n, item.get("completed_at") if t.status == "complete" else None))
        n += 1
    return n
