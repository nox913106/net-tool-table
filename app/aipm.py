"""
AiPM: a proactive AI project manager on top of the AI 接入點 (app/ai.py).

For every department (administration, management, PM, infrastructure, R&D …), not only engineers.
A member pastes screenshots and writes a line about what happened; AiPM reads the whole project (every
level, dates, owners, notes, attachments), what the system computes on its own (overdue, blocked, stale,
milestones coming up, no owner / no date / no estimate, done without any record, schedule behind plan) and
its own open items, and answers with

  reply        to the member, short
  forecast     what is likely to happen next (risks, knock-on effects) — marked as an estimate
  questions    up to 3 precise follow-up questions with clickable options, sent to the right person
  proposals    changes to the project: append_note (acceptance criteria, screenshot checklist, notes) — low risk;
               add_subtask / set_dates / set_status / set_assignee / set_priority / set_blocked — high risk.
               HARD RULE: AiPM never changes anything by itself. Every change waits until the project's lead
               (負責人, the owner of the project card) or a board administrator with edit rights over it
               (看板總管理者 RW, or the 部門看板管理者 RW of its departments) approves it; items that are complete
               or canceled are never changed by AiPM.
  tracking     things to follow up (a vendor reply, a change window, a check after go-live …)

It also works without being asked: after the project changes (checked every 10 minutes, at most every 30
minutes per project) and once a day at the 巡檢 time (default 08:30) it runs the same review, leaves its
suggestions for approval and tells only the people concerned.

Targeted, without exception: a notification goes only to the person it is for (the one asked; the project's
approvers) and only if that person can already see the card it is about. In the panel everyone sees only the
messages and items about cards they can see (each message keeps the cards its context covered).

An approved change goes through the board's own route functions with the approver's request (the usual
permissions apply too); the background review reads as 「AiPM」 (a system account that can see every card) but
changes nothing.
Screenshots are sent only to services marked 「可看圖片」 that are on-premises, unless cloud images are
allowed (ai.sees_images). Tables are local to each copy and never synced.
"""
import asyncio
import base64
import json
import logging
from datetime import date, datetime, timedelta
from types import SimpleNamespace
from typing import Dict, List, Optional

from fastapi import HTTPException

from . import ai
from . import ai_assist as A
from .auth import ANON
from .database import get_db

log = logging.getLogger("tool_table")

SYSTEM = {**ANON, "username": "aipm", "display_name": "AiPM", "role": "superadmin", "sys_admin": 0}
LOW = ("append_note",)
HIGH = ("add_subtask", "set_dates", "set_status", "set_assignee", "set_priority", "set_blocked")
ACTION_ZH = {"append_note": "補充說明", "add_subtask": "新增工作", "set_dates": "調整日期", "set_status": "變更狀態",
             "set_assignee": "指派負責人", "set_priority": "調整優先度", "set_blocked": "標記卡住"}
MAX_IMAGES, MAX_IMAGE_BYTES = 6, 5 * 1024 * 1024
STALE_DAYS = 5
EVENT_GAP_MIN, EVENT_SETTLE_MIN = 30, 10
NOTE_MARK = "【AiPM】"


def sys_request():
    return SimpleNamespace(state=SimpleNamespace(user=SYSTEM), headers={}, client=None)


# ---------------------------------------------------------------- storage
async def ensure(db):
    await db.execute("""CREATE TABLE IF NOT EXISTS aipm_messages (
                            id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL, role TEXT NOT NULL,
                            user_id INTEGER, text TEXT, images TEXT, payload TEXT, source TEXT,
                            at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime')))""")
    await db.execute("CREATE INDEX IF NOT EXISTS idx_aipm_msg ON aipm_messages(card_id, id)")
    cur = await db.execute("PRAGMA table_info(aipm_messages)")
    if "cards" not in {r[1] for r in await cur.fetchall()}:     # the cards a message's context covered (who may read it)
        await db.execute("ALTER TABLE aipm_messages ADD COLUMN cards TEXT")
    await db.execute("""CREATE TABLE IF NOT EXISTS aipm_items (
                            id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL, message_id INTEGER,
                            kind TEXT NOT NULL, risk TEXT, status TEXT NOT NULL DEFAULT 'pending',
                            title TEXT, detail TEXT, code TEXT, target_card INTEGER, target_sub INTEGER,
                            action TEXT, undo TEXT, options TEXT, assignee_id INTEGER, answer TEXT, source TEXT, error TEXT,
                            due TEXT, done_by INTEGER,
                            created_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime')),
                            done_at TIMESTAMP)""")
    await db.execute("CREATE INDEX IF NOT EXISTS idx_aipm_items ON aipm_items(card_id, status)")
    await db.execute("""CREATE TABLE IF NOT EXISTS aipm_runs (card_id INTEGER PRIMARY KEY, last_at TEXT, seen_update TEXT,
                            patrol_day TEXT, last_error TEXT)""")


def enabled() -> bool:
    s = ai.settings()
    return bool(s["enabled"] and s.get("aipm_enabled", True))


# ---------------------------------------------------------------- the picture of a project
async def _root(db, card_id: int) -> Dict:
    cur = await db.execute("SELECT id, title, kind, status, project_id FROM tasks WHERE id = ?", (card_id,))
    r = await cur.fetchone()
    if not r:
        raise ValueError("找不到這張卡片")
    r = dict(r)
    if r["kind"] != "project" and r["project_id"]:            # a card of a project: AiPM works on the whole project
        cur = await db.execute("SELECT id, title, kind, status, project_id FROM tasks WHERE id = ? AND kind = 'project'", (r["project_id"],))
        p = await cur.fetchone()
        if p:
            return dict(p)
    return r


async def snapshot(request, card_id: int) -> Dict:
    """Items (outline numbers), extras (descriptions, attachments, last activity), signals, people."""
    db = await get_db()
    try:
        root = await _root(db, card_id)
    finally:
        await db.close()
    if root["kind"] == "project":
        data = await A.collect(request, "project", root["id"])
        items = data["items"]
    else:
        data = await A.collect(request, "all")
        items = [it for it in data["items"] if it["card"] == root["id"]]
        if not items:
            raise ValueError("找不到這張卡片，或你沒有權限看")
    cards = sorted({it["card"] for it in items})
    db = await get_db()
    try:
        marks = ",".join("?" * len(cards))
        cur = await db.execute(f"""SELECT c.id, c.body, c.edited_at, c.started_at, c.created_at,
                                      (SELECT COUNT(*) FROM task_images i WHERE i.comment_id = c.id
                                         OR i.comment_id IN (SELECT r.id FROM task_comments r WHERE r.parent_id = c.id)) AS files,
                                      (SELECT MAX(r.created_at) FROM task_comments r WHERE r.parent_id = c.id) AS last_reply,
                                      (SELECT MAX(COALESCE(tt.ended_at, tt.started_at)) FROM task_time tt WHERE tt.comment_id = c.id) AS last_time
                               FROM task_comments c WHERE c.is_task = 1 AND c.task_id IN ({marks})""", cards)
        subs = {r["id"]: dict(r) for r in await cur.fetchall()}
        cur = await db.execute(f"SELECT task_id, COUNT(*) AS n FROM task_images WHERE pending = 0 AND task_id IN ({marks}) GROUP BY task_id", cards)
        card_files = {r["task_id"]: r["n"] for r in await cur.fetchall()}
        cur = await db.execute(f"""SELECT DISTINCT u.id, u.username, u.display_name FROM users u WHERE u.active = 1 AND (
                                      u.id IN (SELECT user_id FROM task_members WHERE task_id IN ({marks}))
                                      OR u.id IN (SELECT owner_id FROM tasks WHERE id IN ({marks}))
                                      OR u.id IN (SELECT assignee_id FROM task_comments WHERE is_task = 1 AND task_id IN ({marks})))""",
                               [*cards, *cards, *cards])
        people = [dict(r) for r in await cur.fetchall()]
    finally:
        await db.close()
    today = date.today()
    for it in items:
        if it["kind"] == "sub":
            x = subs.get(it["id"], {})
            it["desc"] = x.get("body") or ""
            it["files"] = x.get("files") or 0
            acts = [v for v in (x.get("edited_at"), x.get("last_reply"), x.get("last_time"), x.get("started_at"), x.get("created_at")) if v]
            it["last_act"] = A._d(max(str(v) for v in acts)) if acts else None
        else:
            it["files"] = card_files.get(it["id"], 0)
            it["last_act"] = A._d(it.get("updated"))
    sig = signals(items, today)
    db = await get_db()
    try:                                     # closed without being aligned with AiPM: flagged (never blocked)
        cl = await _rows(db, f"SELECT card_id, sub_id, title, closed_at FROM aipm_closures WHERE aligned = 0 AND card_id IN ({marks})", cards)
    finally:
        await db.close()
    where = {(it["card"], it["id"] if it["kind"] == "sub" else None): it for it in items}
    for c in cl:
        it = where.get((c["card_id"], c["sub_id"]))
        if it:
            sig.append({"code": it["code"], "kind": "unaligned", "severity": "medium", "title": it["title"],
                        "text": f"已結案但還沒跟 AiPM 做結案對齊（{str(c['closed_at'] or '')[:10]}）"})
    return {"root": root, "items": items, "people": people, "signals": sig, "today": today}


def _leaf(items, it) -> bool:
    if it["kind"] == "card":
        return not any(x["kind"] == "sub" and x["card"] == it["id"] and x["parent"] is None for x in items)
    return not any(x["kind"] == "sub" and x.get("parent") == it["id"] for x in items)


def signals(items: List[Dict], today: date) -> List[Dict]:
    """What the system sees without any AI: [{code, kind, severity, text}] (high first)."""
    out = []
    add = lambda it, kind, sev, text: out.append({"code": it["code"], "kind": kind, "severity": sev, "text": text, "title": it["title"]})
    leaves = [it for it in items if not it.get("is_project") and _leaf(items, it) and it["status"] != "canceled"]
    for it in items:
        if it.get("is_project") or it["status"] in A.CLOSED:
            continue
        leaf = _leaf(items, it)
        if it["due"] and it["due"] < today:
            add(it, "overdue", "high", f"逾期 {(today - it['due']).days} 天（到期 {A._md(it['due'])}）")
        elif it["due"] and (it["due"] - today).days <= 3 and it["status"] == "new" and leaf:
            add(it, "not_started", "medium", f"{(it['due'] - today).days} 天後到期，還沒開始")
        if it.get("blocked"):
            since = it.get("blocked_since")
            add(it, "blocked", "high", f"卡住{f' {(today - since).days} 天' if since else ''}：{it['blocked']}")
        if it.get("milestone") and it["due"] and 0 <= (it["due"] - today).days <= 7:
            add(it, "milestone", "medium", f"里程碑 {A._md(it['due'])}（{(it['due'] - today).days} 天後）")
        if not leaf:
            continue
        if it["status"] == "ongoing" and it.get("last_act") and (today - it["last_act"]).days >= STALE_DAYS:
            add(it, "stale", "medium", f"進行中但 {(today - it['last_act']).days} 天沒有任何更新")
        if not it.get("who"):
            add(it, "no_owner", "medium", "沒有負責人")
        if not it["due"]:
            add(it, "no_date", "low", "沒有到期日")
        if it["kind"] == "sub" and not it.get("est"):
            add(it, "no_estimate", "low", "沒有預估工時")
        if not (it.get("desc") or "").strip():
            add(it, "no_desc", "low", "沒有說明（做法、驗收條件）")
    for it in leaves:
        if it["status"] == "complete" and not it.get("files") and not it.get("is_project"):
            add(it, "no_record", "low", "已完成但沒有留下截圖或檔案紀錄")
    planned = [it for it in leaves if it["due"] and it["due"] <= today]
    if len(leaves) >= 4 and planned:
        should = len(planned) / len(leaves)
        done = sum(1 for it in leaves if it["status"] == "complete") / len(leaves)
        if should - done >= 0.15:
            top = next((it for it in items if it.get("is_project")), items[0])
            out.append({"code": top["code"], "kind": "behind", "severity": "high", "title": top["title"],
                        "text": f"依計畫今天應完成 {round(should * 100)}%，實際完成 {round(done * 100)}%（落後 {round((should - done) * 100)}%）"})
    rank = {"high": 0, "medium": 1, "low": 2}
    out.sort(key=lambda s: rank[s["severity"]])
    return out


# ---------------------------------------------------------------- prompt
SYSTEM_PROMPT = """你是 AiPM：一位資深的專案經理，協助全公司各部門的專案——行政、管理、PM、基礎架構（Infra）、研發（RD）、採購、人資、財務、業務等。
先從專案內容判斷它屬於哪個領域，用那個領域的專業來看：例如 Infra 的變更管理與停機窗口、RD 的需求、測試與發佈、行政與採購的簽核、合約與交期、活動的場地與人員。
你主動、比負責的人多想一步：預判接下來可能發生的事與連鎖影響（相依工作、時程、簽核、採購交期、人力負荷），指出該補的工作項目、完成或驗收條件、該留的截圖與紀錄、要協調的人。
成員應該專注在自己的專業，你負責把專案內容與追蹤做完整：寫好的補充要能直接放進文件；問題要具體、一次最多 3 個，並附上可以直接點選的選項。
你提出的變更都要等專案負責人或看板管理人核准才會生效，所以每一項都要寫清楚理由。
只根據提供的資料判斷；已發生的事不能編造，推測要寫明是「預估」。用繁體中文，精簡、專業。"""

SCHEMA = """請只輸出一個 JSON 物件（不要 Markdown 圍欄、不要其他文字），格式：
{
 "reply": "給成員的回覆，Markdown，3–8 行：先回應他剛說的或附的截圖，再講你的判斷與接下來要注意的事（巡檢時寫巡檢摘要）",
 "understanding": "你從描述與截圖理解到的目前狀況，1–3 句；沒有新訊息時留空",
 "forecast": [{"code": "項目編號", "severity": "high|medium|low", "text": "預估會發生什麼、為什麼、影響到哪些項目"}],
 "questions": [{"code": "項目編號", "q": "要問的問題", "why": "為什麼需要知道", "options": ["選項1", "選項2"], "ask": "該回答的人的帳號（從人員清單挑，不確定就留空）"}],
 "proposals": [{"action": "append_note|add_subtask|set_dates|set_status|set_assignee|set_priority|set_blocked",
                "code": "要改的項目編號（add_subtask 時是上層項目）", "title": "add_subtask 的新工作名稱",
                "text": "append_note 要補進說明的內容（驗收條件、截圖清單、注意事項…，可多行）／add_subtask 的做法說明／set_blocked 的原因",
                "start": "YYYY-MM-DD", "due": "YYYY-MM-DD", "status": "new|ongoing|pending|onhold|complete|canceled",
                "assignee": "帳號", "priority": "high|normal|low", "reason": "為什麼要這樣改"}],
 "tracking": [{"code": "項目編號", "title": "要追蹤的事", "detail": "追什麼、問誰、什麼時候", "due": "YYYY-MM-DD 或空"}],
 "resolve": [已經完成、不用再追的「待追蹤事項」id 數字]
}
規則：
- 項目編號只能用清單裡的編號；不要重複「待追蹤事項」與「尚未回答的問題」已有的內容。
- 狀態是完成或取消的項目不能提出任何變更。
- append_note 用來補充說明（不會覆蓋原本的內容）；缺少的工作用 add_subtask；日期、狀態、負責人、優先度的變更只在有根據時提出。
- 有父項目的工作，日期由子項目自動計算，不要直接改父項目的日期。
- proposals 最多 6 項、questions 最多 3 個、tracking 最多 5 項、forecast 最多 5 項；沒有就給空陣列。"""


def _item_line(it, today) -> str:
    line = A._line({**it, "notes": []}, today)
    extra = []
    desc = " ".join((it.get("desc") or "").split())
    extra.append(f"說明：{desc[:160]}{'…' if len(desc) > 160 else ''}" if desc else "說明：無")
    if it.get("files"):
        extra.append(f"附件 {it['files']}")
    if it.get("last_act"):
        extra.append(f"最後更新 {(today - it['last_act']).days} 天前")
    if it.get("username"):
        extra.append(f"帳號 {it['username']}")
    line += "｜" + "｜".join(extra)
    for n in it.get("notes") or []:
        line += f"\n{'　' * it['level']}最新留言 {n}"
    return line


def build_prompt(snap: Dict, open_items: List[Dict], history: List[Dict], message: Optional[Dict], source: str) -> str:
    today = snap["today"]
    items = snap["items"]
    lines = [_item_line(it, today) for it in items[:A.MAX_LINES]]
    if len(items) > A.MAX_LINES:
        lines.append(f"…（另有 {len(items) - A.MAX_LINES} 項未列出）")
    sig = "\n".join(f"- {s['code']} {s['title']}：{s['text']}" for s in snap["signals"][:40]) or "（無）"
    people = "、".join(f"{p['display_name'] or p['username']}（{p['username']}）" for p in snap["people"]) or "（無）"
    track = "\n".join(f"- id {x['id']}｜{x['code'] or ''} {x['title']}｜{x['detail'] or ''}" for x in open_items if x["kind"] == "tracking") or "（無）"
    asked = "\n".join(f"- {x['code'] or ''} {x['title']}" for x in open_items if x["kind"] == "question") or "（無）"
    pend = "\n".join(f"- {x['code'] or ''} {ACTION_ZH.get((json.loads(x['action'] or '{}')).get('action'), '')}：{x['title']}"
                     for x in open_items if x["kind"] == "proposal") or "（無）"
    chat = "\n".join(f"{'成員' if m['role'] == 'user' else 'AiPM'}（{m['at'][5:16]}）：{(m['text'] or '')[:400]}" for m in history[-8:]) or "（無）"
    head = f"今天 {today.isoformat()}（週{'一二三四五六日'[today.weekday()]}）。{'專案' if snap['root']['kind'] == 'project' else '卡片'}：{snap['root']['title']}"
    if message:
        ask = (f"成員剛剛{'針對 ' + message['code'] + ' ' if message.get('code') else ''}說："
               f"{message['text'] or '（沒有文字）'}" + (f"\n並附了 {message['images']} 張截圖（如果你看得到圖，先描述你從圖中看到的重點）。" if message.get("images") else ""))
    elif source == "patrol":
        ask = "這是每日例行巡檢：沒有人留言。請主動檢視整個專案，指出今天最該注意的事、預估接下來的風險，並補上缺漏的內容。"
    else:
        ask = "專案剛有變動：請檢視最近的變化，判斷有沒有需要補充、追蹤或提醒的事。"
    return (f"{head}\n\n## 專案項目（編號｜狀態｜名稱｜負責｜日期｜…）\n" + "\n".join(lines)
            + f"\n\n## 系統偵測到的狀況\n{sig}\n\n## 人員\n{people}\n\n## 待追蹤事項（未結）\n{track}"
            + f"\n\n## 尚未回答的問題\n{asked}\n\n## 尚未處理的變更建議\n{pend}\n\n## 最近的對話\n{chat}\n\n## 這次\n{ask}\n\n{SCHEMA}")


# ---------------------------------------------------------------- normalizing what the model said
def _date_or_none(v):
    d = A._d(v)
    return d.isoformat() if d else None


def normalize(raw: Dict, snap: Dict) -> Dict:
    codes = {it["code"]: it for it in snap["items"]}
    users = {p["username"]: p for p in snap["people"]}
    names = {(p["display_name"] or "").strip(): p for p in snap["people"] if p.get("display_name")}

    def person(v):
        v = str(v or "").strip().lstrip("@")
        return users.get(v) or names.get(v)

    def code(v):
        v = str(v or "").strip()
        return v if v in codes else None

    s = lambda v, n: " ".join(str(v or "").split())[:n] if n < 400 else str(v or "").strip()[:n]
    out = {"reply": str(raw.get("reply") or "").strip()[:4000], "understanding": s(raw.get("understanding"), 600),
           "forecast": [], "questions": [], "proposals": [], "tracking": [],
           "resolve": [int(x) for x in (raw.get("resolve") or []) if str(x).isdigit()][:20]}
    for f in (raw.get("forecast") or [])[:5]:
        if isinstance(f, dict) and f.get("text"):
            out["forecast"].append({"code": code(f.get("code")), "severity": f.get("severity") if f.get("severity") in ("high", "medium", "low") else "medium",
                                    "text": s(f["text"], 400)})
    for q in (raw.get("questions") or [])[:3]:
        if isinstance(q, dict) and q.get("q"):
            p = person(q.get("ask"))
            c = code(q.get("code"))
            if not p and c:                                       # default: the item's owner
                p = users.get(codes[c].get("username") or "")
            out["questions"].append({"code": c, "q": s(q["q"], 300), "why": s(q.get("why"), 300),
                                     "options": [s(o, 80) for o in (q.get("options") or []) if str(o).strip()][:5],
                                     "assignee_id": p["id"] if p else None})
    for pr in (raw.get("proposals") or [])[:6]:
        if not isinstance(pr, dict) or pr.get("action") not in LOW + HIGH:
            continue
        c = code(pr.get("code"))
        if not c:
            continue
        it = codes[c]
        if it["status"] in A.CLOSED:                             # hard rule: closed items are never changed by AiPM
            continue
        act = {"action": pr["action"], "card": it["card"], "sub": it["id"] if it["kind"] == "sub" else None, "code": c}
        a = pr["action"]
        if a == "append_note":
            if not str(pr.get("text") or "").strip():
                continue
            act["text"] = str(pr["text"]).strip()[:2000]
            title = f"{c} 補充說明"
        elif a == "add_subtask":
            if not str(pr.get("title") or "").strip():
                continue
            act.update(title=s(pr["title"], 200), text=str(pr.get("text") or "").strip()[:2000],
                       start=_date_or_none(pr.get("start")), due=_date_or_none(pr.get("due")))
            p = person(pr.get("assignee"))
            act["assignee"] = p["username"] if p else None
            title = f"在 {c} 下新增「{act['title']}」"
        elif a == "set_dates":
            act.update(start=_date_or_none(pr.get("start")), due=_date_or_none(pr.get("due")))
            if not act["start"] and not act["due"]:
                continue
            act["old"] = {"start": it["start"].isoformat() if it["start"] else None, "due": it["due"].isoformat() if it["due"] else None}
            title = f"{c} 日期改為 {act['start'] or '—'} → {act['due'] or '—'}"
        elif a == "set_status":
            if pr.get("status") not in ("new", "ongoing", "pending", "onhold", "complete", "canceled") or pr["status"] == it["status"]:
                continue
            act.update(status=pr["status"], old=it["status"])
            title = f"{c} 狀態改為 {A.ZH.get(pr['status'], pr['status'])}"
        elif a == "set_assignee":
            p = person(pr.get("assignee"))
            if not p or p["username"] == it.get("username"):
                continue
            act.update(assignee=p["username"], old=it.get("username") or "")
            title = f"{c} 負責人改為 {p['display_name'] or p['username']}"
        elif a == "set_priority":
            if pr.get("priority") not in ("high", "normal", "low") or pr["priority"] == it["priority"]:
                continue
            act.update(priority=pr["priority"], old=it["priority"])
            title = f"{c} 優先度改為 {dict(high='高', normal='一般', low='低')[pr['priority']]}"
        else:                                                    # set_blocked: cards only
            if it["kind"] != "card" or it.get("blocked") or not str(pr.get("text") or "").strip():
                continue
            act["text"] = s(pr["text"], 300)
            title = f"{c} 標記卡住"
        out["proposals"].append({"action": act, "risk": "low" if a in LOW else "high", "title": title[:200],
                                 "detail": s(pr.get("reason"), 400), "code": c})
    for t in (raw.get("tracking") or [])[:5]:
        if isinstance(t, dict) and t.get("title"):
            c = code(t.get("code"))
            out["tracking"].append({"code": c, "title": s(t["title"], 200), "detail": s(t.get("detail"), 400),
                                    "due": _date_or_none(t.get("due")),
                                    "card": codes[c]["card"] if c else snap["root"]["id"],
                                    "sub": codes[c]["id"] if c and codes[c]["kind"] == "sub" else None})
    return out


# ---------------------------------------------------------------- applying a change
async def apply_action(act: Dict, request) -> Dict:
    """Make the change with the board's own route functions (their permissions). Returns the undo record."""
    from .routes import tasks as T
    a, card, sub = act["action"], act["card"], act.get("sub")
    db = await get_db()
    try:                                     # hard rule: AiPM never changes an item that is complete or canceled
        cur = await db.execute("SELECT status FROM task_comments WHERE id = ? AND task_id = ?", (sub, card)) if sub else \
            await db.execute("SELECT status FROM tasks WHERE id = ?", (card,))
        r = await cur.fetchone()
    finally:
        await db.close()
    if not r:
        raise ValueError("這個項目已經不存在")
    if r[0] in A.CLOSED:
        raise ValueError("這個項目已經完成或取消，AiPM 不能變更")
    if a == "append_note":
        db = await get_db()
        try:
            if sub:
                cur = await db.execute("SELECT body FROM task_comments WHERE id = ? AND task_id = ?", (sub, card))
            else:
                cur = await db.execute("SELECT description FROM tasks WHERE id = ?", (card,))
            r = await cur.fetchone()
        finally:
            await db.close()
        if not r:
            raise ValueError("這個項目已經不存在")
        old = r[0] or ""
        limit = 4000 if sub else 5000
        new = (old.rstrip() + "\n\n" if old.strip() else "") + f"{NOTE_MARK}{datetime.now():%m/%d}\n{act['text']}"
        if len(new) > limit:
            raise ValueError("說明已經太長，請整理後再補充")
        if sub:
            await T.edit_comment(card, sub, T.CommentEdit(body=new), request)
        else:
            await T.update_task(card, T.TaskUpdate(description=new), request)
        return {"old": old, "new": new}
    if a == "add_subtask":
        r = await T.create_subtask(card, T.SubtaskNew(title=act["title"], parent=sub, assignee=act.get("assignee"),
                                                       due_at=act.get("due")), request)
        new_id = r["id"]
        if act.get("text"):
            await T.edit_comment(card, new_id, T.CommentEdit(body=f"{act['text']}\n\n（由 AiPM 建議新增）"), request)
        if act.get("start"):
            try:
                await T.update_subtask(card, new_id, T.SubtaskIn(start_at=act["start"]), request)
            except HTTPException:
                pass
        return {"created": new_id}
    if a == "set_blocked":
        await T.set_blocked(card, T.BlockedIn(blocked=True, reason=act["text"]), request)
        return {"blocked": True}
    fields = {"set_dates": lambda: {k: v for k, v in (("start_at", act.get("start")), ("due_at", act.get("due"))) if v},
              "set_status": lambda: {"status": act["status"]},
              "set_priority": lambda: {"priority": act["priority"]},
              "set_assignee": lambda: {"assignee": act["assignee"]} if sub else {"assignees": [act["assignee"]]}}[a]()
    if sub:
        await T.update_subtask(card, sub, T.SubtaskIn(**fields), request)
    else:
        await T.update_task(card, T.TaskUpdate(**fields), request)
    return {"old": act.get("old")}


async def undo_action(act: Dict, undo: Dict, request):
    from .routes import tasks as T
    a, card, sub = act["action"], act["card"], act.get("sub")
    if a == "append_note":
        db = await get_db()
        try:
            cur = await db.execute("SELECT body FROM task_comments WHERE id = ?", (sub,)) if sub else \
                await db.execute("SELECT description FROM tasks WHERE id = ?", (card,))
            r = await cur.fetchone()
        finally:
            await db.close()
        if not r or (r[0] or "") != undo["new"]:
            raise ValueError("說明在補充之後又被修改過，請直接編輯項目")
        if sub:
            await T.edit_comment(card, sub, T.CommentEdit(body=undo["old"] or " "), request)
        else:
            await T.update_task(card, T.TaskUpdate(description=undo["old"]), request)
    elif a == "add_subtask":
        await T.delete_comment(card, undo["created"], request)
    elif a == "set_blocked":
        await T.set_blocked(card, T.BlockedIn(blocked=False, reason="復原 AiPM 的變更"), request)
    else:
        old = undo.get("old")
        if a == "set_dates":
            old = old or {}
            fields = {"start_at": old.get("start") or "", "due_at": old.get("due") or ""}
        else:
            fields = {"set_status": {"status": old}, "set_priority": {"priority": old},
                      "set_assignee": ({"assignee": old or ""} if sub else {"assignees": [old] if old else []})}[a]
        if sub:
            await T.update_subtask(card, sub, T.SubtaskIn(**fields), request)
        else:
            await T.update_task(card, T.TaskUpdate(**fields), request)


def _err(e) -> str:
    if isinstance(e, HTTPException):
        return str(e.detail)
    return str(e) or type(e).__name__


# ---------------------------------------------------------------- one review
async def _rows(db, sql, args=()):
    cur = await db.execute(sql, args)
    return [dict(r) for r in await cur.fetchall()]


async def open_items(db, card_id: int) -> List[Dict]:
    return await _rows(db, "SELECT * FROM aipm_items WHERE card_id = ? AND status = 'pending' ORDER BY id", (card_id,))


async def load_images(db, task_id: int, ids: List[int], user: dict) -> List[Dict]:
    """The engineer's own screenshots on that card (images only) as base64 for a service that may see them."""
    from . import images as img
    if not ids:
        return []
    rows = await _rows(db, f"""SELECT * FROM task_images WHERE id IN ({','.join('?' * len(ids[:MAX_IMAGES]))}) AND task_id = ?
                                AND kind = 'image' AND (user_id IS ? OR pending = 0)""", (*ids[:MAX_IMAGES], task_id, user.get("id")))
    out = []
    for r in rows:
        p = img.path(r["stored"])
        if p and p.exists() and p.stat().st_size <= MAX_IMAGE_BYTES:
            out.append({"mime": r["mime"], "data": base64.b64encode(p.read_bytes()).decode()})
    return out


async def review(card_id: int, request, source: str = "chat", message: Optional[Dict] = None,
                 images: Optional[List[Dict]] = None) -> Dict:
    """Run AiPM once on the project (or card) card_id belongs to. message: {text, code, images: n, user_id}."""
    if not enabled():
        raise ValueError("AiPM 尚未啟用（後台 AI 接入點）")
    user = request.state.user
    snap = await snapshot(request, card_id)
    root = snap["root"]["id"]
    db = await get_db()
    try:
        pending = await open_items(db, root)
        history = await _rows(db, "SELECT role, text, at FROM aipm_messages WHERE card_id = ? ORDER BY id DESC LIMIT 8", (root,))
        recent = await _rows(db, "SELECT kind, title FROM aipm_items WHERE card_id = ? ORDER BY id DESC LIMIT 150", (root,))
        history.reverse()
        if message:
            cur = await db.execute("""INSERT INTO aipm_messages (card_id, role, user_id, text, images, source, cards)
                                      VALUES (?, 'user', ?, ?, ?, ?, ?)""",
                                   (root, user.get("id"), message.get("text") or "", json.dumps(message.get("image_ids") or []), source,
                                    json.dumps(sorted({root, message.get("card") or root}))))
            await db.commit()
    finally:
        await db.close()
    prompt = build_prompt(snap, pending, history, message, source)
    loop = asyncio.get_running_loop()
    res = await loop.run_in_executor(None, lambda: ai.ask(prompt, SYSTEM_PROMPT, "fallback", None, f"aipm_{source}", user.get("id"),
                                                          images=images or None))
    ans = res["answer"]
    if not ans:
        errs = "；".join(f"{r['name']}：{r['error']}" for r in res["results"] if r.get("error"))
        raise ValueError(f"AI 沒有回覆：{errs[:300]}")
    try:
        plan = normalize(A.parse_json(ans["text"]), snap)
    except ValueError:                                           # not JSON: keep the text as the reply
        plan = {"reply": ans["text"][:4000], "understanding": "", "forecast": [], "questions": [], "proposals": [],
                "tracking": [], "resolve": []}
    plan["model"] = f"{ans['name']} · {ans['model']}"
    plan["images_seen"] = res.get("images_seen", False)
    notes = {"pending": 0, "questions": 0}
    same = lambda t: " ".join(str(t or "").split()).lower()
    seen = {(x["kind"], same(x["title"])) for x in recent}          # not again what is open, answered or dismissed
    plan["questions"] = [q for q in plan["questions"] if ("question", same(q["q"])) not in seen]
    plan["tracking"] = [t for t in plan["tracking"] if ("tracking", same(t["title"])) not in seen]
    plan["proposals"] = [p for p in plan["proposals"] if ("proposal", same(p["title"])) not in seen]
    db = await get_db()
    try:
        cur = await db.execute("""INSERT INTO aipm_messages (card_id, role, user_id, text, payload, source, cards)
                                  VALUES (?, 'aipm', NULL, ?, ?, ?, ?)""",
                               (root, plan["reply"], json.dumps({k: plan[k] for k in ("understanding", "forecast", "model", "images_seen")},
                                                                ensure_ascii=False), source, json.dumps(sorted({it["card"] for it in snap["items"]}))))
        mid = cur.lastrowid
        if plan["resolve"]:
            await db.execute(f"""UPDATE aipm_items SET status = 'resolved', done_at = CURRENT_TIMESTAMP WHERE card_id = ? AND kind = 'tracking'
                                 AND status = 'pending' AND id IN ({','.join('?' * len(plan['resolve']))})""", (root, *plan["resolve"]))
        q_ids = []
        for q in plan["questions"]:
            it = next((x for x in snap["items"] if x["code"] == q["code"]), None) if q["code"] else None
            cur = await db.execute("""INSERT INTO aipm_items (card_id, message_id, kind, title, detail, code, target_card, target_sub, options,
                                      assignee_id, source) VALUES (?, ?, 'question', ?, ?, ?, ?, ?, ?, ?, ?)""",
                                   (root, mid, q["q"], q["why"], q["code"], it["card"] if it else root,
                                    it["id"] if it and it["kind"] == "sub" else None, json.dumps(q["options"], ensure_ascii=False),
                                    q["assignee_id"], source))
            q_ids.append((cur.lastrowid, q))
        for t in plan["tracking"]:
            await db.execute("""INSERT INTO aipm_items (card_id, message_id, kind, title, detail, code, target_card, target_sub, due, source)
                                VALUES (?, ?, 'tracking', ?, ?, ?, ?, ?, ?, ?)""",
                             (root, mid, t["title"], t["detail"], t["code"], t["card"], t["sub"], t["due"], source))
        prop_ids = []
        for p in plan["proposals"]:
            cur = await db.execute("""INSERT INTO aipm_items (card_id, message_id, kind, risk, title, detail, code, target_card, target_sub,
                                      action, source) VALUES (?, ?, 'proposal', ?, ?, ?, ?, ?, ?, ?, ?)""",
                                   (root, mid, p["risk"], p["title"], p["detail"], p["code"], p["action"]["card"], p["action"].get("sub"),
                                    json.dumps(p["action"], ensure_ascii=False), source))
            prop_ids.append((cur.lastrowid, p))
        await db.commit()
    finally:
        await db.close()
    # hard rule: nothing is applied here — every change waits for the project's lead or a board administrator
    notes["pending"] = len(prop_ids)
    notes["questions"] = len(q_ids)
    await _tell(root, snap, q_ids, notes, source, user)
    db = await get_db()
    try:
        cur = await db.execute("SELECT MAX(updated_at) FROM tasks WHERE id = ? OR project_id = ?", (root, root))
        seen = (await cur.fetchone())[0]
        await db.execute("""INSERT INTO aipm_runs (card_id, last_at, seen_update) VALUES (?, ?, ?)
                            ON CONFLICT(card_id) DO UPDATE SET last_at = excluded.last_at, seen_update = excluded.seen_update, last_error = NULL""",
                         (root, datetime.now().strftime("%Y-%m-%d %H:%M:%S"), seen))
        await db.commit()
    finally:
        await db.close()
    return {"root": root, "message_id": mid, **notes}


async def _set(item_id: int, **kw):
    db = await get_db()
    try:
        if kw.get("status") in ("applied", "auto", "dismissed", "undone", "resolved", "answered"):
            kw["done_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        await db.execute(f"UPDATE aipm_items SET {', '.join(k + ' = ?' for k in kw)} WHERE id = ?", (*kw.values(), item_id))
        await db.commit()
    finally:
        await db.close()


# ---------------------------------------------------------------- who may approve, who may be told
async def _user(db, uid: int) -> Optional[dict]:
    from .auth import full_user
    cur = await db.execute("SELECT * FROM users WHERE id = ? AND active = 1", (uid,))
    r = await cur.fetchone()
    return await full_user(db, r) if r else None


async def sees(db, uid: Optional[int], card_ids) -> bool:
    """Whether this account can already see every one of these cards (the board's own visibility rules)."""
    from .routes.tasks import _visible_sql
    if not uid:
        return False
    u = await _user(db, uid)
    if not u or u.get("role") == "guest":
        return False
    ids = sorted({int(c) for c in card_ids if c})
    if not ids:
        return True
    where, args = _visible_sql(u)
    cur = await db.execute(f"SELECT COUNT(*) FROM tasks t WHERE t.id IN ({','.join('?' * len(ids))}) AND {where}", (*ids, *args))
    return (await cur.fetchone())[0] == len(ids)


async def _root_people(db, root: int):
    """The project card's lead (owner) and the departments it belongs to (lead's and assignees')."""
    cur = await db.execute("SELECT owner_id FROM tasks WHERE id = ?", (root,))
    r = await cur.fetchone()
    owner = r["owner_id"] if r else None
    cur = await db.execute("""SELECT DISTINCT u.department FROM users u WHERE u.department IS NOT NULL AND u.department != ''
                              AND (u.id IS ? OR u.id IN (SELECT user_id FROM task_members WHERE task_id = ? AND role = 'assignee'))""",
                           (owner, root))
    return owner, {x["department"] for x in await cur.fetchall()}


def _admin_over(u: dict, depts) -> bool:
    from .roles import board_access
    acc = board_access(u)
    return acc["edit"] == "all" or (acc["edit"] == "dept" and bool(set(acc["depts"]) & set(depts)))


async def can_approve(db, root: int, user: dict) -> bool:
    """HARD RULE: only the project's lead or a board administrator with edit rights over it (看板總管理者 RW,
    or a 部門看板管理者 RW of its departments) may let AiPM change anything. AiPM itself never may."""
    from . import config as C
    if user is SYSTEM or user.get("role") == "guest":                 # AiPM itself never approves
        return False
    uid = user.get("id")
    if uid is None:                     # a standalone copy not linked to a server: its one person leads everything
        return not C.AUTH
    owner, depts = await _root_people(db, root)
    if uid == owner:
        return True
    return _admin_over(user, depts)


async def approvers(db, root: int) -> List[dict]:
    """Who is told about changes waiting: the lead; else the department board administrators; else the board
    administrators. Only accounts that can see the project card."""
    owner, depts = await _root_people(db, root)
    out = []
    if owner and await sees(db, owner, [root]):
        out = [owner]
    if not out:
        rows = await _rows(db, "SELECT id FROM users WHERE active = 1 AND role = 'dept_admin'")
        for r in rows:
            u = await _user(db, r["id"])
            if u and _admin_over(u, depts) and await sees(db, r["id"], [root]):
                out.append(r["id"])
    if not out:
        rows = await _rows(db, "SELECT id FROM users WHERE active = 1 AND role IN ('board_admin', 'superadmin')")
        out = [r["id"] for r in rows if await sees(db, r["id"], [root])]
    names = {}
    if out:
        rows = await _rows(db, f"SELECT id, username, display_name FROM users WHERE id IN ({','.join('?' * len(out))})", out)
        names = {r["id"]: r["display_name"] or r["username"] for r in rows}
    return [{"id": i, "name": names.get(i, "")} for i in out]


async def _tell(root: int, snap: Dict, q_ids, notes, source, user):
    """Targeted, no exceptions: a question goes only to the person asked, a summary of changes waiting only to the
    project's approvers — and each only if that account can already see the project card and the item's card."""
    from .routes.tasks import notify
    title = snap["root"]["title"]
    actor = SYSTEM if source in ("patrol", "event") else user
    db = await get_db()
    try:
        for _, q in q_ids:
            it = next((x for x in snap["items"] if x["code"] == q["code"]), None) if q["code"] else None
            if q["assignee_id"] and await sees(db, q["assignee_id"], [root, it["card"] if it else root]):
                await notify(db, {q["assignee_id"]}, root, actor, "aipm", f"AiPM 想確認「{title}」：{q['q']}")
        if notes["pending"]:
            to = {a["id"] for a in await approvers(db, root)}
            # a background review covers every card of the project: only approvers who can see all of them
            if source in ("patrol", "event"):
                to = {u for u in to if await sees(db, u, {it["card"] for it in snap["items"]})}
            await notify(db, to, root, actor, "aipm", f"AiPM「{title}」：{notes['pending']} 項變更等你核准")
        await db.commit()
    finally:
        await db.close()


# ---------------------------------------------------------------- the background review
_running = None


def start_tick():
    """Run tick() in the background (a review can take a minute per project); one at a time."""
    global _running
    if _running and not _running.done():
        return
    async def safe():
        try:
            await tick()
        except Exception:  # noqa: BLE001
            log.exception("aipm tick")
    _running = asyncio.get_running_loop().create_task(safe())


async def tick():
    """Called every 10 minutes by the scheduler: closures to align, the daily personal check-in and 巡檢 at the
    巡檢 time, reviews after changes."""
    if not enabled():
        return
    from . import aipm_my
    now = datetime.now()
    s = ai.settings()
    hh, mm = (s.get("aipm_patrol") or "08:30").split(":")
    patrol_due = now.hour * 60 + now.minute >= int(hh) * 60 + int(mm)
    try:
        await aipm_my.closures()
        if patrol_due:
            await aipm_my.daily()
    except Exception:  # noqa: BLE001
        log.exception("aipm personal")
    if not ai.usable():
        return
    today = now.date().isoformat()
    db = await get_db()
    try:
        projects = await _rows(db, """SELECT t.id, t.title, r.last_at, r.seen_update, r.patrol_day,
                                             (SELECT MAX(x.updated_at) FROM tasks x WHERE x.id = t.id OR x.project_id = t.id) AS changed
                                      FROM tasks t LEFT JOIN aipm_runs r ON r.card_id = t.id
                                      WHERE t.kind = 'project' AND t.status NOT IN ('complete', 'canceled', 'onhold')""")
    finally:
        await db.close()
    for p in projects:
        source = None
        if patrol_due and p["patrol_day"] != today:
            source = "patrol"
        elif p["changed"] and p["changed"] != p["seen_update"] and p["seen_update"] is not None:
            last = _ts(p["last_at"])
            changed = _ts(p["changed"], utc=True)
            if (not last or now - last >= timedelta(minutes=EVENT_GAP_MIN)) and changed and now - changed >= timedelta(minutes=EVENT_SETTLE_MIN):
                source = "event"
        elif p["seen_update"] is None and p["patrol_day"] is None:
            # first time this project is seen: remember where it is (no review until it changes or the next patrol)
            await _mark(p["id"], seen=p["changed"])
            continue
        if not source:
            continue
        try:
            await review(p["id"], sys_request(), source)
        except Exception as e:  # noqa: BLE001
            log.warning("AiPM %s %s: %s", source, p["id"], e)
            await _mark(p["id"], error=str(e)[:300], seen=p["changed"])
        if source == "patrol":
            await _mark(p["id"], patrol=today)


def _ts(v, utc: bool = False) -> Optional[datetime]:
    if not v:
        return None
    try:
        d = datetime.fromisoformat(str(v)[:19].replace("T", " "))
    except ValueError:
        return None
    if utc:                                             # tasks.updated_at is CURRENT_TIMESTAMP (UTC)
        from datetime import timezone
        d = d.replace(tzinfo=timezone.utc).astimezone().replace(tzinfo=None)
    return d


async def _mark(card_id: int, error: Optional[str] = None, seen: Optional[str] = None, patrol: Optional[str] = None):
    db = await get_db()
    try:
        await db.execute("INSERT OR IGNORE INTO aipm_runs (card_id) VALUES (?)", (card_id,))
        if error is not None:
            await db.execute("UPDATE aipm_runs SET last_error = ?, last_at = ? WHERE card_id = ?",
                             (error, datetime.now().strftime("%Y-%m-%d %H:%M:%S"), card_id))
        if seen is not None:
            await db.execute("UPDATE aipm_runs SET seen_update = ? WHERE card_id = ?", (seen, card_id))
        if patrol is not None:
            await db.execute("UPDATE aipm_runs SET patrol_day = ? WHERE card_id = ?", (patrol, card_id))
        await db.commit()
    finally:
        await db.close()
