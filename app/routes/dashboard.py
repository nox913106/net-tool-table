"""
Public task dashboard (no login, read only).

Counts only: department → account → number of cards per status, what falls due when,
weekly trend lines, projects' progress (names only when an administrator allows it),
people's load in hours and, when switched on, the system's lights. No card titles or
any other card content.

A card counts once for each assignee; a card without assignees counts for its creator.
Recurring cards (週期工作 and anything with a repeat rule) are left out.
`version` changes whenever anything shown changes, so the page only re-renders when needed.
"""
import asyncio
import hashlib
import json
import time
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException

from .. import i18n
from ..database import get_db
from .settings import read_settings
from .tasks import STATUSES

router = APIRouter(tags=["dashboard"])
SHOWN = [s for s in STATUSES if s != "recurring"]
CLOSED = ("complete", "canceled")
NO_DEPT = "未設定部門"
TREND_WEEKS = 8
_snap = {"at": 0.0}
_health = {}                                # language → (time, items)


async def _people(db):
    cur = await db.execute("SELECT id, display_name, username, department, active FROM users")
    return {u["id"]: u for u in await cur.fetchall()}


def _dept(people, uid):
    u = people.get(uid)
    return ((u["department"] if u else "") or "").strip() or NO_DEPT


async def _counts(db):
    """{person_id: {status: n}} — the table on the page (and the trend snapshots)."""
    cur = await db.execute("""
        SELECT t.status, COALESCE(m.user_id, t.owner_id) AS person_id, COUNT(*) AS c
        FROM tasks t
        LEFT JOIN task_members m ON m.task_id = t.id AND m.role = 'assignee'
        WHERE t.status != 'recurring' AND t.repeat IS NULL
        GROUP BY t.status, person_id""")
    counts = {}
    for r in await cur.fetchall():
        counts.setdefault(r["person_id"], {})[r["status"]] = r["c"]
    return counts


async def _due(db, people, today):
    """Open cards and subtasks with a due date, per department and person: 逾期 / 今天 / 3 天內 / 7 天內."""
    rows = []
    cur = await db.execute("""
        SELECT t.due_at AS due, COALESCE(m.user_id, t.owner_id) AS who
        FROM tasks t LEFT JOIN task_members m ON m.task_id = t.id AND m.role = 'assignee'
        WHERE t.status NOT IN ('complete', 'canceled', 'recurring') AND t.repeat IS NULL AND t.due_at IS NOT NULL AND t.due_at != ''""")
    rows += await cur.fetchall()
    cur = await db.execute("""
        SELECT c.due_at AS due, COALESCE(c.assignee_id, t.owner_id) AS who
        FROM task_comments c JOIN tasks t ON t.id = c.task_id
        WHERE c.is_task = 1 AND COALESCE(c.status, 'new') NOT IN ('complete', 'canceled')
              AND t.status != 'recurring' AND t.repeat IS NULL AND c.due_at IS NOT NULL AND c.due_at != ''""")
    rows += await cur.fetchall()
    by_dept, by_person = {}, {}
    for r in rows:
        try:
            d = date.fromisoformat(str(r["due"])[:10])
        except ValueError:
            continue
        days = (d - today).days
        k = "overdue" if days < 0 else "today" if days == 0 else "soon" if days <= 3 else "week" if days <= 7 else None
        if not k:
            continue
        dept = _dept(people, r["who"])
        b = by_dept.setdefault(dept, {"overdue": 0, "today": 0, "soon": 0, "week": 0})
        b[k] += 1
        if r["who"] is not None:
            p = by_person.setdefault(r["who"], {"overdue": 0, "today": 0, "soon": 0, "week": 0})
            p[k] += 1
    return by_dept, by_person


async def snapshot(db, counts=None, people=None, force=False):
    """Today's counts per department and status, for the trend lines (kept 400 days)."""
    if not force and time.time() - _snap["at"] < 600:
        return
    _snap["at"] = time.time()
    counts = counts if counts is not None else await _counts(db)
    people = people if people is not None else await _people(db)
    per = {}
    for uid, c in counts.items():
        d = per.setdefault(_dept(people, uid), {})
        for s, n in c.items():
            if s in SHOWN:
                d[s] = d.get(s, 0) + n
    day = date.today().isoformat()
    await db.execute("DELETE FROM dash_snap WHERE day = ?", (day,))
    await db.executemany("INSERT INTO dash_snap (day, dept, status, n) VALUES (?, ?, ?, ?)",
                         [(day, dept, s, n) for dept, c in per.items() for s, n in c.items()])
    await db.execute("DELETE FROM dash_snap WHERE day < ?", ((date.today() - timedelta(days=400)).isoformat(),))
    await db.commit()


async def _trend(db, today):
    """Last 8 weeks, one point per week: the latest snapshot of that week (None where there is none)."""
    week0 = today - timedelta(days=today.weekday())
    starts = [week0 - timedelta(weeks=TREND_WEEKS - 1 - i) for i in range(TREND_WEEKS)]
    cur = await db.execute("SELECT day, dept, status, n FROM dash_snap WHERE day >= ? ORDER BY day", (starts[0].isoformat(),))
    latest = {}          # week index → day → {dept: {status: n}}
    for r in await cur.fetchall():
        i = (date.fromisoformat(r["day"]) - starts[0]).days // 7
        if 0 <= i < TREND_WEEKS:
            latest.setdefault(i, {}).setdefault(r["day"], {}).setdefault(r["dept"], {})[r["status"]] = r["n"]
    depts = {}
    for i, days in latest.items():
        last = days[max(days)]
        for dept, c in last.items():
            d = depts.setdefault(dept, {s: [None] * TREND_WEEKS for s in SHOWN})
            for s in SHOWN:
                d[s][i] = c.get(s, 0)
        for dept, d in depts.items():                # a department missing from that day had nothing
            if dept not in last:
                for s in SHOWN:
                    if d[s][i] is None:
                        d[s][i] = 0
    every = {s: [None if all(depts[d][s][i] is None for d in depts) else sum(depts[d][s][i] or 0 for d in depts)
                 for i in range(TREND_WEEKS)] for s in SHOWN}
    return {"weeks": [w.isoformat() for w in starts], "all": every, "depts": depts}


async def _projects(db, people, mode):
    from .. import projects as P
    cur = await db.execute("SELECT id FROM tasks WHERE status != 'recurring'")
    ids = [r[0] for r in await cur.fetchall()]
    a = await P.analyze(db, ids)
    # departments involved: the project's creator, card assignees and subtask assignees under it
    cur = await db.execute("""SELECT t.id, t.owner_id, t.kind, t.project_id, m.user_id FROM tasks t
                              LEFT JOIN task_members m ON m.task_id = t.id AND m.role = 'assignee'""")
    who = {}
    for r in await cur.fetchall():
        root = r["id"] if (r["kind"] or "ops") == "project" else r["project_id"]
        if root:
            who.setdefault(root, set()).update(x for x in (r["owner_id"], r["user_id"]) if x)
    cur = await db.execute("""SELECT t.id, t.kind, t.project_id, c.assignee_id FROM task_comments c JOIN tasks t ON t.id = c.task_id
                              WHERE c.is_task = 1 AND c.assignee_id IS NOT NULL""")
    for r in await cur.fetchall():
        root = r["id"] if (r["kind"] or "ops") == "project" else r["project_id"]
        if root:
            who.setdefault(root, set()).add(r["assignee_id"])
    out = []
    live = [p for p in a["projects"] if p["status"] not in CLOSED]
    for n, p in enumerate(live):
        label = p["title"] if mode == "names" else i18n.tr("專案 {0}", _letters(n))
        nxt = p.get("next")
        out.append({"label": label, "pct": p["pct"], "slip": p["slip"], "status": p["status"],
                    "due": p["end"] or p["due"], "next_due": nxt["due"] if nxt else None,
                    "next": (nxt["title"] if mode == "names" else None) if nxt else None,
                    "open": p["open"], "problems": p["problem_items"],
                    "depts": sorted(({_dept(people, u) for u in who.get(p["id"], set())} - {NO_DEPT}) or {NO_DEPT})})
    return out, a


def _letters(n):
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


async def _health_items():
    """Worst level per group (storage, memory, backup, certificate …) — no numbers or names."""
    from .. import monitor
    lang = i18n.lang()
    hit = _health.get(lang)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    items = await asyncio.get_running_loop().run_in_executor(None, lambda: monitor.checks(None, False, False, lang))
    rank = {"ok": 0, "warn": 1, "fail": 2}
    groups = {}
    for it in items:
        if it["key"] == "boot":
            continue
        g = groups.get(it["group"])
        if not g or rank.get(it["level"], 0) > rank.get(g, 0):
            groups[it["group"]] = it["level"]
    out = [{"group": g, "level": l} for g, l in groups.items()]
    _health[lang] = (time.time(), out)
    return out


@router.get("/api/public/dashboard")
async def dashboard():
    db = await get_db()
    try:
        settings = await read_settings(db)
        if settings.get("public_dashboard") is False:
            raise HTTPException(status_code=404, detail="公開看板已關閉")
        today = date.today()
        people = await _people(db)
        counts = await _counts(db)
        await snapshot(db, counts, people)
        due_dept, due_person = await _due(db, people, today)
        no_one = i18n.tr("未指派")
        depts = {}
        for uid, c in counts.items():
            u = people.get(uid)
            name = (u["display_name"] or u["username"]) if u else no_one
            depts.setdefault(_dept(people, uid), []).append({
                "name": name, "counts": {s: c.get(s, 0) for s in SHOWN}, "total": sum(c.get(s, 0) for s in SHOWN),
                "active": bool(u["active"]) if u else True,
                "due": due_person.get(uid, {"overdue": 0, "today": 0, "soon": 0, "week": 0})})
        for dept in due_dept:
            depts.setdefault(dept, [])
        zero_due = {"overdue": 0, "today": 0, "soon": 0, "week": 0}
        out = []
        for dept in sorted(depts, key=lambda d: (d == NO_DEPT, d)):
            rows = sorted(depts[dept], key=lambda p: (-p["total"], p["name"]))
            totals = {s: sum(p["counts"][s] for p in rows) for s in SHOWN}
            out.append({"department": dept, "label": i18n.tr(dept) if dept == NO_DEPT else dept, "people": rows,
                        "totals": totals, "total": sum(totals.values()), "due": due_dept.get(dept, dict(zero_due))})
        mode = settings.get("dashboard_projects") or "anon"
        projects, analysis = (await _projects(db, people, mode)) if mode != "off" else (None, None)
        load = None
        if settings.get("dashboard_load", True):
            if analysis is None:
                from .. import projects as P
                cur = await db.execute("SELECT id FROM tasks WHERE status != 'recurring'")
                analysis = await P.analyze(db, [r[0] for r in await cur.fetchall()])
            load = {"week0": analysis["week0"], "limit": analysis["load_hours"],
                    "people": [{"name": r["name"], "dept": _dept(people, r["user"]), "hours": [w["hours"] for w in r["weeks"]],
                                "over": r["over"]} for r in analysis["load"]]}
        health = await _health_items() if settings.get("dashboard_health") else None
        trend = await _trend(db, today)
        for dep in out:                              # the trend under the department's own (translated) label
            dep["trend"] = trend["depts"].get(dep["department"])
        data = {
            "title": settings.get("site_title") or "IPMS",
            "statuses": SHOWN,
            "today": today.isoformat(),
            "departments": out,
            "totals": {s: sum(d["totals"][s] for d in out) for s in SHOWN},
            "due": {k: sum(d["due"][k] for d in out) for k in zero_due},
            "trend": {"weeks": trend["weeks"], "all": trend["all"]},
            "projects": projects,
            "project_mode": mode,
            "load": load,
            "health": health,
            "rotate_seconds": settings.get("dashboard_rotate_seconds") or 20,
        }
        # the page re-renders only when something shown changed
        data["version"] = hashlib.sha1(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]
        return data
    finally:
        await db.close()
