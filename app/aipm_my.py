"""
我的 AiPM: each person's work secretary and project manager, for every department.

The main way to work with the system: people talk to AiPM instead of filling in boards. Everything here stays
within what the person can already see, and the hard rules of app/aipm.py hold:

  chat       say what happened (with screenshots), across all one's work. AiPM works out which item each part
             belongs to and offers 「記錄」 entries — one click by the person who said it records them as that
             person's own comments on those items (screenshots attached). Changes it suggests (dates, new work …)
             go to the project's AiPM panel and wait for the project's lead or a board administrator.
  daily      at the 巡檢 time, a personal check-in for each person with open items of their own: what is overdue,
             due today, blocked or quiet; answering it is an ordinary chat (no AI call is spent on the check-in).
  meeting    paste the notes of a meeting (no recording): minutes with attendees, points, decisions, action
             items (→ suggested new work, approved as usual), open questions, and records per item.
  recall     every chat also gets the meeting minutes, comments and own notes that match its words (only from
             cards the person can see), so AiPM can answer 「上週跟廠商開會決定了什麼？」 with sources.
  closure    when a leaf item is completed, the person responsible is asked to align the closure with AiPM
             (checklist + a 結案摘要 kept as a comment). Not aligned = flagged, never blocked.
"""
import asyncio
import json
import re
from datetime import date, datetime
from typing import Dict, List, Optional

from fastapi import HTTPException

from . import ai, aipm, sysconfig
from . import ai_assist as A
from .database import get_db

CONF_KEY = "_aipm_my"
MAX_UPLOADS = 6
CLOSED = A.CLOSED


# ---------------------------------------------------------------- storage
async def ensure(db):
    await db.execute("""CREATE TABLE IF NOT EXISTS aipm_personal (
                            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, role TEXT NOT NULL,
                            kind TEXT NOT NULL DEFAULT 'chat', text TEXT, payload TEXT, uploads TEXT,
                            at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime')))""")
    await db.execute("CREATE INDEX IF NOT EXISTS idx_aipm_personal ON aipm_personal(user_id, id)")
    await db.execute("""CREATE TABLE IF NOT EXISTS aipm_uploads (
                            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, stored TEXT NOT NULL, mime TEXT, name TEXT,
                            size INTEGER, at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)""")
    await db.execute("""CREATE TABLE IF NOT EXISTS aipm_meetings (
                            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, title TEXT, held_on TEXT, raw TEXT,
                            minutes TEXT, cards TEXT,
                            at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime')))""")
    await db.execute("""CREATE TABLE IF NOT EXISTS aipm_closures (
                            id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL, sub_id INTEGER, title TEXT,
                            closed_at TEXT, user_id INTEGER, aligned INTEGER NOT NULL DEFAULT 0, summary TEXT,
                            aligned_by INTEGER, aligned_at TEXT, UNIQUE(card_id, sub_id))""")


async def _rows(db, sql, args=()):
    cur = await db.execute(sql, args)
    return [dict(r) for r in await cur.fetchall()]


def _ref(it) -> str:
    return f"#s{it['id']}" if it["kind"] == "sub" else f"#c{it['id']}"


# ---------------------------------------------------------------- what the person works on
async def context(request, project_id: Optional[int] = None) -> Dict:
    """My items (every level of the cards I am on) with refs #c<id> / #s<id>, plus the other cards I can see
    (top level only), as a snapshot app/aipm.normalize understands."""
    from .routes.tasks import list_tasks
    mine = await A.collect(request, "mine")
    items = []
    for it in mine["items"]:
        it = dict(it)
        it["wbs"], it["code"] = it["code"], _ref(it)
        items.append(it)
    if project_id:
        try:
            proj = await A.collect(request, "project", project_id)
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))
        have = {x["code"] for x in items}
        for it in proj["items"]:
            it = dict(it)
            it["wbs"], it["code"] = it["code"], _ref(it)
            if it["code"] not in have:
                items.append(it)
    have = {x["card"] for x in items}
    names = {}
    cards = await list_tasks(request)
    for c in cards:
        if c.get("kind") == "project":
            names[c["id"]] = c["title"]
    others = [c for c in cards if c["id"] not in have and c["status"] not in CLOSED][:150]
    for c in others:
        p = (c.get("assignees") or [None])[0] or c.get("owner") or {}
        items.append({"code": f"#c{c['id']}", "wbs": "", "level": 1, "kind": "card", "id": c["id"], "card": c["id"], "title": c["title"],
                      "status": c["status"], "who": p.get("name") or p.get("username") or "", "start": A._d(c.get("start_at")),
                      "due": A._d(c.get("due_at")), "done_at": None, "priority": c.get("priority") or "normal",
                      "blocked": (c.get("blocked") or {}).get("reason", "") if c.get("blocked") else "", "est": 0, "spent": 0,
                      "milestone": c.get("milestone"), "project": names.get(c.get("project_id")) or (c["title"] if c.get("kind") == "project" else ""),
                      "is_project": c.get("kind") == "project", "notes": [], "mine": False, "uid": p.get("id"),
                      "username": p.get("username") or "", "desc": "", "parent": None, "other": True})
    people, seen = [], set()
    for it in items:
        if it.get("uid") and it["uid"] not in seen:
            seen.add(it["uid"])
            people.append({"id": it["uid"], "username": it.get("username") or "", "display_name": it.get("who") or ""})
    return {"items": items, "people": people, "root": {"id": None, "title": "", "kind": "card"}, "today": date.today(), "signals": []}


def _lines(snap) -> str:
    today = snap["today"]
    out = []
    for it in snap["items"][:A.MAX_LINES]:
        late = it["due"] and it["status"] not in CLOSED and it["due"] < today
        bits = [f"[{it['code']}]", ("　" * (it["level"] - 1)) + it["title"], A.ZH.get(it["status"], it["status"])]
        if it.get("project") and it["level"] == 1:
            bits.append(f"專案：{it['project']}")
        if it.get("who"):
            bits.append(f"負責 {it['who']}")
        if it["due"]:
            bits.append(f"到期 {A._md(it['due'])}" + ("（逾期）" if late else ""))
        if it.get("blocked"):
            bits.append(f"卡住：{it['blocked']}")
        if it.get("mine"):
            bits.append("我的")
        out.append("｜".join(bits))
    if len(snap["items"]) > A.MAX_LINES:
        out.append(f"…（另有 {len(snap['items']) - A.MAX_LINES} 項）")
    return "\n".join(out)


# ---------------------------------------------------------------- recall: what was said before
_STOP = set("什麼 上週 我們 一下 這個 那個 可以 今天 昨天 時候 有沒 沒有 哪些 如何 怎麼 是否 目前 一個 還有 的是 了嗎 是不 不是 現在 知道 告訴 幫我 請問 之前".split())


def _tokens(text: str) -> set:
    t = (text or "").lower()
    out = {w for w in re.findall(r"[a-z0-9][a-z0-9._-]+", t) if len(w) >= 2}
    for run in re.findall(r"[一-鿿]+", t):
        out |= {run[i:i + 2] for i in range(len(run) - 1)}
    return out - _STOP


async def visible_cards(request) -> set:
    from .routes.tasks import list_tasks
    now = await list_tasks(request)
    old = await list_tasks(request, history=1)
    return {c["id"] for c in now} | {c["id"] for c in old}


async def meeting_visible(m: dict, user: dict, visible: set) -> bool:
    if m.get("user_id") == user.get("id"):
        return True
    cards = set(json.loads(m.get("cards") or "[]"))
    return bool(cards) and cards <= visible


async def recall(request, text: str, limit: int = 20) -> List[str]:
    """Earlier meeting minutes, comments and own notes that match the words of `text` (only what the person can see)."""
    toks = _tokens(text)
    if not toks:
        return []
    user = request.state.user
    visible = await visible_cards(request)
    need = 1 if len(toks) <= 3 else 2
    scored = []
    db = await get_db()
    try:
        for m in await _rows(db, "SELECT * FROM aipm_meetings WHERE at >= datetime('now', '-365 days') ORDER BY id DESC LIMIT 300"):
            if not await meeting_visible(m, user, visible):
                continue
            mn = json.loads(m["minutes"] or "{}")
            body = " ".join([mn.get("summary", ""), *[d.get("text", "") for d in mn.get("decisions", [])],
                             *[a.get("title", "") for a in mn.get("actions", [])]])
            hit = len(toks & _tokens(m["title"] + " " + body))
            if hit >= need:
                scored.append((hit + 1, f"[M{m['id']}] 會議「{m['title']}」{m['held_on'] or m['at'][:10]}：{body[:300]}"))
        if visible:
            ids = sorted(visible)
            for c in await _rows(db, f"""SELECT c.id, c.task_id, c.body, c.created_at, t.title FROM task_comments c JOIN tasks t ON t.id = c.task_id
                                         WHERE c.is_task = 0 AND c.task_id IN ({','.join('?' * len(ids))})
                                         AND c.created_at >= datetime('now', '-365 days') AND length(c.body) > 4
                                         ORDER BY c.id DESC LIMIT 4000""", ids):
                hit = len(toks & _tokens(c["body"] + " " + c["title"]))
                if hit >= need:
                    scored.append((hit, f"[C{c['id']}] 卡片「{c['title']}」的留言 {str(c['created_at'])[:10]}：{c['body'][:240]}"))
        for p in await _rows(db, "SELECT id, text, at FROM aipm_personal WHERE user_id IS ? AND role = 'user' ORDER BY id DESC LIMIT 500",
                             (user.get("id"),)):
            hit = len(toks & _tokens(p["text"]))
            if hit >= need:
                scored.append((hit, f"[P{p['id']}] 我在 {p['at'][:10]} 說：{(p['text'] or '')[:240]}"))
    finally:
        await db.close()
    scored.sort(key=lambda x: -x[0])
    return [s for _, s in scored[:limit]]


# ---------------------------------------------------------------- the prompts
MY_SYSTEM = """你是 AiPM：這位同事的工作秘書兼專案經理。公司各部門都在用你——行政、管理、PM、基礎架構（Infra）、研發（RD）、採購、人資、財務、業務等；依每件事的領域用相應的專業判斷。
同事很忙：他跟你說話、貼截圖、開完會貼筆記，你負責記錄、整理、追蹤與回想，讓他不用自己記筆記、不用回憶會議內容。
你主動、比他多想一步：預判風險與連鎖影響，提醒該補的工作、完成條件、該留的紀錄與要協調的人。
你提出的變更（日期、狀態、負責人、新增工作…）都要專案負責人或看板管理人核准才會生效；已完成或取消的項目不能變更。
只根據提供的資料；回想過去時一定附上來源編號（例如 [M3]、[C120]、[P8]），找不到就說找不到，不能編造。用繁體中文，精簡、口語但專業。"""

MY_SCHEMA = """請只輸出一個 JSON 物件（不要 Markdown 圍欄、不要其他文字）：
{
 "reply": "回覆他（Markdown，3–10 行）：先回應他說的，回想問題要附來源編號；需要時追問（最多 3 個具體問題）",
 "records": [{"ref": "項目代號（#c12 或 #s34）", "note": "要記到這個項目的紀錄：用他的角度整理成清楚、完整的一段話（做了什麼、結果、下一步）"}],
 "proposals": [{"action": "append_note|add_subtask|set_dates|set_status|set_assignee|set_priority|set_blocked", "code": "項目代號",
                "title": "", "text": "", "start": "YYYY-MM-DD", "due": "YYYY-MM-DD", "status": "", "assignee": "帳號", "priority": "", "reason": "為什麼"}],
 "tracking": [{"code": "項目代號", "title": "要追蹤的事", "detail": "", "due": "YYYY-MM-DD 或空"}]
}
規則：
- 一段話可能包含好幾件事，分別記到對應的項目；看不出屬於哪個項目就不要記，改在 reply 問他。
- 只用清單裡的項目代號；已完成或取消的項目不能提出變更（records 可以記）。
- 單純問問題或回想時，records 與 proposals 給空陣列。
- proposals 最多 5 項、tracking 最多 5 項。"""

MEETING_SCHEMA = """請把下面的會議內容整理成會議紀錄，只輸出一個 JSON 物件（不要 Markdown 圍欄、不要其他文字）：
{
 "title": "會議名稱",
 "summary": "3–6 句摘要",
 "attendees": ["出席者"],
 "points": ["討論重點"],
 "decisions": [{"text": "決議", "ref": "相關項目代號或空"}],
 "actions": [{"title": "待辦", "owner": "負責人帳號或姓名（不確定就空）", "due": "YYYY-MM-DD 或空", "ref": "要放在哪個項目底下（項目代號，不確定就空）", "text": "做法或說明"}],
 "open_questions": ["還沒決定、要追的問題"],
 "records": [{"ref": "項目代號", "note": "要記到這個項目的會議紀錄（這個項目相關的討論與決議）"}],
 "tracking": [{"code": "項目代號", "title": "要追蹤的事", "detail": "", "due": "YYYY-MM-DD 或空"}]
}
規則：只用清單裡的項目代號；不能編造會議中沒有的內容；看不出負責人或日期就留空。"""


def _ask(prompt: str, system: str, user: dict, purpose: str, images=None) -> str:
    res = ai.ask(prompt, system, "fallback", None, purpose, user.get("id"), images=images or None)
    ans = res["answer"]
    if not ans:
        errs = "；".join(f"{r['name']}：{r['error']}" for r in res["results"] if r.get("error"))
        raise ValueError(f"AI 沒有回覆：{errs[:300]}")
    return ans["text"], f"{ans['name']} · {ans['model']}", res.get("images_seen", False)


def _records(raw_records, snap) -> List[dict]:
    codes = {it["code"]: it for it in snap["items"]}
    out = []
    for r in (raw_records or [])[:12]:
        if not isinstance(r, dict):
            continue
        ref = str(r.get("ref") or "").strip()
        note = str(r.get("note") or "").strip()
        if ref in codes and note:
            it = codes[ref]
            out.append({"ref": ref, "card": it["card"], "sub": it["id"] if it["kind"] == "sub" else None, "title": it["title"],
                        "wbs": it.get("wbs") or "", "project": it.get("project") or "", "note": note[:3000], "done": False})
    return out


async def _file(plan: Dict, snap: Dict, request, source: str) -> List[dict]:
    """Suggested changes and follow-ups go to each project's AiPM panel (approval rules there); approvers are told."""
    from .routes.tasks import notify
    user = request.state.user
    codes = {it["code"]: it for it in snap["items"]}
    name = lambda ref: f"「{codes[ref]['title']}」" if ref in codes else ""
    sent = []
    db = await get_db()
    try:
        roots = {}
        for p in plan.get("proposals", []):
            root = (await aipm._root(db, p["action"]["card"]))["id"]
            title = p["title"].replace(p["code"], name(p["code"])).strip()      # refs (#s12) mean nothing to people
            p["action"]["code"] = codes.get(p["code"], {}).get("title", "")[:60]
            cur = await db.execute("""INSERT INTO aipm_items (card_id, kind, risk, title, detail, code, target_card, target_sub, action, source)
                                      VALUES (?, 'proposal', ?, ?, ?, NULL, ?, ?, ?, ?)""",
                                   (root, p["risk"], title[:200], p["detail"], p["action"]["card"], p["action"].get("sub"),
                                    json.dumps(p["action"], ensure_ascii=False), source))
            roots.setdefault(root, 0)
            roots[root] += 1
            sent.append({"id": cur.lastrowid, "root": root, "title": title})
        for t in plan.get("tracking", []):
            if not t.get("code"):
                continue
            root = (await aipm._root(db, t["card"]))["id"]
            await db.execute("""INSERT INTO aipm_items (card_id, kind, title, detail, code, target_card, target_sub, due, source)
                                VALUES (?, 'tracking', ?, ?, NULL, ?, ?, ?, ?)""",
                             (root, f"{name(t['code'])} {t['title']}".strip()[:200], t["detail"], t["card"], t["sub"], t["due"], source))
        for root, n in roots.items():
            cur = await db.execute("SELECT title FROM tasks WHERE id = ?", (root,))
            r = await cur.fetchone()
            to = {a["id"] for a in await aipm.approvers(db, root)}
            await notify(db, to, root, user, "aipm", f"AiPM「{r['title'] if r else ''}」：{n} 項變更等你核准")
            for s in sent:
                if s["root"] == root:
                    s["approvers"] = [a["name"] for a in await aipm.approvers(db, root)]
        await db.commit()
    finally:
        await db.close()
    return sent


# ---------------------------------------------------------------- uploads (screenshots before they belong anywhere)
async def save_uploads(files, user: dict) -> List[int]:
    from . import images as img
    ids = []
    db = await get_db()
    try:
        for f in files[:MAX_UPLOADS]:
            data = await f.read(img.MAX_BYTES + 1)
            try:
                stored, mime, kind = img.store(data, f.filename or "screenshot.png")
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
            if kind != "image":
                img.remove([stored])
                raise HTTPException(status_code=400, detail="只能附加截圖（圖片）")
            cur = await db.execute("INSERT INTO aipm_uploads (user_id, stored, mime, name, size) VALUES (?, ?, ?, ?, ?)",
                                   (user.get("id"), stored, mime, (f.filename or "")[:120], len(data)))
            ids.append(cur.lastrowid)
        await db.commit()
    finally:
        await db.close()
    return ids


async def upload_images(ids: List[int], user: dict) -> List[dict]:
    """The person's uploads as base64 for a service that may see images."""
    import base64
    from . import images as img
    if not ids:
        return []
    db = await get_db()
    try:
        rows = await _rows(db, f"SELECT * FROM aipm_uploads WHERE id IN ({','.join('?' * len(ids))}) AND user_id IS ?", (*ids, user.get("id")))
    finally:
        await db.close()
    out = []
    for r in rows:
        p = img.path(r["stored"])
        if p and p.exists() and p.stat().st_size <= aipm.MAX_IMAGE_BYTES:
            out.append({"mime": r["mime"], "data": base64.b64encode(p.read_bytes()).decode()})
    return out


async def record(entries: List[dict], upload_ids: List[int], request) -> List[dict]:
    """Record the chosen entries as the person's own comments on those items (screenshots copied to each)."""
    from . import images as img
    from .routes.tasks import CommentIn, _comment, _get_visible, add_comment, is_history
    user = request.state.user
    done = []
    db = await get_db()
    try:
        ups = await _rows(db, f"SELECT * FROM aipm_uploads WHERE id IN ({','.join('?' * len(upload_ids)) or 'NULL'}) AND user_id IS ?",
                          (*upload_ids, user.get("id"))) if upload_ids else []
    finally:
        await db.close()
    for e in entries:
        db = await get_db()
        try:
            await _get_visible(db, e["card"], user)
            if await is_history(db, e["card"]):
                raise HTTPException(status_code=403, detail="歷史區的卡片不能再加紀錄")
            if e.get("sub"):
                c = await _comment(db, e["card"], e["sub"])
                if not c["is_task"]:
                    raise HTTPException(status_code=400, detail="只能記到子任務")
            pics = []
            for u in ups[:10]:
                name = img.copy(u["stored"])
                if name:
                    cur = await db.execute("""INSERT INTO task_images (task_id, user_id, stored, mime, name, size, pending, kind)
                                              VALUES (?, ?, ?, ?, ?, ?, 1, 'image')""",
                                           (e["card"], user.get("id"), name, u["mime"], u["name"], u["size"]))
                    pics.append(cur.lastrowid)
            await db.commit()
        finally:
            await db.close()
        r = await add_comment(e["card"], CommentIn(body=e["note"][:4000], images=pics, parent_id=e.get("sub")), request)
        done.append({**e, "done": True, "comment_id": r["id"]})
    return done


# ---------------------------------------------------------------- chat
async def chat(request, text: str, upload_ids: List[int]) -> Dict:
    if not aipm.enabled():
        raise ValueError("AiPM 尚未啟用（後台 AI 接入點）")
    user = request.state.user
    snap = await context(request)
    hits = await recall(request, text)
    pics = await upload_images(upload_ids, user)
    db = await get_db()
    try:
        hist = await _rows(db, "SELECT role, kind, text, at FROM aipm_personal WHERE user_id IS ? ORDER BY id DESC LIMIT 10", (user.get("id"),))
        hist.reverse()
        cur = await db.execute("INSERT INTO aipm_personal (user_id, role, kind, text, uploads) VALUES (?, 'user', 'chat', ?, ?)",
                               (user.get("id"), text, json.dumps(upload_ids)))
        await db.commit()
    finally:
        await db.close()
    today = snap["today"]
    convo = "\n".join(f"{'我' if h['role'] == 'user' else 'AiPM'}（{h['at'][5:16]}）：{(h['text'] or '')[:400]}" for h in hist) or "（無）"
    prompt = (f"今天 {today.isoformat()}（週{'一二三四五六日'[today.weekday()]}）。同事：{user.get('display_name') or user.get('username')}"
              f"（帳號 {user.get('username')}）\n\n## 他的工作與看得到的卡片（[代號]｜名稱｜狀態｜…）\n{_lines(snap)}"
              f"\n\n## 可能相關的過去紀錄（回想時引用來源編號）\n" + ("\n".join(hits) or "（沒有找到）")
              + f"\n\n## 最近的對話\n{convo}\n\n## 他剛剛說\n{text or '（沒有文字）'}"
              + (f"\n（附了 {len(pics)} 張截圖；看得到的話先說你從圖中看到的重點）" if pics else "") + f"\n\n{MY_SCHEMA}")
    loop = asyncio.get_running_loop()
    out, model, seen = await loop.run_in_executor(None, _ask, prompt, MY_SYSTEM, user, "aipm_my", pics)
    try:
        raw = A.parse_json(out)
    except ValueError:
        raw = {"reply": out}
    plan = aipm.normalize({**raw, "questions": [], "forecast": []}, snap)
    plan["tracking"] = [t for t in plan["tracking"] if t.get("code")]
    records = _records(raw.get("records"), snap)
    sent = await _file(plan, snap, request, "personal")
    payload = {"records": records, "sent": sent, "model": model, "images_seen": seen, "uploads": upload_ids,
               "tracking": [t["title"] for t in plan["tracking"]]}
    db = await get_db()
    try:
        cur = await db.execute("INSERT INTO aipm_personal (user_id, role, kind, text, payload) VALUES (?, 'aipm', 'chat', ?, ?)",
                               (user.get("id"), plan["reply"] or "（AiPM 沒有回覆文字）", json.dumps(payload, ensure_ascii=False)))
        await db.commit()
        return {"id": cur.lastrowid}
    finally:
        await db.close()


# ---------------------------------------------------------------- meetings
async def meeting(request, title: str, held_on: Optional[str], text: str, project_id: Optional[int]) -> Dict:
    if not aipm.enabled():
        raise ValueError("AiPM 尚未啟用（後台 AI 接入點）")
    user = request.state.user
    snap = await context(request, project_id)
    hits = await recall(request, title + " " + text[:2000], 10)
    prompt = (f"今天 {snap['today'].isoformat()}。整理會議的人：{user.get('display_name') or user.get('username')}"
              f"\n會議：{title or '（未命名）'}｜日期 {held_on or snap['today'].isoformat()}"
              f"\n\n## 相關的工作與卡片（[代號]｜名稱｜狀態｜…）\n{_lines(snap)}"
              f"\n\n## 可能相關的過去紀錄\n" + ("\n".join(hits) or "（無）") + f"\n\n## 會議內容\n{text[:30000]}\n\n{MEETING_SCHEMA}")
    loop = asyncio.get_running_loop()
    out, model, _ = await loop.run_in_executor(None, _ask, prompt, MY_SYSTEM, user, "aipm_meeting", None)
    raw = A.parse_json(out)
    codes = {it["code"]: it for it in snap["items"]}
    s = lambda v, n: " ".join(str(v or "").split())[:n]
    mins = {"title": s(raw.get("title") or title, 200) or "會議", "summary": str(raw.get("summary") or "").strip()[:2000],
            "attendees": [s(a, 60) for a in (raw.get("attendees") or []) if str(a).strip()][:40],
            "points": [s(p, 400) for p in (raw.get("points") or []) if str(p).strip()][:30],
            "decisions": [{"text": s(d.get("text"), 400), "ref": d.get("ref") if d.get("ref") in codes else None}
                          for d in (raw.get("decisions") or []) if isinstance(d, dict) and d.get("text")][:30],
            "open_questions": [s(q, 300) for q in (raw.get("open_questions") or []) if str(q).strip()][:20],
            "model": model}
    actions = [a for a in (raw.get("actions") or []) if isinstance(a, dict) and a.get("title")][:30]
    mins["actions"] = [{"title": s(a["title"], 200), "owner": s(a.get("owner"), 60), "due": aipm._date_or_none(a.get("due")),
                        "ref": a.get("ref") if a.get("ref") in codes else None} for a in actions]
    # action items with a place to go become suggested new work (approved by the project's lead / board admins)
    props = [{"action": "add_subtask", "code": a["ref"], "title": a["title"], "text": f"會議「{mins['title']}」待辦：{a.get('text') or a['title']}",
              "due": a.get("due"), "assignee": a.get("owner"), "reason": f"會議「{mins['title']}」的待辦"}
             for a in actions if a.get("ref") in codes and codes[a["ref"]]["status"] not in CLOSED]
    plan = aipm.normalize({"proposals": props, "tracking": raw.get("tracking") or [], "questions": [], "forecast": []}, snap)
    plan["tracking"] = [t for t in plan["tracking"] if t.get("code")]
    mins["records"] = _records(raw.get("records"), snap)
    mins["sent"] = await _file(plan, snap, request, "meeting")
    cards = {r["card"] for r in mins["records"]} | {codes[d["ref"]]["card"] for d in mins["decisions"] if d["ref"]} \
        | {codes[a["ref"]]["card"] for a in mins["actions"] if a["ref"]}
    if project_id:
        cards.add(project_id)
    db = await get_db()
    try:
        cur = await db.execute("INSERT INTO aipm_meetings (user_id, title, held_on, raw, minutes, cards) VALUES (?, ?, ?, ?, ?, ?)",
                               (user.get("id"), mins["title"], held_on or snap["today"].isoformat(), text[:60000],
                                json.dumps(mins, ensure_ascii=False), json.dumps(sorted(cards))))
        mid = cur.lastrowid
        await db.execute("INSERT INTO aipm_personal (user_id, role, kind, text, payload) VALUES (?, 'aipm', 'meeting', ?, ?)",
                         (user.get("id"), f"已整理會議紀錄「{mins['title']}」", json.dumps({"meeting": mid}, ensure_ascii=False)))
        await db.commit()
    finally:
        await db.close()
    return {"id": mid}


# ---------------------------------------------------------------- daily check-in and closures (scheduler)
def _conf() -> dict:
    return sysconfig._read(CONF_KEY)


def _save(**kw):
    sysconfig._write(CONF_KEY, {**_conf(), **kw})


async def daily(force: bool = False) -> int:
    """Once a day at the 巡檢 time: a personal check-in for everyone with open items of their own. Only to that
    person, only about their own items. No AI call."""
    from .routes.tasks import hist_sql, notify
    s = ai.settings()
    if not s.get("aipm_daily", True) and not force:
        return 0
    today = date.today().isoformat()
    if _conf().get("daily_day") == today and not force:
        return 0
    _save(daily_day=today)
    n = 0
    db = await get_db()
    try:
        users = await _rows(db, "SELECT id, display_name, username FROM users WHERE active = 1 AND role != 'guest'")
        for u in users:
            subs = await _rows(db, f"""SELECT c.id, c.task_id, c.title, c.status, c.due_at, c.started_at, t.title AS card_title, t.blocked_reason
                                       FROM task_comments c JOIN tasks t ON t.id = c.task_id
                                       WHERE c.is_task = 1 AND c.assignee_id = ? AND c.status NOT IN ('complete', 'canceled')
                                       AND t.status NOT IN ('complete', 'canceled') AND NOT {hist_sql()}
                                       AND NOT EXISTS (SELECT 1 FROM task_comments k WHERE k.task_parent_id = c.id AND k.is_task = 1)
                                       ORDER BY COALESCE(c.due_at, '9999'), c.id LIMIT 40""", (u["id"],))
            cards = await _rows(db, f"""SELECT t.id, t.title, t.status, t.due_at, t.blocked_reason FROM tasks t
                                        WHERE t.status NOT IN ('complete', 'canceled') AND t.kind != 'project' AND NOT {hist_sql()}
                                        AND t.id IN (SELECT task_id FROM task_members WHERE user_id = ? AND role = 'assignee')
                                        AND NOT EXISTS (SELECT 1 FROM task_comments k WHERE k.task_id = t.id AND k.is_task = 1)
                                        ORDER BY COALESCE(t.due_at, '9999'), t.id LIMIT 40""", (u["id"],))
            if not subs and not cards:
                continue
            d0 = date.today()
            lines, urgent = [], 0
            for x in [*({**c, "where": ""} for c in cards), *({**c, "where": c["card_title"]} for c in subs)]:
                due = A._d(x.get("due_at"))
                flag = ""
                if x.get("blocked_reason"):
                    flag = f"⛔ 卡住：{x['blocked_reason']}"
                elif due and due < d0:
                    flag = f"⚠ 逾期 {(d0 - due).days} 天"
                elif due and due == d0:
                    flag = "今天到期"
                elif due and (due - d0).days <= 3:
                    flag = f"{(due - d0).days} 天後到期"
                urgent += bool(flag)
                lines.append(f"- {x['title']}{'（' + x['where'] + '）' if x['where'] else ''}｜{A.ZH.get(x['status'], x['status'])}"
                             + (f"｜{flag}" if flag else ""))
            total = len(lines)
            text = (f"早安！今天的對齊：你手上有 **{total}** 項進行中的工作" + (f"，其中 {urgent} 項要特別注意" if urgent else "") + "。\n\n"
                    + "\n".join(lines[:15]) + (f"\n- …另外 {total - 15} 項" if total > 15 else "")
                    + "\n\n回覆我就好：**昨天做到哪？今天要做什麼？有沒有卡住或需要誰幫忙？**（可以貼截圖，我會記到對應的項目）")
            await db.execute("INSERT INTO aipm_personal (user_id, role, kind, text, payload) VALUES (?, 'aipm', 'daily', ?, ?)",
                             (u["id"], text, json.dumps({"items": total, "urgent": urgent})))
            await notify(db, {u["id"]}, None, aipm.SYSTEM, "aipm_my", f"AiPM 每日對齊：你有 {total} 項進行中的工作" + (f"，{urgent} 項要注意" if urgent else ""))
            n += 1
        await db.commit()
    finally:
        await db.close()
    return n


async def closures() -> int:
    """Leaf items completed since the last look: ask the person responsible to align the closure with AiPM."""
    from .routes.tasks import notify
    conf = _conf()
    db = await get_db()
    try:
        cur = await db.execute("SELECT strftime('%Y-%m-%d %H:%M:%S', 'now')")
        now = (await cur.fetchone())[0]
        since = conf.get("closure_since")
        if not since:                                    # first run: from now on
            _save(closure_since=now)
            return 0
        subs = await _rows(db, """SELECT c.id, c.task_id, c.title, c.completed_at, c.assignee_id FROM task_comments c
                                  WHERE c.is_task = 1 AND c.status = 'complete' AND c.completed_at > ?
                                  AND NOT EXISTS (SELECT 1 FROM task_comments k WHERE k.task_parent_id = c.id AND k.is_task = 1)""", (since,))
        cards = await _rows(db, """SELECT t.id, t.title, t.completed_at, t.owner_id,
                                          (SELECT user_id FROM task_members WHERE task_id = t.id AND role = 'assignee' LIMIT 1) AS lead
                                   FROM tasks t WHERE t.status = 'complete' AND t.completed_at > ? AND t.kind != 'project'
                                   AND (t.repeat IS NULL OR t.repeat = '')
                                   AND NOT EXISTS (SELECT 1 FROM task_comments k WHERE k.task_id = t.id AND k.is_task = 1)""", (since,))
        n = 0
        for card, sub, title, at, who in [*((s["task_id"], s["id"], s["title"], s["completed_at"], s["assignee_id"]) for s in subs),
                                          *((c["id"], None, c["title"], c["completed_at"], c["lead"] or c["owner_id"]) for c in cards)]:
            cur = await db.execute("INSERT OR IGNORE INTO aipm_closures (card_id, sub_id, title, closed_at, user_id) VALUES (?, ?, ?, ?, ?)",
                                   (card, sub, title, at, who))
            if not cur.rowcount:
                continue
            n += 1
            if who and await aipm.sees(db, who, [card]):
                await notify(db, {who}, card, aipm.SYSTEM, "aipm_close", f"「{title}」已完成：請跟 AiPM 做結案對齊（完成條件、紀錄、結案摘要）")
        await db.commit()
        _save(closure_since=now)
        return n
    finally:
        await db.close()


async def checklist(db, c: dict) -> List[dict]:
    """What a closure should have: a description with the completion criteria, records (files), a summary."""
    if c["sub_id"]:
        r = await _rows(db, """SELECT c.body AS d, (SELECT COUNT(*) FROM task_images i WHERE i.comment_id = c.id
                                  OR i.comment_id IN (SELECT r.id FROM task_comments r WHERE r.parent_id = c.id)) AS files,
                                  (SELECT COALESCE(SUM(minutes), 0) FROM task_time WHERE comment_id = c.id) AS mins
                               FROM task_comments c WHERE c.id = ?""", (c["sub_id"],))
    else:
        r = await _rows(db, """SELECT t.description AS d, (SELECT COUNT(*) FROM task_images i WHERE i.task_id = t.id AND i.pending = 0) AS files,
                                  0 AS mins FROM tasks t WHERE t.id = ?""", (c["card_id"],))
    x = r[0] if r else {"d": "", "files": 0, "mins": 0}
    d = x["d"] or ""
    return [{"ok": bool(d.strip()), "text": "有說明"},
            {"ok": bool(re.search(r"驗收|完成條件|完成標準|done|acceptance", d, re.I)), "text": "說明裡有完成／驗收條件"},
            {"ok": x["files"] > 0, "text": f"有截圖或檔案紀錄（{x['files']}）"},
            *([{"ok": True, "text": f"記錄工時 {x['mins'] / 60:.1f} 小時"}] if x["mins"] else [])]
