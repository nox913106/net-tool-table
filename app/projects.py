"""
Projects running side by side: what needs attention, computed once on the server so the radar,
the alert list, the Excel report and the notifications agree.

Problems (not merely "due soon" — that is normal scheduled work, see 我的工作):
  overdue   an open item past its due date
  blocked   a card marked 卡住
  conflict  an item starts before its predecessor (same project) is finished
  xdep      its predecessor is in another project / card and is late or ends too late
  window    a shared window (power-down, maintenance) used by more projects than it allows,
            or work scheduled into a change freeze
People load: per person and week, the estimated hours of the open items due that week, across all
projects and everyday cards (an item without an estimate counts the default); above the limit = overloaded.
"""
import json
from datetime import date, timedelta
from typing import Dict, List, Optional

OPEN = ("new", "ongoing", "pending", "onhold", "overdue", "recurring")
CLOSED = ("complete", "canceled")
PROBLEM_ORDER = ["overdue", "blocked", "conflict", "xdep", "window", "overload"]
PROBLEM_ZH = {"overdue": "逾期", "blocked": "卡住", "conflict": "排程衝突", "xdep": "跨專案前置延誤",
              "window": "時段衝突", "overload": "人員超載"}


def _d(v) -> Optional[date]:
    if not v:
        return None
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def _deps(raw) -> List[dict]:
    if not raw:
        return []
    try:
        return [x for x in json.loads(raw) if isinstance(x, dict) and x.get("u")]
    except (ValueError, TypeError):
        return []


async def settings(db) -> dict:
    cur = await db.execute("SELECT key, value FROM settings WHERE key IN ('board_windows', 'board_load_hours', 'board_default_estimate_hours')")
    got = {r[0]: json.loads(r[1]) for r in await cur.fetchall()}
    return {"windows": got.get("board_windows") or [], "load_hours": float(got.get("board_load_hours") or 40),
            "default_hours": float(got.get("board_default_estimate_hours") or 4)}


async def analyze(db, card_ids: List[int], today: Optional[date] = None, weeks: int = 6) -> dict:
    """card_ids: the cards the viewer may see. Returns projects (health), problems, load, windows."""
    today = today or date.today()
    week0 = today - timedelta(days=today.weekday())
    cfg = await settings(db)
    if not card_ids:
        return {"projects": [], "problems": [], "load": [], "windows": cfg["windows"], "week0": week0.isoformat(),
                "load_hours": cfg["load_hours"], "default_hours": cfg["default_hours"]}
    marks = ",".join("?" * len(card_ids))
    cur = await db.execute(f"""SELECT id, uid, title, kind, project_id, rank, status, priority, start_at, due_at, milestone, deps,
                                      base_start, base_due, owner_id, blocked_at, blocked_reason, win
                               FROM tasks WHERE id IN ({marks})""", card_ids)
    cards = {r["id"]: dict(r) for r in await cur.fetchall()}
    cur = await db.execute(f"""SELECT id, uid, task_id, task_parent_id, title, status, start_at, due_at, milestone, deps,
                                      base_start, base_due, assignee_id, estimate_minutes, win
                               FROM task_comments WHERE is_task = 1 AND parent_id IS NULL AND task_id IN ({marks})""", card_ids)
    subs = {r["id"]: dict(r) for r in await cur.fetchall()}
    cur = await db.execute(f"""SELECT task_id, user_id, role FROM task_members WHERE task_id IN ({marks}) AND role = 'assignee'
                               ORDER BY created_at""", card_ids)
    lead = {}
    for r in await cur.fetchall():
        lead.setdefault(r["task_id"], r["user_id"])
    cur = await db.execute("SELECT id, username, display_name FROM users")
    names = {r[0]: r[2] or r[1] for r in await cur.fetchall()}

    kids_of = {}
    for s in subs.values():
        kids_of.setdefault(("s", s["task_parent_id"]) if s["task_parent_id"] else ("t", s["task_id"]), []).append(s)
    has_kids = lambda kind, i: bool(kids_of.get((kind, i)))
    # the project a card belongs to: itself when it is a project, else the project it is attached to
    root = {cid: (cid if (c["kind"] or "ops") == "project" else c["project_id"] if c["project_id"] in cards else None) for cid, c in cards.items()}
    # every schedulable item, by key
    items: Dict[str, dict] = {}
    for c in cards.values():
        items[f"t:{c['id']}"] = {"key": f"t:{c['id']}", "kind": "t", "id": c["id"], "card": c["id"], "title": c["title"], "status": c["status"],
                                 "start": _d(c["start_at"]), "due": _d(c["due_at"]), "milestone": bool(c["milestone"]),
                                 "deps": _deps(c["deps"]), "who": lead.get(c["id"]) or c["owner_id"], "est": None, "win": c["win"],
                                 "leaf": not has_kids("t", c["id"]), "uid": c["uid"]}
    for s in subs.values():
        items[f"s:{s['id']}"] = {"key": f"s:{s['id']}", "kind": "s", "id": s["id"], "card": s["task_id"], "title": s["title"],
                                 "status": s["status"] or "new", "start": _d(s["start_at"]), "due": _d(s["due_at"]),
                                 "milestone": bool(s["milestone"]), "deps": _deps(s["deps"]), "who": s["assignee_id"],
                                 "est": s["estimate_minutes"], "win": s["win"], "leaf": not has_kids("s", s["id"]), "uid": s["uid"]}
    by_uid = {x["uid"]: x for x in items.values() if x["uid"]}
    # predecessors outside what the viewer sees still count (only their dates are used)
    missing = {d["u"] for x in items.values() for d in x["deps"] if d["u"] not in by_uid}
    if missing:
        ms = list(missing)[:900]
        q = ",".join("?" * len(ms))
        cur = await db.execute(f"SELECT uid, id, title, status, start_at, due_at FROM tasks WHERE uid IN ({q})", ms)
        for r in await cur.fetchall():
            by_uid[r["uid"]] = {"key": f"t:{r['id']}", "card": r["id"], "title": r["title"], "status": r["status"], "start": _d(r["start_at"]), "due": _d(r["due_at"]), "outside": True}
        cur = await db.execute(f"SELECT uid, id, task_id, title, status, start_at, due_at FROM task_comments WHERE uid IN ({q})", ms)
        for r in await cur.fetchall():
            by_uid[r["uid"]] = {"key": f"s:{r['id']}", "card": r["task_id"], "title": r["title"], "status": r["status"] or "new", "start": _d(r["start_at"]), "due": _d(r["due_at"]), "outside": True}

    def card_root(card_id):
        return root.get(card_id) if card_id in cards else None

    problems = []

    def add(x, kind, text, extra=None):
        c = cards.get(x["card"])
        problems.append({"key": x["key"], "card": x["card"], "project": card_root(x["card"]), "type": kind, "type_zh": PROBLEM_ZH[kind],
                         "text": text, "title": x["title"], "card_title": c["title"] if c else "", "who": x.get("who"),
                         "who_name": names.get(x.get("who")) if x.get("who") else None,
                         "due": x["due"].isoformat() if x.get("due") else None, **(extra or {})})

    for x in items.values():
        if x["status"] in CLOSED:
            continue
        if x["due"] and x["due"] < today and not (x["kind"] == "t" and not x["leaf"] and x["status"] == "recurring"):
            add(x, "overdue", f"逾期 {(today - x['due']).days} 天")
        start = x["start"] or x["due"]
        for d in x["deps"]:
            pre = by_uid.get(d["u"])
            if not pre or pre["status"] in CLOSED or not pre.get("due") or not start:
                continue
            need = pre["due"] + timedelta(days=int(d.get("lag") or 0) + (0 if x["milestone"] else 1))
            other = card_root(pre["card"]) != card_root(x["card"]) or (card_root(x["card"]) is None and pre["card"] != x["card"])
            if other:
                if pre["due"] < today or start < need:
                    pc = cards.get(pre["card"])
                    add(x, "xdep", f"前置「{pre['title']}」在{('「' + pc['title'] + '」') if pc else '其他專案'}"
                                   + (f"逾期 {(today - pre['due']).days} 天" if pre["due"] < today else f" {pre['due']:%m/%d} 才完成"),
                        {"pre_key": pre["key"], "pre_card": pre["card"]})
            elif start < need:
                add(x, "conflict", f"比前置「{pre['title']}」早開始（前置 {pre['due']:%m/%d} 完成）", {"pre_key": pre["key"]})
    for c in cards.values():
        if c["blocked_at"] and c["status"] not in CLOSED:
            add(items[f"t:{c['id']}"], "blocked", "卡住：" + (c["blocked_reason"] or "")[:60])

    # shared windows
    wins = []
    for w in cfg["windows"]:
        users = [x for x in items.values() if x["win"] == w["id"] and x["status"] not in CLOSED]
        projects = {card_root(x["card"]) or f"c{x['card']}" for x in users}
        freeze = w.get("kind") == "freeze"
        clash = (len(projects) > int(w.get("capacity", 1))) if not freeze else bool(users)
        wins.append({**w, "users": [{"key": x["key"], "card": x["card"], "project": card_root(x["card"]), "title": x["title"],
                                     "who": names.get(x["who"]) if x["who"] else None} for x in users],
                     "projects": len(projects), "clash": clash})
        if clash:
            for x in users:
                add(x, "window", f"排在{w['title']}（{w['from'][5:].replace('-', '/')}）內" if freeze
                    else f"{w['title']} {w['from'][5:].replace('-', '/')}：{len(projects)} 個專案搶用（可容納 {w.get('capacity', 1)}）", {"window": w["id"]})

    # people load
    per = {}
    for x in items.values():
        if x["status"] in CLOSED or not x["who"] or not x["due"] or not x["leaf"] or x["milestone"]:
            continue
        wk = (x["due"] - week0).days // 7
        if not 0 <= wk < weeks:
            continue
        p = per.setdefault(x["who"], [{"hours": 0.0, "count": 0, "no_estimate": 0, "items": []} for _ in range(weeks)])
        h = (x["est"] / 60) if x["est"] else cfg["default_hours"]
        p[wk]["hours"] += h
        p[wk]["count"] += 1
        p[wk]["no_estimate"] += 0 if x["est"] else 1
        p[wk]["items"].append({"key": x["key"], "card": x["card"], "project": card_root(x["card"]), "title": x["title"], "hours": round(h, 1),
                               "estimated": bool(x["est"]), "due": x["due"].isoformat()})
    load = []
    for uid, wl in per.items():
        for w in wl:
            w["hours"] = round(w["hours"], 1)
        load.append({"user": uid, "name": names.get(uid) or str(uid), "weeks": wl, "over": wl[0]["hours"] > cfg["load_hours"]})
    load.sort(key=lambda r: (-r["weeks"][0]["hours"], r["name"]))
    for r in load:
        if r["over"]:
            w = r["weeks"][0]
            projs = {i["project"] for i in w["items"] if i["project"]}
            problems.append({"key": f"u:{r['user']}", "card": None, "project": None, "type": "overload", "type_zh": PROBLEM_ZH["overload"],
                             "text": f"本週 {w['hours']:g} 小時（上限 {cfg['load_hours']:g}）· {len(projs)} 個專案 · {w['count']} 項"
                                     + (f"，{w['no_estimate']} 項未填預估" if w["no_estimate"] else ""),
                             "title": f"{r['name']}：本週超載", "card_title": "", "who": r["user"], "who_name": r["name"], "due": None})

    # projects' health
    projects = []
    for c in cards.values():
        if (c["kind"] or "ops") != "project":
            continue
        tree = [x for x in items.values() if card_root(x["card"]) == c["id"]]
        leaves = [x for x in tree if x["leaf"] and not x["milestone"] and x["status"] != "canceled"]
        done = sum(1 for x in leaves if x["status"] == "complete")
        ends = [x["due"] for x in tree if x["due"]]
        end = max(ends) if ends else _d(c["due_at"])
        slip = (end - _d(c["base_due"])).days if end and c["base_due"] else None
        ms = sorted([x for x in tree if x["milestone"] and x["status"] not in CLOSED and x["due"]], key=lambda x: x["due"])
        nxt = next((m for m in ms if m["due"] >= today), ms[0] if ms else None)
        if not nxt and c["due_at"] and c["status"] not in CLOSED:
            nxt = {"title": "結案", "due": _d(c["due_at"]), "key": f"t:{c['id']}"}
        mine = [p for p in problems if p["project"] == c["id"]]
        counts = {k: sum(1 for p in mine if p["type"] == k) for k in PROBLEM_ORDER}
        projects.append({"id": c["id"], "title": c["title"], "rank": c["rank"], "status": c["status"], "priority": c["priority"],
                         "start": c["start_at"], "due": c["due_at"], "end": end.isoformat() if end else None,
                         "base_due": c["base_due"], "slip": slip, "pct": round(done / len(leaves) * 100) if leaves else 0,
                         "items": len(tree), "open": sum(1 for x in tree if x["status"] not in CLOSED),
                         "next": {"title": nxt["title"], "due": nxt["due"].isoformat(), "key": nxt["key"]} if nxt else None,
                         "problems": counts, "problem_items": len({p["key"] for p in mine}),
                         "attached": sorted(cid for cid, cc in cards.items() if cc["project_id"] == c["id"] and (cc["kind"] or "ops") == "ops")})
    projects.sort(key=lambda p: (p["rank"] if p["rank"] is not None else 1e9, p["id"]))
    problems.sort(key=lambda p: (PROBLEM_ORDER.index(p["type"]), p["due"] or "9999"))
    return {"projects": projects, "problems": problems, "load": load, "windows": wins, "week0": week0.isoformat(),
            "load_hours": cfg["load_hours"], "default_hours": cfg["default_hours"]}


# ---------------------------------------------------------------- daily project notifications
WATCH_MODES = ("all", "mine", "digest", "off")
WATCH_ZH = {"all": "全部", "mine": "只跟我有關", "digest": "每日摘要", "off": "關閉"}


async def leads_of(db, project_id: int) -> set:
    """Who runs a project: the card's creator and its assignees (they get every project event by default)."""
    cur = await db.execute("SELECT owner_id FROM tasks WHERE id = ?", (project_id,))
    r = await cur.fetchone()
    out = {r[0]} if r and r[0] else set()
    cur = await db.execute("SELECT user_id FROM task_members WHERE task_id = ? AND role = 'assignee'", (project_id,))
    return out | {x[0] for x in await cur.fetchall()}


async def watch_mode(db, project_id: int, user_id: int, leads: Optional[set] = None) -> tuple:
    """(mode, is it the default): a set mode, else 全部 for the project's leads and 只跟我有關 for everyone else."""
    cur = await db.execute("SELECT mode FROM task_watch WHERE task_id = ? AND user_id = ?", (project_id, user_id))
    r = await cur.fetchone()
    if r and r[0] in WATCH_MODES:
        return r[0], False
    leads = leads if leads is not None else await leads_of(db, project_id)
    return ("all" if user_id in leads else "mine"), True


async def _members_of(db, project_id: int, attached: List[int]) -> set:
    """Everyone working on a project: leads, subtask assignees, the people on its attached cards."""
    cards = [project_id, *attached]
    marks = ",".join("?" * len(cards))
    out = set()
    for sql in (f"SELECT owner_id FROM tasks WHERE id IN ({marks})",
                f"SELECT user_id FROM task_members WHERE task_id IN ({marks}) AND role = 'assignee'",
                f"SELECT assignee_id FROM task_comments WHERE task_id IN ({marks}) AND is_task = 1 AND assignee_id IS NOT NULL"):
        cur = await db.execute(sql, cards)
        out |= {r[0] for r in await cur.fetchall() if r[0]}
    return out


async def daily_events(db, today: Optional[date] = None) -> int:
    """Once a day: tell people what changed in their projects. Each event is sent once while it lasts
    (it is sent again if it clears and comes back); a slip is sent again when it grows.
      slip      the project ends later than its baseline
      xdep      a predecessor in another project / card is late
      window    a shared window is over-booked, or work sits in a change freeze
      milestone the next milestone is due within 3 days
      overload  your estimated hours this week are above the limit (to that person only)
    Per project and person the mode decides: all — every event; mine — the events about one's own
    items (a slip: the leads); digest — one summary a day; off — nothing."""
    from .auth import full_user
    from .routes.tasks import notify, _visible_sql
    today = today or date.today()
    cur = await db.execute("SELECT id FROM tasks")
    ids = [r[0] for r in await cur.fetchall()]
    a = await analyze(db, ids, today)
    cur = await db.execute("SELECT value FROM settings WHERE key = '_proj_events'")
    r = await cur.fetchone()
    try:
        state = json.loads(r[0]) if r else {}
    except ValueError:
        state = {}
    sent_before, slips = state.get("sent", {}), state.get("slip", {})
    digests = {k: v for k, v in state.get("digest", {}).items() if v == today.isoformat()}   # one summary a day
    sent_now, events = {}, []                              # events: (project or None, key, text, involved)
    md = lambda d: f"{int(d[5:7])}/{int(d[8:10])}" if d else ""
    proj = {p["id"]: p for p in a["projects"]}
    leads = {pid: await leads_of(db, pid) for pid in proj}
    for p in a["projects"]:
        if p["status"] in CLOSED:
            continue
        slip = p["slip"] or 0
        if slip > 0 and slip > int(slips.get(str(p["id"]), 0)):
            events.append((p["id"], f"slip:{p['id']}", f"「{p['title']}」落後基準線 {slip} 天（預計 {md(p['end'])} 完成，原定 {md(p['base_due'])}）", leads[p["id"]]))
        slips[str(p["id"])] = max(slip, 0)
        nx = p["next"]
        if nx and nx["key"] != f"t:{p['id']}":
            left = (date.fromisoformat(nx["due"]) - today).days
            if 0 <= left <= 3:
                who = set()
                if nx["key"].startswith("s:"):
                    cur = await db.execute("SELECT assignee_id FROM task_comments WHERE id = ?", (int(nx["key"][2:]),))
                    x = await cur.fetchone()
                    who = {x[0]} if x and x[0] else set()
                events.append((p["id"], f"ms:{nx['key']}:{nx['due']}",
                               f"「{p['title']}」里程碑「{nx['title']}」{md(nx['due'])} 到期（{'今天' if not left else f'還有 {left} 天'}）", who))
    for pr in a["problems"]:
        if pr["type"] in ("xdep", "window"):
            where = f"「{pr['card_title']}」的" if pr["card_title"] and pr["card_title"] != pr["title"] else ""
            events.append((pr["project"], f"{pr['type']}:{pr['key']}", f"{where}「{pr['title']}」{pr['text']}", {pr["who"]} if pr["who"] else set(), pr["card"]))
    for row in a["load"]:
        if row["over"]:
            w = row["weeks"][0]
            events.append((None, f"overload:{row['user']}:{a['week0']}",
                           f"你本週到期的工作預估 {w['hours']} 小時，超過上限 {a['load_hours']:g} 小時"
                           + (f"（{w['no_estimate']} 項未填預估）" if w["no_estimate"] else ""), {row["user"]}))
    new = [e for e in events if e[1] not in sent_before]
    for e in events:
        sent_now[e[1]] = sent_before.get(e[1], today.isoformat())

    sys = {}                                               # a system notice has no actor
    vis_cache = {}

    async def can_see(uid, pid):
        if (uid, pid) not in vis_cache:
            cur = await db.execute("SELECT * FROM users WHERE id = ? AND active = 1", (uid,))
            row = await cur.fetchone()
            ok = False
            if row:
                where, args = _visible_sql(await full_user(db, row))
                cur = await db.execute(f"SELECT 1 FROM tasks t WHERE t.id = ? AND {where}", (pid, *args))
                ok = bool(await cur.fetchone())
            vis_cache[(uid, pid)] = ok
        return vis_cache[(uid, pid)]

    count = 0
    by_project: Dict[Optional[int], list] = {}
    for e in new:
        by_project.setdefault(e[0] if e[0] in proj else None, []).append(e)
    for e in by_project.pop(None, []):                     # not in a project: to the people involved
        await notify(db, e[3], e[4] if len(e) > 4 else None, sys, "project" if len(e) <= 4 else "card", e[2])
        count += len(e[3])
    for pid, p in proj.items():
        if p["status"] in CLOSED:
            continue
        evs = by_project.get(pid, [])
        cur = await db.execute("SELECT user_id FROM task_watch WHERE task_id = ? AND mode != 'off'", (pid,))
        people = await _members_of(db, pid, p["attached"]) | {r[0] for r in await cur.fetchall()}
        for uid in people:
            mode, _ = await watch_mode(db, pid, uid, leads[pid])
            if mode == "off" or not await can_see(uid, pid):
                continue
            if mode == "digest":
                if digests.get(f"{uid}:{pid}"):
                    continue
                digests[f"{uid}:{pid}"] = today.isoformat()
                bits = [f"完成 {p['pct']}%"]
                if p["slip"]:
                    bits.append(f"落後 {p['slip']} 天" if p["slip"] > 0 else f"提前 {-p['slip']} 天")
                bits += [f"{PROBLEM_ZH[k]} {n}" for k, n in p["problems"].items() if n and k != "overload"]
                if p["next"]:
                    bits.append(f"下個里程碑「{p['next']['title']}」{md(p['next']['due'])}")
                if evs:
                    bits.append(f"今日新事件 {len(evs)} 件")
                await notify(db, [uid], pid, sys, "project", f"「{p['title']}」今日摘要：" + "，".join(bits))
                count += 1
                continue
            for e in evs:
                if mode == "all" or uid in e[3]:
                    await notify(db, [uid], pid, sys, "project", e[2])
                    count += 1
    # the same events to Teams channels that follow projects (one message per project)
    try:
        from . import teams
        from .i18n import translate
        L = teams.lang()
        base = teams.site_url()
        for pid, evs in by_project.items():
            if pid is None or not evs:
                continue
            title = ("[Project events] " if L == "en" else "【專案事件】") + proj[pid]["title"]
            lines = ["• " + translate(e[2], L) for e in evs]
            payload = teams.card(title, lines, f"{base}/#/project/{pid}", "warn", "Open project" if L == "en" else "開啟專案頁")
            for ch in teams.active_channels("project"):
                if await teams._in_scope(db, ch, pid):
                    await teams.enqueue(db, ch["id"], "project", payload)
    except Exception:
        pass
    state = {"sent": sent_now, "slip": slips, "digest": digests}
    await db.execute("INSERT INTO settings (key, value) VALUES ('_proj_events', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                     (json.dumps(state, ensure_ascii=False),))
    return count


async def run_daily_if_due(now=None) -> Optional[int]:
    """Called every minute by the app: the project events once a day, at the board's daily reminder time.
    A standalone copy linked to a server leaves it to the server (its notices arrive with the sync)."""
    from datetime import datetime
    from . import config as C
    from .database import get_db
    now = now or datetime.now()
    db = await get_db()
    try:
        if not C.AUTH:
            cur = await db.execute("SELECT v FROM sync_state WHERE k = 'server'")
            r = await cur.fetchone()
            if r and r[0]:
                return None
        cur = await db.execute("SELECT key, value FROM settings WHERE key IN ('board_overdue_remind_time', '_proj_events_day')")
        got = {k: v for k, v in await cur.fetchall()}
        at = str(got.get("board_overdue_remind_time") or "09:30").strip('"')
        day = str(got.get("_proj_events_day") or "").strip('"')
        if day == now.date().isoformat() or now.strftime("%H:%M") < at:
            return None
        await db.execute("INSERT INTO settings (key, value) VALUES ('_proj_events_day', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                         (json.dumps(now.date().isoformat()),))
        n = await daily_events(db, now.date())
        await db.commit()
        return n
    finally:
        await db.close()
