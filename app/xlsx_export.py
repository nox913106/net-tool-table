"""
Board cards → Excel workbook (.xlsx).

Sheets
  卡片    one row per card: status, priority, dates, people, subtask progress, hours, description …
  子任務  one row per subtask (in the card's subtask order)
  留言    comments and replies (subtask texts are in 子任務)
  工時    every logged time entry
Every sheet has a bold frozen header row and filters, so it is ready to sort and pivot.
The caller passes only cards the user may see (routes/tasks.py export_xlsx).
"""
import io
import re
from datetime import date, datetime
from typing import Dict, List

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

STATUS = {"recurring": "週期工作", "overdue": "過期未結案", "new": "New（新建）", "ongoing": "On going（進行中）",
          "pending": "Pending（待確認）", "onhold": "On hold（暫緩）", "complete": "Complete（完成）", "canceled": "Canceled（取消）"}
PRIORITY = {"low": "低", "normal": "一般", "high": "高"}
REMIND = {0: "到期時", 15: "15 分鐘前", 60: "1 小時前", 1440: "1 天前", 2880: "2 天前", 10080: "1 週前"}
REPEAT_UNIT = {"daily": "天", "weekly": "週", "monthly": "個月", "yearly": "年"}
WEEK = "一二三四五六日"
HEAD_FILL = PatternFill("solid", fgColor="E8EAF6")
ILLEGAL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")           # characters Excel refuses


def _txt(v):
    if v is None:
        return None
    v = ILLEGAL.sub("", str(v))
    if v[:1] in ("=", "+", "-", "@"):                            # never let a cell become a formula
        v = "'" + v
    return v[:32000]


def _dt(v):
    """'YYYY-MM-DD' → date, 'YYYY-MM-DDTHH:MM' / SQLite timestamps → datetime (Excel dates)."""
    if not v:
        return None
    s = str(v).replace(" ", "T")
    try:
        if len(s) == 10:
            return datetime.strptime(s, "%Y-%m-%d").date()
        return datetime.fromisoformat(s[:19])
    except ValueError:
        return _txt(v)


def _hours(minutes):
    return round((minutes or 0) / 60, 2) if minutes else None


def repeat_text(rule, every):
    if not rule:
        return None
    kind, _, arg = rule.partition(":")
    n = every or 1
    if kind == "weekdays":
        return "每個工作日"
    if kind == "weekly" and arg:
        days = "、".join("週" + WEEK[int(d) - 1] for d in arg.split(",") if d.isdigit() and 1 <= int(d) <= 7)
        return (f"每 {n} 週" if n > 1 else "每週") + (f"（{days}）" if days else "")
    if kind == "monthly" and arg:
        return (f"每 {n} 個月" if n > 1 else "每月") + f" {arg} 日"
    unit = REPEAT_UNIT.get(kind, kind)
    return f"每 {n} {unit}" if n > 1 else f"每{unit}"


def _sheet(wb, title, columns, rows, first=False):
    ws = wb.active if first else wb.create_sheet()
    ws.title = title
    ws.append([c[0] for c in columns])
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.fill = HEAD_FILL
        cell.alignment = Alignment(vertical="center")
    for r in rows:
        ws.append(r)
    for i, (name, width, kind) in enumerate(columns, start=1):
        letter = get_column_letter(i)
        ws.column_dimensions[letter].width = width
        fmt = {"date": "yyyy-mm-dd", "datetime": "yyyy-mm-dd hh:mm", "hours": "0.00", "pct": "0%"}.get(kind)
        for cell in ws[letter][1:]:
            if fmt and not isinstance(cell.value, str):
                # an all-day date stays a date; a date with a time shows the time
                cell.number_format = "yyyy-mm-dd" if kind == "datetime" and type(cell.value) is date else fmt
            if kind == "wrap":
                cell.alignment = Alignment(wrap_text=True, vertical="top")
            elif kind != "wrap":
                cell.alignment = Alignment(vertical="top")
    ws.freeze_panes = "B2" if len(columns) > 2 else "A2"
    if rows:
        ws.auto_filter.ref = f"A1:{get_column_letter(len(columns))}{len(rows) + 1}"
    return ws


def build(cards: List[dict], subtasks: Dict[int, list], comments: Dict[int, list], times: Dict[int, list],
          files: Dict[int, list], names: Dict[int, str], op_url: str = "") -> bytes:
    """cards: dict rows (+ owner_id, assignees, mentions, departments, op_work_package); the other
    dicts are keyed by card id. names: user id → display name."""
    who = lambda uid: names.get(uid) if uid else None
    wb = Workbook()

    card_rows = []
    for t in cards:
        subs = subtasks.get(t["id"], [])
        counted = [s for s in subs if s["status"] != "canceled"]
        done = sum(1 for s in counted if s["status"] == "complete")
        est = sum(s["estimate_minutes"] or 0 for s in subs)
        spent = sum(e["minutes"] or 0 for e in times.get(t["id"], []))
        wp = t.get("op_work_package")
        card_rows.append([
            t["id"], _txt(t["title"]), STATUS.get(t["status"], t["status"]), PRIORITY.get(t["priority"], t["priority"]),
            _dt(t["start_at"]), _dt(t["due_at"]), REMIND.get(t["remind"]) if t["due_at"] else None,
            repeat_text(t["repeat"], t["repeat_every"]),
            _txt(who(t["owner_id"])), _txt("、".join(t.get("assignees") or [])) or None, _txt("、".join(t.get("mentions") or [])) or None,
            _txt("、".join(t.get("departments") or [])) or None,
            f"{done}/{len(counted)}" if subs else None, (done / len(counted)) if counted else None,
            _hours(est), _hours(spent), len(comments.get(t["id"], [])) or None,
            _txt("、".join(f["name"] for f in files.get(t["id"], []) if f["comment_id"] is None)) or None,
            _dt(t["created_at"]), _dt(t["updated_at"]), _dt(t["completed_at"]),
            (f"#{wp}" if wp else None), _txt(t["description"]),
        ])
    _sheet(wb, "卡片", [
        ("ID", 7, ""), ("標題", 36, "wrap"), ("狀態", 18, ""), ("優先", 7, ""), ("開始", 16, "datetime"), ("到期", 16, "datetime"),
        ("提醒", 11, ""), ("重複", 16, ""), ("建立者", 12, ""), ("負責人", 18, ""), ("協作", 18, ""), ("部門", 14, ""),
        ("子任務完成", 11, ""), ("進度", 8, "pct"), ("預估工時(h)", 11, "hours"), ("已記錄工時(h)", 13, "hours"), ("留言數", 8, ""),
        ("附件", 24, "wrap"), ("建立時間(UTC)", 17, "datetime"), ("更新時間(UTC)", 17, "datetime"), ("完成時間(UTC)", 17, "datetime"),
        ("OpenProject", 12, ""), ("說明", 60, "wrap"),
    ], card_rows, first=True)

    title_of = {t["id"]: t["title"] for t in cards}
    sub_rows, sub_title = [], {}
    for t in cards:
        for n, s in enumerate(subtasks.get(t["id"], []), start=1):
            sub_title[s["id"]] = s["title"]
            spent = sum(e["minutes"] or 0 for e in times.get(t["id"], []) if e["comment_id"] == s["id"])
            desc = s["body"] if s["body"] and s["body"].strip() != (s["title"] or "").strip() else None
            sub_rows.append([
                t["id"], _txt(t["title"]), n, _txt(s["title"]), STATUS.get(s["status"] or "new"), PRIORITY.get(s["priority"] or "normal"),
                _txt(who(s["assignee_id"])), _dt(s["start_at"]), _dt(s["due_at"]), REMIND.get(s["remind"]) if s["due_at"] else None,
                _hours(s["estimate_minutes"]), _hours(spent), _dt(s["completed_at"]),
                _txt("、".join(f["name"] for f in files.get(t["id"], []) if f["comment_id"] == s["id"])) or None, _txt(desc),
            ])
    _sheet(wb, "子任務", [
        ("卡片 ID", 8, ""), ("卡片", 28, "wrap"), ("#", 5, ""), ("子任務", 32, "wrap"), ("狀態", 18, ""), ("優先", 7, ""),
        ("負責人", 12, ""), ("開始", 16, "datetime"), ("到期", 16, "datetime"), ("提醒", 11, ""), ("預估工時(h)", 11, "hours"),
        ("已記錄工時(h)", 13, "hours"), ("完成時間(UTC)", 17, "datetime"), ("附件", 24, "wrap"), ("說明", 50, "wrap"),
    ], sub_rows)

    com_rows = []
    for t in cards:
        rows = comments.get(t["id"], [])
        by_id = {c["id"]: c for c in rows}
        for c in rows:
            if c["is_task"] and c["parent_id"] is None:
                continue                                     # a subtask's text is in 子任務
            root = by_id.get(c["parent_id"]) if c["parent_id"] else None
            thread = (root and (root["title"] if root["is_task"] else None)) or None
            com_rows.append([
                t["id"], _txt(t["title"]), _txt(thread), _dt(c["created_at"]), _txt(who(c["user_id"]) or "本機"),
                _txt(who(root["user_id"]) or "本機") if root else None, _txt(c["body"]),
                _txt("、".join(f["name"] for f in files.get(t["id"], []) if f["comment_id"] == c["id"])) or None,
                _dt(c["edited_at"]),
            ])
    _sheet(wb, "留言", [
        ("卡片 ID", 8, ""), ("卡片", 28, "wrap"), ("子任務", 22, "wrap"), ("時間(UTC)", 17, "datetime"), ("作者", 12, ""),
        ("回覆給", 12, ""), ("內容", 70, "wrap"), ("附件", 24, "wrap"), ("編輯時間(UTC)", 17, "datetime"),
    ], com_rows)

    time_rows = []
    for t in cards:
        for e in times.get(t["id"], []):
            time_rows.append([t["id"], _txt(t["title"]), _txt(sub_title.get(e["comment_id"])), _txt(who(e["user_id"]) or "本機"),
                              _dt(e["work_date"]), _hours(e["minutes"]), _txt(e["note"])])
    _sheet(wb, "工時", [
        ("卡片 ID", 8, ""), ("卡片", 28, "wrap"), ("子任務", 28, "wrap"), ("人員", 12, ""), ("日期", 12, "date"),
        ("工時(h)", 9, "hours"), ("備註", 40, "wrap"),
    ], time_rows)

    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()
