#!/usr/bin/env python3
"""A sample one-year project to import: 主機房改建 (data-centre rebuild).

    python3 scripts/make_sample_project.py [output.xlsx]

Writes the board's Excel report layout (the same columns 看板 → 匯出 Excel produces), so it is read by
看板 → 匯入 Excel: one 專案 card, 8 phases, work packages and tasks (up to 4 levels), milestones (◆),
predecessors (前置任務, by number), estimates in hours. The plan is app/demo.py's (the same project 後台 →
示範資料 creates); 負責人 are its demo staff in 7 departments. Dates are moved to today.
"""
import sys
from datetime import date, timedelta
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.worksheet.properties import Outline

D = date
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "docs" / "samples" / "機房改建專案-範例.xlsx"

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import demo  # noqa: E402  (the same plan as 備份與匯入 → 示範資料)
from app.numbering import from_path  # noqa: E402

# the plan's numbers are dotted (1.2.3); the file shows them the way the report does (A2-3)
code = lambda dotted: from_path([int(x) for x in dotted.split(".")])

ZH = {"new": "新建", "ongoing": "進行中", "pending": "待確認", "onhold": "暫緩", "complete": "完成", "canceled": "取消", "overdue": "過期未結案"}
SHIFT = demo.shift_days()                 # the plan is laid out around today
mv = lambda d: (d + timedelta(days=SHIFT)) if d else None
ref = lambda text: "、".join(code(f"1.{n}") + (f"（{'+' if lag > 0 else ''}{lag} 天）" if lag else "") for n, lag in demo.parse_deps(text)) or None

P = "專案"
title, desc, lead = demo.PROJECT
# (編號, 項目, 負責人, 狀態, 優先, 開始, 到期, 里程碑, 前置任務, 預估(h), 備註)
who_of = lambda short: f"{demo.NAME['demo.' + short]} (demo.{short})"
ROWS = [("1", title, who_of(lead), None, "高", None, None, None, None, None, desc)]
for num, t, who, st, start, due, ms, deps, est, extra in demo.ROWS:
    note = extra.get("blocked") and "卡住：" + extra["blocked"] or extra.get("note")
    ROWS.append((f"1.{num}", t, who_of(who), ZH.get(st) if st else None, "高" if extra.get("prio") == "high" else "一般",
                 None if ms else mv(start), mv(due), "◆" if ms else None, ref(deps), est, note))

# each department's everyday cards (主任務 2, 3, …)
TODAY = date.today()
OPS = [(str(k), t, who_of(w), ZH[st], "高" if pr == "high" else "低" if pr == "low" else "一般", None,
        (TODAY + timedelta(days=due)) if due is not None else None, None, None, None,
        (ex.get("blocked") and "卡住：" + ex["blocked"]) or ex.get("note") or ("歸屬：主機房改建專案" if linked else None))
       for k, (w, t, st, due, pr, linked, ex) in enumerate(demo.OPS, start=2)]

HEAD = ["編號", "類型", "項目", "標籤", "負責人", "狀態", "優先", "開始", "到期", "里程碑", "前置任務", "預估(h)", "備註"]
WIDTH = [9, 7, 50, 14, 10, 9, 6, 12, 12, 7, 22, 8, 30]


def main():
    wb = Workbook()
    ws = wb.active
    ws.title = "工作報告"
    ws.sheet_properties.outlinePr = Outline(summaryBelow=False)
    ws["A1"] = "主機房改建專案　匯入範例"
    ws["A1"].font = Font(size=15, bold=True)
    ws["A2"] = ("用法（以管理員登入）：待辦看板 → 匯入 Excel → 選這個檔案 → 預覽 → 套用。會一併建立「人員」分頁的 16 位示範人員"
                "（7 個部門，只存在 IPMS、不能登入、不寫入 AD），再建立專案與各部門的日常卡片並指派給他們。")
    ws["A3"] = (f"日期以 {date.today():%Y/%m/%d} 為準：啟動與設計大致完成、採購進行中，有逾期、待確認、暫緩與取消的項目。匯入後在專案頁按「設定基準線」。"
                "要移除：後台「備份與匯入 → 示範資料 → 移除示範資料」（刪除示範人員與標籤 #示範 的卡片）。")
    for c in ("A2", "A3"):
        ws[c].font = Font(size=10, color="555555")
    hr = 5
    thin = Side(style="thin", color="BBBBBB")
    for j, (h, w) in enumerate(zip(HEAD, WIDTH), start=1):
        c = ws.cell(row=hr, column=j, value=h)
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="2B4C3F")
        c.alignment = Alignment(horizontal="center", vertical="center")
        ws.column_dimensions[c.column_letter].width = w
    ws.freeze_panes = ws.cell(row=hr + 1, column=4)
    phase_fill = PatternFill("solid", fgColor="E8EEE9")
    for i, (num, title, who, st, pr, start, due, ms, deps, est, note) in enumerate(ROWS, start=hr + 1):
        depth = num.count(".")
        kind = P if depth == 0 else "子任務"
        indent = ("　" * (depth - 1) + "└ ") if depth else ""
        vals = [code(num), kind, indent + title, "#示範 #機房改建" if depth == 0 else None, who, st, pr, start, due, ms, deps, est, note]
        for j, v in enumerate(vals, start=1):
            c = ws.cell(row=i, column=j, value=v)
            c.border = Border(bottom=thin)
            if isinstance(v, date):
                c.number_format = "yyyy/mm/dd"
            c.alignment = Alignment(vertical="center", wrap_text=j in (3, 11, 13))
        if depth <= 1:
            for j in range(1, len(HEAD) + 1):
                ws.cell(row=i, column=j).font = Font(bold=True)
                ws.cell(row=i, column=j).fill = phase_fill
        if depth:
            ws.row_dimensions[i].outlineLevel = min(depth, 7)
    for i, (num, title, who, st, pr, start, due, ms, deps, est, note) in enumerate(OPS, start=hr + 1 + len(ROWS)):
        vals = [code(num), "主任務", title, "#示範", who, st, pr, start, due, ms, deps, est, note]
        for j, v in enumerate(vals, start=1):
            c = ws.cell(row=i, column=j, value=v)
            c.border = Border(bottom=thin)
            if isinstance(v, date):
                c.number_format = "yyyy/mm/dd"
            c.alignment = Alignment(vertical="center", wrap_text=j in (3, 13))
    ws.auto_filter.ref = f"A{hr}:{ws.cell(row=hr, column=len(HEAD)).column_letter}{hr + len(ROWS) + len(OPS)}"
    # the people: created as demo staff by the import (administrators)
    wp = wb.create_sheet("人員")
    wp["A1"] = "示範人員：匯入時不存在的帳號會建立為示範人員（不能登入、不寫入 AD）；已存在的帳號不變"
    wp["A1"].font = Font(size=10, color="555555")
    for j, (h, w) in enumerate(zip(("帳號", "姓名", "部門", "上級"), (22, 12, 14, 22)), start=1):
        c = wp.cell(row=3, column=j, value=h)
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="2B4C3F")
        wp.column_dimensions[c.column_letter].width = w
    for i, (u, n, d, boss) in enumerate(demo.PEOPLE, start=4):
        for j, v in enumerate((u, n, d, boss), start=1):
            wp.cell(row=i, column=j, value=v).border = Border(bottom=thin)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    wb.save(OUT)
    print(f"{OUT}  ({len(ROWS)} project rows, {len(OPS)} cards, {len(demo.PEOPLE)} people)")


if __name__ == "__main__":
    main()
