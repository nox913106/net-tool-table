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


# ------------------------------------------------------------ one sheet, as a tree
STATUS_FILL = {"recurring": "CCFBF1", "overdue": "FFE4E6", "new": "F1F5F9", "ongoing": "DBEAFE", "pending": "FEF3C7",
               "onhold": "F3E8FF", "complete": "D1FAE5", "canceled": "FEE2E2"}
KIND_FONT = {0: Font(bold=True, size=12), 1: Font(bold=True), 2: Font(color="555555")}


def build_tree(cards: List[dict], subtasks: Dict[int, list], comments: Dict[int, list], times: Dict[int, list],
               files: Dict[int, list], names: Dict[int, str]) -> bytes:
    """Everything on one sheet with Excel row grouping (outline):
         1      card
         1.1      subtask            ← its replies and time entries one level below
         —        comment on the card ← its replies one level below
    so the +/- buttons on the left fold a card or a subtask, and filters still work on every column."""
    who = lambda uid: (names.get(uid) if uid else None) or "本機"
    wb = Workbook()
    ws = wb.active
    ws.title = "看板"
    cols = [("編號", 8), ("類型", 8), ("標題／內容", 46), ("狀態", 17), ("優先", 6), ("負責人／作者", 13),
            ("開始", 16), ("到期／時間", 16), ("提醒", 10), ("預估工時(h)", 11), ("已記錄工時(h)", 12), ("進度", 8),
            ("附件", 22), ("說明", 50), ("重複", 14), ("部門", 12), ("卡片 ID", 8), ("OpenProject", 11), ("完成時間(UTC)", 16)]
    ws.append([c[0] for c in cols])
    for i, (_, w) in enumerate(cols, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.fill = HEAD_FILL
    ws.sheet_properties.outlinePr.summaryBelow = False       # the card / subtask row is above its children
    rows = []                                                # (level, kind, values, status)

    def files_of(card_id, comment_id):
        return _txt("、".join(f["name"] for f in files.get(card_id, []) if f["comment_id"] == comment_id)) or None

    for n, t in enumerate(cards, start=1):
        subs = subtasks.get(t["id"], [])
        counted = [s for s in subs if s["status"] != "canceled"]
        done = sum(1 for s in counted if s["status"] == "complete")
        card_times = times.get(t["id"], [])
        people = "、".join(t.get("assignees") or []) or (names.get(t["owner_id"]) if t.get("owner_id") else None)
        wp = t.get("op_work_package")
        rows.append((0, "卡片", [
            str(n), "卡片", _txt(t["title"]), STATUS.get(t["status"], t["status"]), PRIORITY.get(t["priority"], t["priority"]),
            _txt(people), _dt(t["start_at"]), _dt(t["due_at"]), REMIND.get(t["remind"]) if t["due_at"] else None,
            _hours(sum(s["estimate_minutes"] or 0 for s in subs)), _hours(sum(e["minutes"] or 0 for e in card_times)),
            (done / len(counted)) if counted else None, files_of(t["id"], None), _txt(t["description"]),
            repeat_text(t["repeat"], t["repeat_every"]), _txt("、".join(t.get("departments") or [])) or None, t["id"],
            f"#{wp}" if wp else None, _dt(t["completed_at"])], t["status"]))
        all_comments = comments.get(t["id"], [])
        replies = {}
        for c in all_comments:
            if c["parent_id"]:
                replies.setdefault(c["parent_id"], []).append(c)

        def reply_rows(parent, level):
            for r in replies.get(parent["id"], []):
                rows.append((level, "回覆", [
                    None, "回覆", _txt(r["body"]), None, None, _txt(who(r["user_id"])), None, _dt(r["created_at"]), None,
                    None, None, None, files_of(t["id"], r["id"]), None, None, None, t["id"], None, None], None))

        for m, s in enumerate(subs, start=1):
            spent = [e for e in card_times if e["comment_id"] == s["id"]]
            desc = s["body"] if s["body"] and s["body"].strip() != (s["title"] or "").strip() else None
            st = s["status"] or "new"
            rows.append((1, "子任務", [
                f"{n}.{m}", "子任務", _txt(s["title"]), STATUS.get(st), PRIORITY.get(s["priority"] or "normal"),
                _txt(names.get(s["assignee_id"])) if s["assignee_id"] else None, _dt(s["start_at"]), _dt(s["due_at"]),
                REMIND.get(s["remind"]) if s["due_at"] else None, _hours(s["estimate_minutes"]), _hours(sum(e["minutes"] or 0 for e in spent)),
                1.0 if st == "complete" else None, files_of(t["id"], s["id"]), _txt(desc), None, None, t["id"], None, _dt(s["completed_at"])], st))
            reply_rows(s, 2)
            for e in spent:
                rows.append((2, "工時", [
                    None, "工時", _txt(f"{who(e['user_id'])} {_hours(e['minutes'])}h" + (f"：{e['note']}" if e["note"] else "")), None, None,
                    _txt(who(e["user_id"])), None, _dt(e["work_date"]), None, None, _hours(e["minutes"]), None, None, None, None, None,
                    t["id"], None, None], None))
        for c in all_comments:
            if c["parent_id"] is None and not c["is_task"]:
                rows.append((1, "留言", [
                    None, "留言", _txt(c["body"]), None, None, _txt(who(c["user_id"])), None, _dt(c["created_at"]), None,
                    None, None, None, files_of(t["id"], c["id"]), None, None, None, t["id"], None, None], None))
                reply_rows(c, 2)

    for level, kind, values, status in rows:
        if level and isinstance(values[2], str):          # visible tree in every viewer (some ignore cell indent)
            values[2] = "　" * (level - 1) + "└ " + values[2]
        ws.append(values)
        r = ws.max_row
        if level:
            ws.row_dimensions[r].outline_level = level
        font = KIND_FONT.get(level)
        fill = PatternFill("solid", fgColor=STATUS_FILL[status]) if status in STATUS_FILL and level < 2 else None
        for i, cell in enumerate(ws[r], start=1):
            name = cols[i - 1][0]
            wrap = name in ("標題／內容", "說明", "附件")
            cell.alignment = Alignment(vertical="top", wrap_text=wrap, indent=level if name == "標題／內容" else 0)
            if font and name in ("編號", "標題／內容"):
                cell.font = font
            if fill and name in ("編號", "類型", "標題／內容", "狀態"):
                cell.fill = fill
            if isinstance(cell.value, (int, float)) and name.endswith("(h)"):
                cell.number_format = "0.00"
            elif name == "進度" and cell.value is not None:
                cell.number_format = "0%"
            elif name in ("開始", "到期／時間", "完成時間(UTC)") and cell.value is not None and not isinstance(cell.value, str):
                cell.number_format = "yyyy-mm-dd" if type(cell.value) is date else "yyyy-mm-dd hh:mm"
    ws.freeze_panes = "D2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(cols))}{max(2, ws.max_row)}"
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()
