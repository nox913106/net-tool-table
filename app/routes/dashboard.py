"""
Public task dashboard (no login, read only).

Department → account → number of cards per status. No titles or any other card content.
A card counts once for each assignee; a card without assignees counts for its creator.
Recurring cards (週期工作 and anything with a repeat rule) are left out.
`version` changes whenever a card changes, so the page only re-renders when needed.
"""
from fastapi import APIRouter, HTTPException

from ..database import get_db
from .settings import read_settings
from .tasks import STATUSES

router = APIRouter(tags=["dashboard"])
SHOWN = [s for s in STATUSES if s != "recurring"]


@router.get("/api/public/dashboard")
async def dashboard():
    db = await get_db()
    try:
        settings = await read_settings(db)
        if settings.get("public_dashboard") is False:
            raise HTTPException(status_code=404, detail="公開看板已關閉")
        cur = await db.execute("SELECT COUNT(*) AS n, MAX(updated_at) AS u, MAX(id) AS m FROM tasks")
        v = await cur.fetchone()
        cur = await db.execute("""
            SELECT t.status, COALESCE(m.user_id, t.owner_id) AS person_id, COUNT(*) AS c
            FROM tasks t
            LEFT JOIN task_members m ON m.task_id = t.id AND m.role = 'assignee'
            WHERE t.status != 'recurring' AND t.repeat IS NULL
            GROUP BY t.status, person_id""")
        counts = {}
        for r in await cur.fetchall():
            counts.setdefault(r["person_id"], {})[r["status"]] = r["c"]
        ids = [u for u in counts if u is not None]
        people = {}
        if ids:
            cur = await db.execute(f"SELECT id, display_name, username, department, active FROM users WHERE id IN ({','.join('?' * len(ids))})", ids)
            people = {u["id"]: u for u in await cur.fetchall()}
        depts = {}
        for uid, c in counts.items():
            u = people.get(uid)
            dept = (u["department"] if u else "") or "未設定部門"
            name = (u["display_name"] or u["username"]) if u else "未指派"
            depts.setdefault(dept, []).append({"name": name, "counts": {s: c.get(s, 0) for s in SHOWN},
                                               "total": sum(c.values()), "active": bool(u["active"]) if u else True})
        out = []
        for dept in sorted(depts, key=lambda d: (d in ("未設定部門",), d)):
            people_rows = sorted(depts[dept], key=lambda p: p["name"])
            totals = {s: sum(p["counts"][s] for p in people_rows) for s in SHOWN}
            out.append({"department": dept, "people": people_rows, "totals": totals, "total": sum(totals.values())})
        return {
            "title": settings.get("site_title") or "Tool Table",
            "statuses": SHOWN,
            "departments": out,
            "totals": {s: sum(d["totals"][s] for d in out) for s in SHOWN},
            "version": f"{v['n']}-{v['m']}-{v['u']}",
        }
    finally:
        await db.close()
