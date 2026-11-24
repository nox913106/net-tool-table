"""
Board cards → a one-sheet progress report (.xlsx) for supervisors, and back.

Layout (sheet 「工作報告」)
  rows 1-3   title, who / when / scope, status summary and overall completion
  row 5      column headers (repeated on every printed page)
  rows 6…    the tree:
               1     主任務   card            (completion % = its subtasks + collaborators)
               1.1   子任務   └ subtask
               1.2   協作     └ collaborator  (co-assignee / @mentioned without a subtask of their own)
             Excel outline grouping folds a card's children (+/- on the left).
Columns  編號 類型 項目 標籤 負責人 狀態 優先 開始 到期 里程碑 前置任務 完成% 預估(h) 實際(h) 最新進度／說明 備註 系統ID
  里程碑 (◆) can be set / cleared on import (◆／是 → set, 否 → clear, empty → unchanged); 前置任務 lists the
  predecessors by their number in this report (or 「card › item」 when not in it) and is ignored on import.
  系統ID (T12 / S45 / C7) lets the same file be imported back to update those items; rows without
  one are created. 備註 is free space for the reader and is ignored on import.
  Under each subtask its work log follows (類型 工時: date, hours, who, note; outline level 2) —
  report only, skipped on import.
Printing: A4 landscape, fit to one page wide, header row repeated, page numbers in the footer;
the 系統ID column is outside the print area.
The caller passes only cards the user may see (routes/tasks.py export_xlsx).
"""
import io
import re
from datetime import date, datetime
from typing import Dict, List, Optional

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

STATUS_ZH = {"recurring": "週期工作", "overdue": "過期未結案", "new": "新建", "ongoing": "進行中", "pending": "待確認",
             "onhold": "暫緩", "complete": "完成", "canceled": "取消"}
PRIORITY = {"low": "低", "normal": "一般", "high": "高"}
KIND = {"card": "主任務", "sub": "子任務", "collab": "協作", "time": "工時"}   # 工時 = a work log row (report only)
COLLAB_DONE, COLLAB_OPEN = "完成", "未完成"
ILLEGAL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")           # characters Excel refuses
STATUS_FILL = {"recurring": "CCFBF1", "overdue": "FFE4E6", "new": "F1F5F9", "ongoing": "DBEAFE", "pending": "FEF3C7",
               "onhold": "F3E8FF", "complete": "D1FAE5", "canceled": "FEE2E2"}
HEAD_FILL = PatternFill("solid", fgColor="1E3A8A")
CARD_FILL = PatternFill("solid", fgColor="EEF2FF")
THIN = Side(style="thin", color="CBD5E1")
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
SHEET = "工作報告"
HEADER_ROW = 5
# (header, width, kind)
COLUMNS = [("編號", 7, ""), ("類型", 8, ""), ("項目", 44, "wrap"), ("標籤", 14, "wrap"), ("負責人", 16, "wrap"), ("狀態", 11, ""), ("優先", 6, ""),
           ("開始", 16, "date"), ("到期", 16, "date"), ("里程碑", 7, ""), ("前置任務", 18, "wrap"), ("完成%", 8, "pct"), ("預估(h)", 8, "hours"), ("實際(h)", 8, "hours"),
           ("最新進度／說明", 52, "wrap"), ("備註", 22, "wrap"), ("系統ID", 9, "")]
COL = {c[0]: i for i, c in enumerate(COLUMNS)}
PRINT_COLS = len(COLUMNS) - 1                                  # 系統ID is not printed


def _get(row, key, default=None):
    """A column of a sqlite row or a dict, or default when the row has no such column."""
    try:
        return row[key]
    except (KeyError, IndexError):
        return default


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
    return round(minutes / 60, 2) if minutes else None


def _one_line(text, limit=240):
    s = " ".join((text or "").split())
    return s if len(s) <= limit else s[:limit - 1] + "…"


def _md(ts):
    d = _dt(ts)
    return f"{d.month}/{d.day}" if isinstance(d, (date, datetime)) else ""


def lead_and_collaborators(card: dict, subtasks: list):
    """主責 and the collaborators who count (same rule as the board): lead = creator if also an assignee,
    else the first assignee, else the creator; collaborators = other assignees and @mentioned people
    without a subtask of their own (a creator who only handed the card out is not one)."""
    assignees = card.get("assignees") or []
    owner = card.get("owner")
    lead = next((a for a in assignees if owner and a["id"] == owner["id"]), None) or (assignees[0] if assignees else owner)
    with_sub = {s["assignee_id"] for s in subtasks if s["assignee_id"]}
    seen = {lead["id"]} if lead else set()
    out = []
    for p, why in [*[(a, "共同負責") for a in assignees], *[(m, "@協作") for m in card.get("mentions") or []]]:
        if p["id"] in seen or p["id"] in with_sub:
            continue
        seen.add(p["id"])
        out.append({**p, "why": why})
    return lead, out


def _latest(comments: list, names: Dict[int, str], under: Optional[int]):
    """Newest comment in a thread: under=None → the card's own threads (not subtasks); else replies to that subtask."""
    pick = None
    roots = {c["id"]: c for c in comments if c["parent_id"] is None}
    for c in comments:
        if under is None:
            root = roots.get(c["parent_id"]) if c["parent_id"] else c
            if not root or root["is_task"]:
                continue
        elif c["parent_id"] != under:
            continue
        if not (c["body"] or "").strip():
            continue
        if pick is None or (c["created_at"] or "", c["id"]) > (pick["created_at"] or "", pick["id"]):
            pick = c
    if not pick:
        return None
    who = names.get(pick["user_id"]) if pick["user_id"] else None
    return f"{_md(pick['created_at'])} {who or '本機'}：{_one_line(pick['body'])}"


def _blocked_text(card):
    b = card.get("blocked")
    if not b or card["status"] in ("complete", "canceled"):
        return None
    return f"⛔ 卡住（{_md(b['since'])} 起）：{_one_line(b['reason'])}"


def _is_late(due, status, today: date) -> bool:
    if not due or status in ("complete", "canceled"):
        return False
    d = due if isinstance(due, date) and not isinstance(due, datetime) else due.date() if isinstance(due, datetime) else None
    return bool(d and d < today)


def build_report(cards: List[dict], subtasks: Dict[int, list], comments: Dict[int, list], times: Dict[int, list],
                 names: Dict[int, str], author: str = "", now: Optional[datetime] = None,
                 sub_deps: Optional[Dict[int, list]] = None) -> bytes:
    """cards: enriched rows (owner / assignees / mentions as dicts with id, username, name, done).
    subtasks / comments / times are keyed by card id; names maps user id → display name."""
    now = now or datetime.now()
    today = now.date()
    wb = Workbook()
    ws = wb.active
    ws.title = SHEET
    rows = []                                            # (level, values, status, late)
    sub_deps = sub_deps or {}
    number = {}                                          # "t:12" / "s:45" → its number in this report (1, 1.2, …)
    pending_deps = []                                    # (row values, [{key, title, card, lag}]) filled in at the end
    MS = "◆"
    tally, done_all, total_all, late_n, blocked_n, hours_all = {}, 0, 0, 0, 0, 0

    for n, t in enumerate(cards, start=1):
        subs = subtasks.get(t["id"], [])
        lead, collab = lead_and_collaborators(t, subs)
        top = [s for s in subs if not (s["task_parent_id"] if "task_parent_id" in s.keys() else None)]
        counted = [s for s in top if (s["status"] or "new") != "canceled"]
        done = sum(1 for s in counted if s["status"] == "complete") + sum(1 for c in collab if c.get("done"))
        total = len(counted) + len(collab)
        pct = (done / total) if total else (1.0 if t["status"] == "complete" else None)
        card_times = times.get(t["id"], [])
        est = sum(s["estimate_minutes"] or 0 for s in subs)
        spent = sum(e["minutes"] or 0 for e in card_times)
        tally[t["status"]] = tally.get(t["status"], 0) + 1
        if total:
            done_all, total_all = done_all + done, total_all + total
        else:
            done_all, total_all = done_all + (t["status"] == "complete"), total_all + (t["status"] != "canceled")
        due = _dt(t["due_at"])
        late = _is_late(due, t["status"], today) or t["status"] == "overdue"
        late_n += late
        blocked_n += bool(_blocked_text(t))
        cmts = comments.get(t["id"], [])
        rows.append((0, [
            str(n), KIND["card"], _txt(t["title"]), _txt(" ".join("#" + x for x in t.get("tags") or [])) or None,
            _txt(lead["name"]) if lead else None, STATUS_ZH.get(t["status"], t["status"]),
            PRIORITY.get(t["priority"], t["priority"]), None if t.get("milestone") else _dt(t["start_at"]), due,
            MS if t.get("milestone") else None, None, pct, _hours(est), _hours(spent),
            _txt(_blocked_text(t) or _latest(cmts, names, None) or (_one_line(t["description"]) or None)), None, f"T{t['id']}"], t["status"], late))
        number[f"t:{t['id']}"] = str(n)
        if t.get("deps"):
            pending_deps.append((rows[-1][1], t["deps"]))
        kids = {}
        for s in subs:
            kids.setdefault(s["task_parent_id"] if "task_parent_id" in s.keys() else None, []).append(s)

        def own_minutes(sid):
            return sum(e["minutes"] or 0 for e in card_times if e["comment_id"] == sid)

        def tree_minutes(sid):
            return own_minutes(sid) + sum(tree_minutes(k["id"]) for k in kids.get(sid, []))

        def emit(s, num, level):
            """A subtask row, its work log, then its own subtasks (outline levels follow the tree)."""
            nonlocal hours_all
            st = s["status"] or "new"
            desc = s["body"] if s["body"] and s["body"].strip() != (s["title"] or "").strip() else None
            sdue = _dt(s["due_at"])
            children = kids.get(s["id"], [])
            rows.append((level, [
                num, KIND["sub"], _txt("　" * (level - 1) + "└ " + (s["title"] or "子任務")), None,
                _txt(names.get(s["assignee_id"])) if s["assignee_id"] else None,
                STATUS_ZH.get(st, st), PRIORITY.get(s["priority"] or "normal"), None if _get(s, "milestone") else _dt(s["start_at"]), sdue,
                MS if _get(s, "milestone") else None, None,
                1.0 if st == "complete" else 0.0 if st != "canceled" else None, _hours(s["estimate_minutes"]),
                _hours(tree_minutes(s["id"]) if children else own_minutes(s["id"])),
                _txt(_latest(cmts, names, s["id"]) or (_one_line(desc) or None)), None, f"S{s['id']}"], st, _is_late(sdue, st, today)))
            number[f"s:{s['id']}"] = num
            if sub_deps.get(s["id"]):
                pending_deps.append((rows[-1][1], sub_deps[s["id"]]))
            # the work log of this subtask: one row per entry (date, hours, who, what) — ignored on import
            logs = sorted((e for e in card_times if e["comment_id"] == s["id"]),
                          key=lambda e: (e["work_date"] or str(e["created_at"] or ""), e["id"]))
            for e in logs:
                day = _dt(e["work_date"]) if e["work_date"] else None
                label = (f"{day:%m/%d} " if day else "") + (_one_line(e["note"]) or "工時")
                rows.append((min(level + 1, 7), [
                    None, KIND["time"], _txt("　" * level + "· " + label), None, _txt(names.get(e["user_id"])) if e["user_id"] else None,
                    None, None, day, None, None, None, None, None, _hours(e["minutes"]), _txt(e["note"]) or None, None, None], None, False))
                hours_all += (e["minutes"] or 0)
            for k, child in enumerate(children, start=1):
                emit(child, f"{num}.{k}", level + 1)

        m = 0
        for s in kids.get(None, []):
            m += 1
            emit(s, f"{n}.{m}", 1)
        for c in collab:
            m += 1
            rows.append((1, [
                f"{n}.{m}", KIND["collab"], _txt(f"└ 協作（{c['why']}）"), None, _txt(c["name"]), COLLAB_DONE if c.get("done") else COLLAB_OPEN,
                None, None, None, None, None, 1.0 if c.get("done") else 0.0, None, None, None, None, f"C{c['id']}"],
                "complete" if c.get("done") else None, False))

    # predecessors by their number here; ones outside this report by name
    titles = {f"t:{t['id']}": t["title"] for t in cards}
    for values, deps in pending_deps:
        parts = []
        for d in deps:
            where = number.get(d["key"])
            if not where:
                card = titles.get(f"t:{d.get('card')}")
                where = f"「{d['title']}」" if d["key"].startswith("t:") or not card else f"「{card} › {d['title']}」"
            parts.append(where + (f"（{'+' if d.get('lag', 0) > 0 else ''}{d['lag']} 天）" if d.get("lag") else ""))
        values[COL["前置任務"]] = _txt("、".join(parts))
    # ---- report header
    last_col = get_column_letter(PRINT_COLS)
    ws["A1"] = "工作進度報告"
    ws["A1"].font = Font(bold=True, size=16, color="1E3A8A")
    ws["A2"] = _txt(f"製表人：{author or '—'}　　製表時間：{now:%Y-%m-%d %H:%M}　　範圍：{len(cards)} 項主任務")
    ws["A2"].font = Font(color="475569")
    order = ["overdue", "ongoing", "pending", "onhold", "new", "recurring", "complete", "canceled"]
    parts = [f"{STATUS_ZH[k]} {tally[k]}" for k in order if tally.get(k)]
    overall = f"整體完成率 {round(done_all / total_all * 100)}%" if total_all else ""
    ws["A3"] = _txt("　".join(x for x in ["／".join(parts), overall, f"逾期 {late_n} 項" if late_n else "",
                                         f"卡住 {blocked_n} 項" if blocked_n else "",
                                         f"工時合計 {hours_all / 60:.1f} 小時" if hours_all else ""] if x))
    ws["A3"].font = Font(bold=True)
    for r in (1, 2, 3):
        ws.merge_cells(f"A{r}:{last_col}{r}")
        ws.row_dimensions[r].height = 26 if r == 1 else 18
    # ---- table
    for i, (name, width, _) in enumerate(COLUMNS, start=1):
        ws.column_dimensions[get_column_letter(i)].width = width
        cell = ws.cell(row=HEADER_ROW, column=i, value=name)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = HEAD_FILL if name != "系統ID" else PatternFill("solid", fgColor="94A3B8")
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = BOX
    ws.row_dimensions[HEADER_ROW].height = 22
    ws.sheet_properties.outlinePr.summaryBelow = False          # the card row is above its children
    r = HEADER_ROW
    for level, values, status, late in rows:
        r += 1
        for i, v in enumerate(values, start=1):
            ws.cell(row=r, column=i, value=v)
        if level:
            ws.row_dimensions[r].outline_level = level
        for i, cell in enumerate(ws[r], start=1):
            name, _, kind = COLUMNS[i - 1]
            cell.border = BOX
            cell.alignment = Alignment(vertical="top", wrap_text=kind == "wrap",
                                       horizontal="center" if name in ("編號", "類型", "狀態", "優先", "完成%", "里程碑") else None)
            if level == 2:
                cell.font = Font(color="475569", size=10)
            if level == 0:
                cell.fill = CARD_FILL
                if name in ("編號", "項目"):
                    cell.font = Font(bold=True)
            if name == "狀態" and status in STATUS_FILL:
                cell.fill = PatternFill("solid", fgColor=STATUS_FILL[status])
            if kind == "pct" and cell.value is not None:
                cell.number_format = "0%"
            elif kind == "hours" and cell.value is not None:
                cell.number_format = "0.0#"
            elif kind == "date" and cell.value is not None and not isinstance(cell.value, str):
                cell.number_format = "yyyy-mm-dd" if type(cell.value) is date else "yyyy-mm-dd hh:mm"
            if name == "到期" and late:
                cell.font = Font(bold=True, color="DC2626")
            if name == "系統ID":
                cell.font = Font(color="94A3B8", size=9)
            if name == "里程碑" and cell.value:
                cell.font = Font(bold=True, color="1E3A8A")
    last = max(r, HEADER_ROW + 1)
    # ---- helpers for whoever edits the file before importing
    dv = DataValidation(type="list", allow_blank=True, formula1='"' + ",".join(list(STATUS_ZH.values()) + [COLLAB_OPEN]) + '"')
    dv_p = DataValidation(type="list", allow_blank=True, formula1='"低,一般,高"')
    dv_k = DataValidation(type="list", allow_blank=True, formula1='"主任務,子任務,協作"')
    dv_m = DataValidation(type="list", allow_blank=True, formula1='"◆,否"')
    for d, col in ((dv, "狀態"), (dv_p, "優先"), (dv_k, "類型"), (dv_m, "里程碑")):
        letter = get_column_letter(COL[col] + 1)
        d.add(f"{letter}{HEADER_ROW + 1}:{letter}{HEADER_ROW + 1000}")
        ws.add_data_validation(d)
    ws.freeze_panes = f"D{HEADER_ROW + 1}"
    ws.auto_filter.ref = f"A{HEADER_ROW}:{get_column_letter(len(COLUMNS))}{last}"
    # ---- printing
    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.print_title_rows = f"{HEADER_ROW}:{HEADER_ROW}"
    ws.print_area = f"A1:{last_col}{last}"
    ws.page_margins.left = ws.page_margins.right = 0.4
    ws.page_margins.top, ws.page_margins.bottom, ws.page_margins.footer = 0.6, 0.75, 0.3
    ws.oddFooter.center.text = "第 &P 頁，共 &N 頁"
    ws.oddFooter.right.text = f"{now:%Y-%m-%d}"
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


# ------------------------------------------------------------------ import
STATUS_IN = {**{v: k for k, v in STATUS_ZH.items()}, **{k: k for k in STATUS_ZH},
             "on going": "ongoing", "on hold": "onhold", "未開始": "new", "已完成": "complete", "已取消": "canceled"}
PRIORITY_IN = {"低": "low", "一般": "normal", "中": "normal", "普通": "normal", "高": "high", "low": "low", "normal": "normal", "high": "high"}
ID_RE = re.compile(r"^\s*([TSC])\s*(\d+)\s*$", re.I)


class ImportError_(ValueError):
    pass


def _cell_date(v):
    """A date cell → 'YYYY-MM-DD' / 'YYYY-MM-DDTHH:MM'. Raises ValueError for text it cannot read."""
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d") if (v.hour, v.minute) == (0, 0) else v.strftime("%Y-%m-%dT%H:%M")
    if isinstance(v, date):
        return v.isoformat()
    s = str(v).strip().replace("/", "-").replace(".", "-")
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$", s)
    if not m:
        raise ValueError(f"看不懂的日期「{v}」（請用 2026-12-31 或 2026/12/31 14:00）")
    y, mo, d, hh, mm = m.groups()
    datetime(int(y), int(mo), int(d))
    return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}" + (f"T{int(hh):02d}:{mm}" if hh else "")


def _clean_title(v) -> str:
    s = str(v or "").strip()
    s = re.sub(r"^[　\s]*└\s*", "", s)
    return s.lstrip("'")


def parse(data: bytes) -> List[dict]:
    """Read a report back: [{row, kind: card|sub|collab, id, title, person, status, priority, start_at, due_at,
    estimate_minutes, errors: [...]}]. Raises ImportError_ when the file is not a report at all."""
    try:
        wb = load_workbook(io.BytesIO(data), data_only=True, read_only=True)
    except Exception:
        raise ImportError_("這不是 Excel 檔（.xlsx），或檔案已損毀")
    ws = wb[SHEET] if SHEET in wb.sheetnames else wb.worksheets[0]
    head, cols = None, {}
    rows = list(ws.iter_rows(values_only=True, max_row=5000))
    for i, r in enumerate(rows[:30]):
        names = [str(c).strip() if c is not None else "" for c in r]
        if "項目" in names and ("類型" in names or "編號" in names):
            head, cols = i, {n: j for j, n in enumerate(names) if n}
            break
    if head is None:
        raise ImportError_("找不到表頭（需要「項目」與「類型」或「編號」欄）。請用看板匯出的報告格式")
    get = lambda r, name: r[cols[name]] if name in cols and cols[name] < len(r) else None
    out = []
    for i, r in enumerate(rows[head + 1:], start=head + 2):
        title = _clean_title(get(r, "項目"))
        sid = str(get(r, "系統ID") or "").strip()
        kind_txt = str(get(r, "類型") or "").strip()
        num = str(get(r, "編號") or "").strip()
        if not title and not sid and not kind_txt:
            continue
        if kind_txt == KIND["time"]:                    # work log rows are a report, not something to import
            continue
        item = {"row": i, "errors": [], "title": title}
        m = ID_RE.match(sid) if sid else None
        if sid and not m:
            item["errors"].append(f"系統ID「{sid}」格式不對（應為 T12／S45／C7，新項目請留空）")
        prefix = m.group(1).upper() if m else None
        item["id"] = int(m.group(2)) if m else None
        kind = {"主任務": "card", "卡片": "card", "子任務": "sub", "協作": "collab"}.get(kind_txt) \
            or {"T": "card", "S": "sub", "C": "collab"}.get(prefix) or ("sub" if "." in num else "card")
        if prefix and {"T": "card", "S": "sub", "C": "collab"}[prefix] != kind:
            item["errors"].append(f"類型「{kind_txt}」和系統ID「{sid}」不一致")
        item["kind"] = kind
        item["depth"] = num.count(".") if re.fullmatch(r"\d+(\.\d+)*", num) else 1   # 1.2 → 1, 1.2.1 → 2 (a subtask's subtask)
        person = str(get(r, "負責人") or "").strip()
        item["person"] = person or None
        if kind == "card" and "標籤" in cols:                  # "#a #b", "a、b" or "a, b"
            raw = str(get(r, "標籤") or "")
            item["tags"] = [x for x in re.split(r"[\s,，、;；]+", raw.replace("＃", "#")) if x.strip("#")]
        st = str(get(r, "狀態") or "").strip()
        if kind == "collab":
            item["done"] = None if not st else st in (COLLAB_DONE, "complete", "已完成")
        elif st:
            key = STATUS_IN.get(st) or STATUS_IN.get(st.lower()) or STATUS_IN.get(re.sub(r"[（(].*$", "", st).strip().lower())
            if not key:
                item["errors"].append(f"狀態「{st}」不認得（可用：{'、'.join(STATUS_ZH.values())}）")
            item["status"] = key
        ms = str(get(r, "里程碑") or "").strip()
        if ms and kind != "collab":
            if ms in ("◆", "♦", "是", "Y", "y", "V", "v", "✓", "✔", "1", "TRUE", "True", "true"):
                item["milestone"] = True
            elif ms in ("否", "N", "n", "X", "x", "✗", "0", "FALSE", "False", "false", "－", "-"):
                item["milestone"] = False
            else:
                item["errors"].append(f"里程碑「{ms}」看不懂（填 ◆ 或「是」設為里程碑，「否」取消，空白不變）")
        pr = str(get(r, "優先") or "").strip()
        if pr and kind != "collab":
            item["priority"] = PRIORITY_IN.get(pr) or PRIORITY_IN.get(pr.lower())
            if not item["priority"]:
                item["errors"].append(f"優先「{pr}」不認得（低／一般／高）")
        for col, key in (("開始", "start_at"), ("到期", "due_at")):
            try:
                v = _cell_date(get(r, col))
                if v:
                    item[key] = v
            except ValueError as e:
                item["errors"].append(str(e))
        est = get(r, "預估(h)")
        if kind == "sub" and est not in (None, ""):
            try:
                item["estimate_minutes"] = max(0, round(float(est) * 60))
            except (TypeError, ValueError):
                item["errors"].append(f"預估工時「{est}」不是數字")
        if kind != "collab" and not title:
            item["errors"].append("項目（名稱）是空的")
        out.append(item)
        if len(out) > 2000:
            raise ImportError_("一次最多匯入 2000 列")
    wb.close()
    return out
