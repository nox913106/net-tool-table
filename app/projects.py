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
