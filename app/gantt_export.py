"""
Gantt exports of the same cards the progress report takes (selection, by person, a project):

- add_sheet(): a 甘特 sheet in the Excel report — the tree (編號, 項目, 負責人, 開始, 到期, 狀態, 前置任務) on the
  left, one column per day / week / month on the right, bars in the status colours, ◆ milestones, a red
  frame for today, overdue bars in red and the baseline as a grey line under the bar. Excel outline levels
  fold every level below the card; A3 landscape with the header and the tree repeated on every page. Import ignores the sheet.
- mspdi(): Microsoft Project XML (MSPDI), opened by MS Project, ProjectLibre and others: the same tree as
  summary tasks, manually scheduled (the dates stay exactly as in IPMS), finish-to-start predecessors with
  their lag, milestones, baselines, % complete and the people as resources.

Both start from nodes(): the report's numbering over cards and their subtasks — the card has none, its phases are
A, B …, then A1, A1-1, A1-1.1 (numbering.py; numbers restart in every card).
"""
import io
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional
from xml.sax.saxutils import escape

STATUS_ZH = {"recurring": "週期工作", "overdue": "過期未結案", "new": "新建", "ongoing": "進行中", "pending": "待確認",
             "onhold": "暫緩", "complete": "完成", "canceled": "取消"}
COLOR = {"recurring": "14B8A6", "overdue": "E11D48", "new": "94A3B8", "ongoing": "3B82F6", "pending": "F59E0B",
         "onhold": "A855F7", "complete": "10B981", "canceled": "CBD5E1"}
CLOSED = ("complete", "canceled")


def _d(v) -> Optional[date]:
    if not v:
        return None
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def _get(row, key, default=None):
    try:
        v = row[key]
    except (KeyError, IndexError):
        return default
    return default if v is None else v


def nodes(cards: List[dict], subtasks: Dict[int, list], names: Dict[int, str], sub_deps: Optional[Dict[int, list]] = None) -> List[dict]:
    """Flatten cards › subtasks (in report order) into rows: key, num, level, title, who, status, start, due,
    milestone, base_start, base_due, deps [{key, lag}], summary."""
    from .numbering import child
    from .xlsx_export import lead_and_collaborators
    sub_deps = sub_deps or {}
    out = []
    for n, t in enumerate(cards, start=1):
        subs = subtasks.get(t["id"], [])
        lead, _ = lead_and_collaborators(t, subs)
        out.append({"key": f"t:{t['id']}", "card": t["id"], "num": "", "outline": str(n), "level": 1, "title": t["title"], "who": lead["name"] if lead else None,
                    "status": t["status"], "start": _d(t.get("start_at")), "due": _d(t.get("due_at")), "milestone": bool(t.get("milestone")),
                    "base_start": _d(t.get("base_start")), "base_due": _d(t.get("base_due")),
                    "deps": [{"key": d["key"], "lag": int(d.get("lag") or 0), "title": d.get("title")} for d in t.get("deps") or []],
                    "summary": bool(subs)})
        kids = {}
        for s in subs:
            kids.setdefault(_get(s, "task_parent_id"), []).append(s)

        def emit(s, num, outline, level):
            children = kids.get(s["id"], [])
            out.append({"key": f"s:{s['id']}", "card": t["id"], "num": num, "outline": outline, "level": level, "title": s["title"] or "",
                        "who": names.get(s["assignee_id"]) if s["assignee_id"] else None, "status": s["status"] or "new",
                        "start": _d(s["start_at"]), "due": _d(s["due_at"]), "milestone": bool(_get(s, "milestone", 0)),
                        "base_start": _d(_get(s, "base_start")), "base_due": _d(_get(s, "base_due")),
                        "deps": [{"key": d["key"], "lag": int(d.get("lag") or 0), "title": d.get("title")} for d in sub_deps.get(s["id"], [])],
                        "summary": bool(children)})
            for k, c in enumerate(children, start=1):
                emit(c, child(num, level, k), f"{outline}.{k}", level + 1)
        for k, s in enumerate(kids.get(None, []), start=1):
            emit(s, child("", 1, k), f"{n}.{k}", 2)
    return out


def _span(x):
    s, e = x["start"] or x["due"], x["due"] or x["start"]
    if x["milestone"]:
        s = e = x["due"] or x["start"]
    return s, e


def pick_scale(lo: date, hi: date, scale: str = "auto") -> str:
    if scale in ("day", "week", "month"):
        return scale
    days = (hi - lo).days + 1
    return "day" if days <= 45 else "week" if days <= 430 else "month"


def _deps_text(x, number):
    parts = []
    for d in x["deps"]:
        num, card = number.get(d["key"]) or (None, None)          # numbers restart in every card: others by name
        where = (num if num and card == x.get("card") else None) or (f"「{d['title']}」" if d.get("title") else None)
        if where:
            parts.append(where + (f"（{'+' if d['lag'] > 0 else ''}{d['lag']} 天）" if d["lag"] else ""))
    return "、".join(parts) or None


# ---------------------------------------------------------------- Excel sheet
def add_sheet(wb, rows: List[dict], today: date, scale: str = "auto", title: str = "甘特圖"):
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter
    ws = wb.create_sheet(title)
    ws.sheet_properties.outlinePr.summaryBelow = False
    dated = [_span(x) for x in rows if _span(x)[0]]
    bases = [(x["base_start"] or x["base_due"], x["base_due"] or x["base_start"]) for x in rows if x["base_start"] or x["base_due"]]
    if not dated:
        ws["A1"] = "這些卡片都還沒有日期"
        return ws
    lo = min([a for a, _ in dated] + [a for a, _ in bases] + [today])
    hi = max([b for _, b in dated] + [b for _, b in bases] + [today])
    unit = pick_scale(lo, hi, scale)
    # time columns
    if unit == "day":
        lo -= timedelta(days=1)
        hi += timedelta(days=1)
        cols = [lo + timedelta(days=i) for i in range((hi - lo).days + 1)]
        nxt = lambda d: d + timedelta(days=1)
        width = 3.2
    elif unit == "week":
        lo -= timedelta(days=lo.weekday())
        cols = []
        d = lo
        while d <= hi:
            cols.append(d)
            d += timedelta(days=7)
        nxt = lambda d: d + timedelta(days=7)
        width = 3.6
    else:
        lo = lo.replace(day=1)
        cols = []
        d = lo
        while d <= hi:
            cols.append(d)
            d = (d.replace(day=28) + timedelta(days=4)).replace(day=1)
        nxt = lambda d: (d.replace(day=28) + timedelta(days=4)).replace(day=1)
        width = 6

    fixed = [("編號", 8), ("項目", 40), ("負責人", 11), ("開始", 11), ("到期", 11), ("狀態", 9), ("前置任務", 16)]
    F = len(fixed)
    head1, head2, first = 3, 4, 5
    thin = Side(style="thin", color="D5DBE3")
    hair = Side(style="hair", color="E5E9EF")
    red = Side(style="medium", color="E11D48")
    grey = Side(style="thick", color="8A94A6")
    head_fill = PatternFill("solid", fgColor="1E293B")
    sub_fill = PatternFill("solid", fgColor="EEF2F7")
    ws["A1"] = f"{title}　（{ {'day': '每欄一天', 'week': '每欄一週（週一起）', 'month': '每欄一個月'}[unit] }，{lo:%Y/%m/%d} – {hi:%Y/%m/%d}）"
    ws["A1"].font = Font(bold=True, size=14, color="1E3A8A")
    ws["A2"] = "圖例：長條＝狀態顏色　紅色長條＝逾期　◆＝里程碑　灰色底線＝基準線　紅框欄＝今天"
    ws["A2"].font = Font(size=9, color="64748B")
    for j, (h, w) in enumerate(fixed, start=1):
        for r in (head1, head2):
            c = ws.cell(row=r, column=j)
            c.fill = head_fill
        c = ws.cell(row=head2, column=j, value=h)
        c.font = Font(bold=True, color="FFFFFF", size=10)
        c.alignment = Alignment(horizontal="center", vertical="center")
        ws.column_dimensions[get_column_letter(j)].width = w
    today_col = None
    group_start, group_key = None, None
    for i, d in enumerate(cols):
        j = F + 1 + i
        letter = get_column_letter(j)
        ws.column_dimensions[letter].width = width
        end = nxt(d) - timedelta(days=1)
        if d <= today <= end:
            today_col = j
        key = (d.year, d.month) if unit == "day" else (d.year, (d.month - 1) // 3) if unit == "week" else d.year
        if key != group_key:
            if group_start is not None and j - 1 > group_start:
                ws.merge_cells(start_row=head1, start_column=group_start, end_row=head1, end_column=j - 1)
            group_start, group_key = j, key
            label = f"{d:%Y/%m}" if unit == "day" else f"{d.year} Q{(d.month - 1) // 3 + 1}" if unit == "week" else f"{d.year}"
            c = ws.cell(row=head1, column=j, value=label)
            c.font = Font(bold=True, color="FFFFFF", size=9)
            c.alignment = Alignment(horizontal="left", vertical="center")
        ws.cell(row=head1, column=j).fill = head_fill
        lab = str(d.day) if unit == "day" else f"{d.month}/{d.day}" if unit == "week" else f"{d.month:02d}"
        c = ws.cell(row=head2, column=j, value=lab)
        c.font = Font(color="FFFFFF", size=8, bold=d <= today <= end)
        c.fill = PatternFill("solid", fgColor="E11D48") if d <= today <= end else PatternFill("solid", fgColor="334155" if (unit == "day" and d.weekday() >= 5) else "1E293B")
        c.alignment = Alignment(horizontal="center", vertical="center", text_rotation=90 if unit == "week" else 0)
    if group_start is not None and F + len(cols) > group_start:
        ws.merge_cells(start_row=head1, start_column=group_start, end_row=head1, end_column=F + len(cols))
    ws.row_dimensions[head2].height = 30 if unit == "week" else 18

    number = {x["key"]: (x["num"], x.get("card")) for x in rows}
    col_of = lambda d: None if d is None else max(0, min(len(cols) - 1, _index(cols, d)))
    for k, x in enumerate(rows):
        r = first + k
        late = x["due"] and x["due"] < today and x["status"] not in CLOSED
        indent = "　" * (x["level"] - 1)
        vals = [x["num"], indent + ("◆ " if x["milestone"] else "") + x["title"], x["who"], x["start"] if not x["milestone"] else None, x["due"],
                STATUS_ZH.get(x["status"], x["status"]), _deps_text(x, number)]
        for j, v in enumerate(vals, start=1):
            c = ws.cell(row=r, column=j, value=v)
            c.border = Border(bottom=thin, right=thin if j == F else None)
            c.font = Font(size=9.5, bold=x["summary"], color="B91C1C" if (j == 5 and late) else "0F172A")
            c.alignment = Alignment(vertical="center", wrap_text=False)
            if isinstance(v, date):
                c.number_format = "yyyy/mm/dd"
            if x["summary"]:
                c.fill = sub_fill
        if x["level"] > 1:
            ws.row_dimensions[r].outlineLevel = min(x["level"] - 1, 7)
        # the timeline
        s, e = _span(x)
        bs, be = (x["base_start"] or x["base_due"], x["base_due"] or x["base_start"])
        a, b = (col_of(s), col_of(e)) if s else (None, None)
        ba, bb = (col_of(bs), col_of(be)) if bs else (None, None)
        colr = "E11D48" if late else COLOR.get(x["status"], "94A3B8")
        for i in range(len(cols)):
            j = F + 1 + i
            c = ws.cell(row=r, column=j)
            bottom = grey if (ba is not None and ba <= i <= bb) else hair
            left = red if j == today_col else None
            right = red if j == today_col else None
            c.border = Border(bottom=bottom, left=left, right=right)
            if a is not None and a <= i <= b:
                if x["milestone"]:
                    c.value = "◆"
                    c.font = Font(color=colr, bold=True, size=11)
                    c.alignment = Alignment(horizontal="center", vertical="center")
                else:
                    c.fill = PatternFill("solid", fgColor=colr if not x["summary"] else "475569")
    last = first + len(rows) - 1
    ws.freeze_panes = ws.cell(row=first, column=F + 1)
    ws.print_title_rows = f"{head1}:{head2}"
    ws.print_title_cols = f"A:{get_column_letter(F)}"
    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = ws.PAPERSIZE_A3
    ws.page_setup.fitToHeight = 0
    ws.page_setup.fitToWidth = 1 if len(cols) <= 60 else 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.print_options.gridLines = False
    ws.page_margins.left = ws.page_margins.right = 0.3
    ws.oddFooter.center.text = "第 &P / &N 頁"
    ws.auto_filter.ref = f"A{head2}:{get_column_letter(F)}{last}"
    return ws


def _index(cols, d):
    # last column whose start is on or before d
    lo, hi = 0, len(cols) - 1
    if d < cols[0]:
        return 0
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if cols[mid] <= d:
            lo = mid
        else:
            hi = mid - 1
    return lo


# ---------------------------------------------------------------- MS Project XML (MSPDI)
def _workdays(s: date, e: date) -> int:
    n, d = 0, s
    while d <= e:
        if d.weekday() < 5:
            n += 1
        d += timedelta(days=1)
    return max(n, 1)


def mspdi(rows: List[dict], title: str, author: str = "", now: Optional[datetime] = None) -> bytes:
    """Microsoft Project XML. Tasks are manually scheduled so the dates stay as they are in IPMS."""
    now = now or datetime.now()
    uid = {x["key"]: i for i, x in enumerate(rows, start=1)}
    dated = [_span(x) for x in rows if _span(x)[0]]
    p_start = min((a for a, _ in dated), default=now.date())
    p_finish = max((b for _, b in dated), default=now.date())
    T = lambda d, end=False: f"{d:%Y-%m-%d}T{'17:00:00' if end else '08:00:00'}"
    E = lambda v: escape(str(v or ""))
    out = io.StringIO()
    w = out.write
    w('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n')
    w('<Project xmlns="http://schemas.microsoft.com/project">\n')
    w(f"<SaveVersion>14</SaveVersion><Name>{E(title)}.xml</Name><Title>{E(title)}</Title><Author>{E(author)}</Author>"
      f"<CreationDate>{now:%Y-%m-%dT%H:%M:%S}</CreationDate><ScheduleFromStart>1</ScheduleFromStart>"
      f"<StartDate>{T(p_start)}</StartDate><FinishDate>{T(p_finish, True)}</FinishDate><FYStartDate>1</FYStartDate>"
      "<CriticalSlackLimit>0</CriticalSlackLimit><CurrencyDigits>2</CurrencyDigits><CurrencySymbol>$</CurrencySymbol>"
      "<CalendarUID>1</CalendarUID><DefaultStartTime>08:00:00</DefaultStartTime><DefaultFinishTime>17:00:00</DefaultFinishTime>"
      "<MinutesPerDay>480</MinutesPerDay><MinutesPerWeek>2400</MinutesPerWeek><DaysPerMonth>20</DaysPerMonth>"
      "<DefaultTaskType>0</DefaultTaskType><DurationFormat>7</DurationFormat><WeekStartDay>1</WeekStartDay>"
      "<NewTasksAreManual>1</NewTasksAreManual>\n")
    # the standard calendar: Mon–Fri 08:00–12:00, 13:00–17:00
    w("<Calendars><Calendar><UID>1</UID><Name>Standard</Name><IsBaseCalendar>1</IsBaseCalendar><BaseCalendarUID>-1</BaseCalendarUID><WeekDays>")
    for day in range(1, 8):
        if day in (1, 7):
            w(f"<WeekDay><DayType>{day}</DayType><DayWorking>0</DayWorking></WeekDay>")
        else:
            w(f"<WeekDay><DayType>{day}</DayType><DayWorking>1</DayWorking><WorkingTimes>"
              "<WorkingTime><FromTime>08:00:00</FromTime><ToTime>12:00:00</ToTime></WorkingTime>"
              "<WorkingTime><FromTime>13:00:00</FromTime><ToTime>17:00:00</ToTime></WorkingTime></WorkingTimes></WeekDay>")
    w("</WeekDays></Calendar></Calendars>\n<Tasks>\n")
    w(f"<Task><UID>0</UID><ID>0</ID><Name>{E(title)}</Name><Type>1</Type><IsNull>0</IsNull><OutlineNumber>0</OutlineNumber>"
      f"<OutlineLevel>0</OutlineLevel><Start>{T(p_start)}</Start><Finish>{T(p_finish, True)}</Finish><Summary>1</Summary></Task>\n")
    for i, x in enumerate(rows, start=1):
        s, e = _span(x)
        hours = 0 if x["milestone"] else (_workdays(s, e) * 8 if s else 8)
        pct = 100 if x["status"] == "complete" else 0
        w("<Task>")
        w(f"<UID>{i}</UID><ID>{i}</ID><Name>{E(x['title'])}</Name><Active>{0 if x['status'] == 'canceled' else 1}</Active>"
          f"<Manual>1</Manual><Type>1</Type><IsNull>0</IsNull><WBS>{x['num']}</WBS><OutlineNumber>{x['outline']}</OutlineNumber>"
          f"<OutlineLevel>{x['level']}</OutlineLevel><Priority>500</Priority>")
        if s:
            st = T(s) if not x["milestone"] else T(e, True)       # a milestone is the end of its day
            w(f"<Start>{st}</Start><Finish>{T(e, True)}</Finish>"
              f"<Duration>PT{hours}H0M0S</Duration><ManualStart>{st}</ManualStart>"
              f"<ManualFinish>{T(e, True)}</ManualFinish><ManualDuration>PT{hours}H0M0S</ManualDuration>")
        w(f"<DurationFormat>7</DurationFormat><Milestone>{1 if x['milestone'] else 0}</Milestone>"
          f"<Summary>{1 if x['summary'] else 0}</Summary><PercentComplete>{pct}</PercentComplete><ConstraintType>0</ConstraintType>")
        note = "；".join(v for v in [f"狀態：{STATUS_ZH.get(x['status'], x['status'])}", x["who"] and f"負責：{x['who']}"] if v)
        w(f"<Notes>{E(note)}</Notes>")
        for d in x["deps"]:
            if d["key"] in uid:
                lag = d["lag"]
                w(f"<PredecessorLink><PredecessorUID>{uid[d['key']]}</PredecessorUID><Type>1</Type><CrossProject>0</CrossProject>"
                  f"<LinkLag>{lag * 4800}</LinkLag><LagFormat>7</LagFormat></PredecessorLink>")
        bs, be = (x["base_start"] or x["base_due"], x["base_due"] or x["base_start"])
        if bs:
            bh = 0 if x["milestone"] else _workdays(bs, be) * 8
            w(f"<Baseline><Number>0</Number><Start>{T(bs) if not x['milestone'] else T(be, True)}</Start><Finish>{T(be, True)}</Finish><Duration>PT{bh}H0M0S</Duration>"
              f"<DurationFormat>7</DurationFormat><EstimatedDuration>0</EstimatedDuration></Baseline>")
        w("</Task>\n")
    w("</Tasks>\n<Resources>\n")
    people = sorted({x["who"] for x in rows if x["who"]})
    rid = {p: k for k, p in enumerate(people, start=1)}
    for p, k in rid.items():
        w(f"<Resource><UID>{k}</UID><ID>{k}</ID><Name>{E(p)}</Name><Type>1</Type><IsNull>0</IsNull><MaxUnits>1.00</MaxUnits></Resource>\n")
    w("</Resources>\n<Assignments>\n")
    a = 0
    for i, x in enumerate(rows, start=1):
        if x["who"] and not x["summary"]:
            a += 1
            w(f"<Assignment><UID>{a}</UID><TaskUID>{i}</TaskUID><ResourceUID>{rid[x['who']]}</ResourceUID><Units>1</Units></Assignment>\n")
    w("</Assignments>\n</Project>\n")
    return out.getvalue().encode("utf-8")
