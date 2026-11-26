"""
AI 助理: what the AI 接入點 (app/ai.py) is used for.

  report(kind, scope)      進度摘要 (summary) · 卡住或逾期項目的處理建議 (blocked) · 週進度 完成／未完成 (week) ·
                           下週排程工作建議 優先度由高到低 (next_week)
  task_suggest(card, sub)  one card or subtask: 建議內容、任務執行流程建議、紀錄所需截圖建議
  project_draft(brief)     生成專案: a whole work breakdown with each task's content, execution flow and the
                           screenshots to keep as records — previewed, then created through the Excel import
                           pipeline (same permissions, levels and dates as an imported report)

Only what the asking person may see goes to the AI: the cards and subtasks come from the board's own list and
Gantt queries (routes/tasks.list_tasks / gantt) called with their request. The deterministic part (which items
are overdue, done this week, due next week …) is computed here and returned with the AI's text, so the lists
are right even when a model is not. Numbers in the context are the outline numbers (A, A1, A1-1, A1-1.1).
"""
import json
import re
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional

from .numbering import child, letters

ZH = {"recurring": "週期工作", "overdue": "過期未結案", "new": "新建", "ongoing": "進行中", "pending": "待確認",
      "onhold": "暫緩", "complete": "完成", "canceled": "取消"}
CLOSED = ("complete", "canceled")
KINDS = ("summary", "blocked", "week", "next_week")
MAX_LINES = 400


def _d(v) -> Optional[date]:
    try:
        return date.fromisoformat(str(v)[:10]) if v else None
    except ValueError:
        return None


def _md(d: Optional[date]) -> str:
    return f"{d.month}/{d.day}" if d else "—"


def week_range(today: Optional[date] = None, offset: int = 0):
    today = today or date.today()
    mon = today - timedelta(days=today.weekday()) + timedelta(weeks=offset)
    return mon, mon + timedelta(days=6)


async def collect(request, scope: str, project_id: Optional[int] = None) -> Dict:
    """The items in scope, flattened with outline numbers: [{code, level, kind, title, status, who, start, due,
    done_at, priority, blocked, est, spent, card, project}]; scope: project | mine | all."""
    from .routes.tasks import gantt, list_tasks
    from .database import get_db
    user = request.state.user
    me = user.get("id")
    cards = await list_tasks(request)
    subs = await gantt(request, project_id if scope == "project" else None)
    if scope == "project":
        if not project_id:
            raise ValueError("請選擇專案")
        if not any(c["id"] == project_id for c in cards):
            raise ValueError("找不到這個專案，或你沒有權限看")
        cards = [c for c in cards if c["id"] == project_id or c.get("project_id") == project_id]
        cards.sort(key=lambda c: (c["id"] != project_id, c.get("sort_order") or 0, c["id"]))
    elif scope == "mine":
        mine_subs = {s["card"] for s in subs if s.get("assignee") and s["assignee"]["id"] == me}
        cards = [c for c in cards if c.get("mine") or c["id"] in mine_subs]
    names = {c["id"]: c["title"] for c in cards if c.get("kind") == "project"}
    kids: Dict = {}
    for s in subs:
        kids.setdefault((s["card"], s["parent"]), []).append(s)
    db = await get_db()
    try:                                          # the latest progress notes (comments) of each card
        notes: Dict = {}
        ids = [c["id"] for c in cards][:300]
        if ids:
            cur = await db.execute(f"""SELECT task_id, body, created_at FROM task_comments WHERE is_task = 0 AND parent_id IS NULL
                                       AND task_id IN ({','.join('?' * len(ids))}) ORDER BY id DESC""", ids)
            for r in await cur.fetchall():
                if len(notes.setdefault(r["task_id"], [])) < 2 and (r["body"] or "").strip():
                    notes[r["task_id"]].append(f"{str(r['created_at'])[5:10]} {r['body'].strip()[:120]}")
    finally:
        await db.close()
    items: List[Dict] = []

    def owner_of_card(c):
        return (c.get("assignees") or [None])[0] or c.get("owner") or {}

    def who_of_card(c):
        p = owner_of_card(c)
        return p.get("name") or p.get("display_name") or p.get("username") or ""

    def walk(card, parent, code, depth):
        for k, s in enumerate(kids.get((card["id"], parent), []), start=1):
            sc = child(code, depth, k)
            items.append({"code": sc, "level": depth + 1, "kind": "sub", "id": s["id"], "card": card["id"], "title": s["title"] or "",
                          "status": s["status"], "who": (s.get("assignee") or {}).get("name") or "", "start": _d(s["start_at"]),
                          "due": _d(s["due_at"]), "done_at": _d(s.get("completed_at")), "priority": s.get("priority") or "normal",
                          "blocked": "", "est": s.get("estimate") or 0, "spent": s.get("spent") or 0, "milestone": s.get("milestone"),
                          "project": names.get(card.get("project_id")) or (card["title"] if card.get("kind") == "project" else ""),
                          "mine": bool(s.get("assignee") and s["assignee"]["id"] == me),
                          "uid": (s.get("assignee") or {}).get("id"), "username": (s.get("assignee") or {}).get("username") or "",
                          "parent": s["parent"], "started": _d(s.get("started_at"))})
            walk(card, s["id"], sc, depth + 1)

    for n, c in enumerate(cards, start=1):
        code = letters(n)
        b = c.get("blocked") or {}
        items.append({"code": code, "level": 1, "kind": "card", "id": c["id"], "card": c["id"], "title": c["title"], "status": c["status"],
                      "who": who_of_card(c), "start": _d(c.get("start_at")), "due": _d(c.get("due_at")), "done_at": _d(c.get("completed_at")),
                      "priority": c.get("priority") or "normal", "blocked": b.get("reason") if b.get("since") else "",
                      "blocked_since": _d(b.get("since")), "est": 0, "spent": 0, "milestone": c.get("milestone"),
                      "project": names.get(c.get("project_id")) or (c["title"] if c.get("kind") == "project" else ""),
                      "is_project": c.get("kind") == "project", "notes": notes.get(c["id"], []), "mine": bool(c.get("mine")),
                      "uid": owner_of_card(c).get("id"), "username": owner_of_card(c).get("username") or "",
                      "desc": c.get("description") or "", "updated": c.get("updated_at")})
        walk(c, None, code, 1)
    return {"items": items, "cards": len(cards), "scope": scope, "project": names.get(project_id) if project_id else None}


def _line(it, today) -> str:
    late = it["due"] and it["status"] not in CLOSED and it["due"] < today
    parts = [f"{it['code']} [{ZH.get(it['status'], it['status'])}] {'◆ ' if it.get('milestone') else ''}{it['title']}"]
    if it["who"]:
        parts.append(f"負責 {it['who']}")
    if it["start"] or it["due"]:
        parts.append(f"{_md(it['start'])}→{_md(it['due'])}" + (f"（逾期 {(today - it['due']).days} 天）" if late else ""))
    if it["priority"] == "high":
        parts.append("高優先")
    if it.get("est") or it.get("spent"):
        parts.append(f"預估 {it['est'] / 60:g}h 已用 {it['spent'] / 60:.1f}h")
    if it.get("blocked"):
        parts.append(f"卡住：{it['blocked']}")
    if it.get("done_at") and it["status"] == "complete":
        parts.append(f"完成於 {_md(it['done_at'])}")
    line = "　" * (it["level"] - 1) + "｜".join(parts)
    for n in it.get("notes") or []:
        line += f"\n{'　' * it['level']}最新留言 {n}"
    return line


def _context(items, today) -> str:
    lines = [_line(it, today) for it in items]
    if len(lines) > MAX_LINES:
        lines = lines[:MAX_LINES] + [f"…（另有 {len(lines) - MAX_LINES} 項未列出）"]
    return "\n".join(lines)


def lists(items, today: Optional[date] = None) -> Dict:
    """The deterministic part of every report."""
    today = today or date.today()
    w0, w1 = week_range(today)
    n0, n1 = week_range(today, 1)
    open_ = [it for it in items if it["status"] not in CLOSED and not it.get("is_project")]
    pick = lambda xs: [{k: (v.isoformat() if isinstance(v, date) else v) for k, v in it.items() if k not in ("notes", "desc")} for it in xs]
    overdue = [it for it in open_ if it["due"] and it["due"] < today]
    blocked = [it for it in open_ if it.get("blocked")]
    done_week = [it for it in items if it["status"] == "complete" and it["done_at"] and w0 <= it["done_at"] <= w1]
    undone_week = [it for it in open_ if (it["due"] and it["due"] <= w1) or (it["start"] and w0 <= it["start"] <= w1) or it["status"] == "ongoing"]
    next_week = [it for it in open_ if (it["due"] and (n0 <= it["due"] <= n1 or it["due"] < n0)) or (it["start"] and it["start"] <= n1)
                 or it["status"] in ("ongoing", "overdue")]
    leaves = [it for it in items if not it.get("is_project") and it["status"] != "canceled"]
    done = sum(1 for it in leaves if it["status"] == "complete")
    return {"today": today.isoformat(), "week": [w0.isoformat(), w1.isoformat()], "next_week": [n0.isoformat(), n1.isoformat()],
            "counts": {"items": len(leaves), "done": done, "pct": round(done / len(leaves) * 100) if leaves else 0,
                       "overdue": len(overdue), "blocked": len(blocked), "done_week": len(done_week), "undone_week": len(undone_week)},
            "overdue": pick(overdue), "blocked": pick(blocked), "done_week": pick(done_week), "undone_week": pick(undone_week),
            "candidates_next": pick(next_week)}


PROMPTS = {
    "summary": """請根據下面的工作清單寫一份「進度摘要」給主管看（Markdown）：
## 整體進度
一兩句：完成比例、整體是否如期、最需要注意的一件事。
## 各項進度
依主要工作（第一、二層）條列：目前狀態、已完成什麼、接下來做什麼（引用編號）。
## 風險與注意事項
逾期、卡住、工時超出預估、即將到期的里程碑（沒有就寫「無」）。""",
    "blocked": """下面是工作清單，其中標示「卡住」或「逾期」的項目需要處理。請針對每一個卡住或逾期的項目給出處理建議（Markdown）：
## 需要處理的項目
每一項一段：**編號 項目名稱**（負責人、逾期或卡住多久）→ 可能原因（只根據清單與留言推測，推測要寫「可能」）→ 建議的處理步驟（具體、可執行，誰去做）→ 是否需要調整到期日或升級給主管。
依影響大小排序：卡住影響後續工作的、高優先、逾期最久的排前面。
## 建議的整體調整
例如重新分派、調整排程、先處理哪幾項（沒有就寫「無」）。""",
    "week": """請根據下面的工作清單與「本週已完成／本週未完成」兩份清單，寫一份週進度報告（Markdown）：
## 本週重點
兩三句總結。
## 本週已完成
條列（編號、項目、負責人）；沒有就寫「無」。
## 本週未完成
條列（編號、項目、負責人、原因或目前卡在哪、預計何時完成）；沒有就寫「無」。
## 下週注意
一到三點。""",
    "next_week": """請根據下面的工作清單與「下週候選工作」，排出下週的工作建議，**依優先度由高到低**（Markdown）：
## 下週排程建議
用表格：| 優先 | 編號 | 項目 | 負責人 | 建議時間 | 理由 |
排序原則：已逾期與卡住影響後續的最優先，其次是里程碑與高優先、到期日近的、前置工作已完成可以開始的；每個負責人一週的量要合理，太多時指出來。
## 可以延後的工作
沒有就寫「無」。""",
}
TITLES = {"summary": "進度摘要", "blocked": "卡住或逾期項目的處理建議", "week": "週進度（完成／未完成）", "next_week": "下週排程工作建議"}


def _fmt_list(title, xs, today):
    if not xs:
        return f"### {title}\n（無）"
    return f"### {title}\n" + "\n".join("- " + _line({**x, "start": _d(x["start"]), "due": _d(x["due"]), "done_at": _d(x["done_at"]),
                                                       "level": 1, "notes": []}, today) for x in xs[:120])


def build_report_prompt(kind: str, data: Dict, header: str) -> str:
    today = date.fromisoformat(data["lists"]["today"])
    L = data["lists"]
    extra = ""
    if kind == "blocked":
        extra = _fmt_list("卡住的項目", L["blocked"], today) + "\n\n" + _fmt_list("逾期的項目", L["overdue"], today)
    elif kind == "week":
        extra = _fmt_list(f"本週已完成（{L['week'][0]}～{L['week'][1]}）", L["done_week"], today) + "\n\n" + \
                _fmt_list("本週未完成", L["undone_week"], today)
    elif kind == "next_week":
        extra = _fmt_list(f"下週候選工作（{L['next_week'][0]}～{L['next_week'][1]}，含逾期與進行中）", L["candidates_next"], today)
    return (f"今天是 {today.isoformat()}（{'一二三四五六日'[today.weekday()]}）。{header}\n"
            f"整體：{L['counts']['items']} 項，完成 {L['counts']['done']} 項（{L['counts']['pct']}%），逾期 {L['counts']['overdue']} 項，卡住 {L['counts']['blocked']} 項。\n\n"
            f"{PROMPTS[kind]}\n\n只能根據下面的內容回答，引用項目時寫編號（例如 A2-3）。\n\n"
            f"--- 工作清單（編號 [狀態] 項目｜負責人｜開始→到期｜…）---\n{data['context']}\n\n{extra}").strip()


# ---------------------------------------------------------------- one task
TASK_PROMPT = """請為下面這項工作給建議（Markdown，繁體中文）：
## 建議內容
這項工作應該包含什麼、完成的標準（驗收條件）。
## 任務執行流程建議
編號步驟，具體可執行；有風險的步驟（停機、變更設定、刪除資料）要寫事前確認與回復方式。
## 紀錄所需截圖建議
條列每一張要保留的截圖：在哪個步驟、截什麼畫面、要看得到哪些資訊（例如設定值、序號、時間、結果）、建議的檔名。
只根據提供的內容與一般的 IT／機房作業常識回答，不確定的地方寫「需確認」。"""


# ---------------------------------------------------------------- project generation
PROJECT_PROMPT = """請規劃一個專案，只輸出一個 JSON 物件（不要 Markdown、不要說明文字），格式：
{"title": "專案名稱", "description": "專案目標與範圍（2–4 句）",
 "tasks": [{"title": "主任務", "description": "這項工作的內容與完成標準", "flow": ["執行步驟1", "步驟2"],
            "screenshots": ["要保留的截圖：在哪一步、截什麼、要看得到什麼"], "start_day": 0, "days": 5, "milestone": false,
            "children": [ …同樣格式的子任務… ]}]}
規則：
- 主任務 4–8 項，依執行順序排列；每項底下 2–6 個子任務；需要時子任務底下可以再分一層（最多到第 {levels} 層，主任務算第 1 層）。
- start_day 是從專案開始日起算第幾天（0 起算），days 是工作天數；子任務要落在上一層的期間內；有先後關係的要排在後面。
- flow 是具體可執行的步驟；有風險的步驟要寫事前確認與回復方式。
- screenshots 是做這項工作時要截圖留存的畫面（設定前後、測試結果、序號、驗收）；不需要截圖的寫 []。
- 驗收、上線、簽核這類時間點設 milestone: true、days: 0。
- 使用繁體中文。"""


def parse_json(text: str) -> Dict:
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", (text or "").strip(), flags=re.M)
    i, j = t.find("{"), t.rfind("}")
    if i < 0 or j <= i:
        raise ValueError("AI 沒有回傳 JSON")
    try:
        return json.loads(t[i:j + 1])
    except json.JSONDecodeError as e:
        raise ValueError(f"AI 回傳的 JSON 有誤：{e.msg}")


def normalize_plan(plan: Dict, levels: int = 4) -> Dict:
    """Keep only the fields we use, with sane types; drop empty titles; cap the depth and size."""
    def task(t, depth):
        if not isinstance(t, dict) or not str(t.get("title") or "").strip():
            return None
        out = {"title": str(t["title"]).strip()[:200], "description": str(t.get("description") or "").strip()[:1500],
               "flow": [str(x).strip()[:300] for x in (t.get("flow") or []) if str(x).strip()][:20],
               "screenshots": [str(x).strip()[:300] for x in (t.get("screenshots") or []) if str(x).strip()][:20],
               "start_day": max(0, int(t.get("start_day") or 0)) if str(t.get("start_day") or 0).lstrip("-").isdigit() else 0,
               "days": max(0, min(730, int(t.get("days") or 0))) if str(t.get("days") or 0).isdigit() else 1,
               "milestone": bool(t.get("milestone")), "children": []}
        if depth < levels:
            out["children"] = [c for c in (task(x, depth + 1) for x in (t.get("children") or [])[:15]) if c]
        return out
    tasks = [t for t in (task(x, 1) for x in (plan.get("tasks") or [])[:20]) if t]
    if not tasks:
        raise ValueError("AI 的規劃裡沒有任何工作項目")
    return {"title": str(plan.get("title") or "").strip()[:200] or "新專案", "description": str(plan.get("description") or "").strip()[:2000],
            "tasks": tasks}


def task_text(t: Dict) -> str:
    """A subtask's description: content, flow, screenshots."""
    parts = [t["description"]] if t.get("description") else []
    if t.get("flow"):
        parts.append("執行流程：\n" + "\n".join(f"{i}. {s}" for i, s in enumerate(t["flow"], start=1)))
    if t.get("screenshots"):
        parts.append("需要截圖紀錄：\n" + "\n".join(f"- {s}" for s in t["screenshots"]))
    return "\n\n".join(parts)[:4000]


def plan_items(plan: Dict, start: date) -> List[Dict]:
    """The plan as Excel-import items (app/xlsx_export.parse format): one project card, nested subtasks with dates."""
    items = [{"row": 1, "errors": [], "title": plan["title"], "kind": "card", "id": None, "num": "1", "depth": 0, "card_kind": "project"}]
    span = [start, start]

    def walk(ts, prefix, depth):
        for k, t in enumerate(ts, start=1):
            num = f"{prefix}.{k}"
            s = start + timedelta(days=t["start_day"])
            e = s + timedelta(days=max(0, t["days"] - 1)) if t["days"] else s
            span[1] = max(span[1], e)
            it = {"row": len(items) + 1, "errors": [], "title": t["title"], "kind": "sub", "id": None, "num": num, "depth": depth,
                  "due_at": e.isoformat(), "_text": task_text(t)}
            if t["milestone"]:
                it["milestone"] = True
            else:
                it["start_at"] = s.isoformat()
            items.append(it)
            walk(t["children"], num, depth + 1)
    walk(plan["tasks"], "1", 1)
    items[0]["start_at"], items[0]["due_at"] = start.isoformat(), span[1].isoformat()
    return items
