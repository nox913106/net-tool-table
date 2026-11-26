"""
我的 AiPM API (app/aipm_my.py) — everything here is the signed-in person's own, or what they can already see.

  GET  /api/aipm-my                        my conversation, closures to align, meetings, today's work
  GET  /api/aipm-my/count                  closures waiting (for the sidebar badge)
  POST /api/aipm-my/chat                   text + screenshots (multipart) → AiPM's reply with records to confirm
  POST /api/aipm-my/messages/{id}/record   record the chosen entries as my comments on those items
  POST /api/aipm-my/meetings               meeting notes → minutes          GET .../meetings/{id}   one meeting
  POST /api/aipm-my/meetings/{id}/record   record the minutes' entries on the items
  POST /api/aipm-my/closures/{id}/draft    AiPM drafts the 結案摘要       POST .../closures/{id}/align   align
"""
import json
from typing import Dict, List, Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, field_validator

from .. import ai, aipm
from .. import aipm_my as M
from ..auth import current_user
from ..database import get_db

router = APIRouter(prefix="/api/aipm-my", tags=["aipm"])


def _member(request: Request) -> dict:
    user = current_user(request)
    if user.get("role") == "guest":
        raise HTTPException(status_code=403, detail="帳號尚未開通")
    return user


def _bad(e):
    raise HTTPException(status_code=400, detail=aipm._err(e))


async def _closures(db, user: dict, request) -> List[dict]:
    """Closures I should align: mine (the person responsible), or any in projects I approve for."""
    me = user.get("id")
    rows = await M._rows(db, """SELECT c.*, t.title AS card_title, t.project_id FROM aipm_closures c JOIN tasks t ON t.id = c.card_id
                                WHERE c.aligned = 0 ORDER BY c.id DESC LIMIT 300""")
    out = []
    for c in rows:
        if c["user_id"] != me:
            root = (await aipm._root(db, c["card_id"]))["id"]
            if not await aipm.can_approve(db, root, user):
                continue
        if not await aipm.sees(db, me, [c["card_id"]]) and me is not None:
            continue
        c["checks"] = await M.checklist(db, c)
        out.append(c)
        if len(out) >= 50:
            break
    return out


@router.get("/count")
async def count(request: Request):
    user = _member(request)
    db = await get_db()
    try:
        return {"closures": len(await _closures(db, user, request)), "enabled": aipm.enabled()}
    finally:
        await db.close()


@router.get("")
async def overview(request: Request):
    user = _member(request)
    me = user.get("id")
    visible = await M.visible_cards(request)
    db = await get_db()
    try:
        msgs = await M._rows(db, "SELECT * FROM aipm_personal WHERE user_id IS ? ORDER BY id DESC LIMIT 80", (me,))
        msgs.reverse()
        meetings = []
        for m in await M._rows(db, "SELECT id, user_id, title, held_on, cards, at FROM aipm_meetings ORDER BY id DESC LIMIT 300"):
            if await M.meeting_visible(m, user, visible):
                meetings.append({k: m[k] for k in ("id", "title", "held_on", "at")} | {"mine": m["user_id"] == me})
            if len(meetings) >= 60:
                break
        closures = await _closures(db, user, request)
    finally:
        await db.close()
    for m in msgs:
        m["payload"] = json.loads(m["payload"]) if m.get("payload") else None
        m["uploads"] = json.loads(m["uploads"]) if m.get("uploads") else []
    s = ai.settings()
    pool = ai.usable() if s["enabled"] else []
    targets = []
    try:
        snap = await M.context(request)
        targets = [{"ref": it["code"], "title": it["title"], "project": it.get("project") or "", "level": it["level"],
                    "status": it["status"], "mine": bool(it.get("mine")), "card": it["card"]}
                   for it in snap["items"] if it["status"] not in M.CLOSED or it.get("mine")]
        today = [it for it in snap["items"] if it.get("mine") and it["status"] not in M.CLOSED and not it.get("is_project")]
    except HTTPException:
        today = []
    d0 = __import__("datetime").date.today()
    work = [{"ref": it["code"], "title": it["title"], "project": it.get("project") or "", "status": it["status"],
             "due": it["due"].isoformat() if it["due"] else None, "late": bool(it["due"] and it["due"] < d0),
             "blocked": it.get("blocked") or "", "card": it["card"], "sub": it["id"] if it["kind"] == "sub" else None}
            for it in today][:80]
    work.sort(key=lambda w: (not w["blocked"], not w["late"], w["due"] or "9999"))
    return {"enabled": aipm.enabled() and bool(pool), "vision": any(ai.sees_images(p, s) for p in pool), "me": me,
            "name": user.get("display_name") or user.get("username"), "messages": msgs, "meetings": meetings,
            "closures": closures, "targets": targets, "work": work}


@router.post("/chat")
async def chat(request: Request, text: str = Form(""), files: List[UploadFile] = File(default=[])):
    user = _member(request)
    text = (text or "").strip()[:6000]
    if not text and not files:
        raise HTTPException(status_code=400, detail="請說點什麼或貼上截圖")
    ids = await M.save_uploads(files, user) if files else []
    try:
        return await M.chat(request, text, ids)
    except (ValueError, RuntimeError) as e:
        _bad(e)


class RecordIn(BaseModel):
    pick: List[int]                                  # entry indexes
    edits: Dict[str, dict] = {}                      # index → {ref, note} changed by the person


async def _apply_record(entries: List[dict], body: RecordIn, uploads: List[int], request, snap_refs: Dict[str, dict]) -> List[dict]:
    chosen = []
    for i in body.pick:
        if not 0 <= i < len(entries) or entries[i].get("done"):
            continue
        e = dict(entries[i])
        ed = body.edits.get(str(i)) or {}
        if ed.get("ref") and ed["ref"] != e["ref"]:
            t = snap_refs.get(ed["ref"])
            if not t:
                raise HTTPException(status_code=400, detail="找不到要記錄的項目")
            e.update(ref=ed["ref"], card=t["card"], sub=t["sub"], title=t["title"])
        if ed.get("note"):
            e["note"] = str(ed["note"]).strip()[:4000]
        chosen.append((i, e))
    if not chosen:
        raise HTTPException(status_code=400, detail="請勾選要記錄的項目")
    done = await M.record([e for _, e in chosen], uploads, request)
    for (i, _), d in zip(chosen, done):
        entries[i] = d
    return entries


async def _refs(request) -> Dict[str, dict]:
    snap = await M.context(request)
    return {it["code"]: {"card": it["card"], "sub": it["id"] if it["kind"] == "sub" else None, "title": it["title"]} for it in snap["items"]}


@router.post("/messages/{mid}/record")
async def record_message(mid: int, body: RecordIn, request: Request):
    user = _member(request)
    db = await get_db()
    try:
        rows = await M._rows(db, "SELECT * FROM aipm_personal WHERE id = ? AND user_id IS ? AND role = 'aipm'", (mid, user.get("id")))
    finally:
        await db.close()
    if not rows:
        raise HTTPException(status_code=404, detail="找不到這則訊息")
    p = json.loads(rows[0]["payload"] or "{}")
    p["records"] = await _apply_record(p.get("records") or [], body, p.get("uploads") or [], request, await _refs(request))
    db = await get_db()
    try:
        await db.execute("UPDATE aipm_personal SET payload = ? WHERE id = ?", (json.dumps(p, ensure_ascii=False), mid))
        await db.commit()
    finally:
        await db.close()
    return {"records": p["records"]}


class MeetingIn(BaseModel):
    title: str = ""
    held_on: Optional[str] = None
    text: str
    project_id: Optional[int] = None

    @field_validator("text")
    @classmethod
    def v_text(cls, v):
        v = (v or "").strip()
        if len(v) < 10:
            raise ValueError("請貼上會議內容（筆記、逐字稿或重點）")
        return v[:60000]


@router.post("/meetings")
async def new_meeting(body: MeetingIn, request: Request):
    _member(request)
    held = body.held_on if body.held_on and len(body.held_on) == 10 else None
    try:
        return await M.meeting(request, body.title.strip()[:200], held, body.text, body.project_id)
    except (ValueError, RuntimeError) as e:
        _bad(e)


async def _meeting(mid: int, request) -> dict:
    user = _member(request)
    db = await get_db()
    try:
        rows = await M._rows(db, "SELECT * FROM aipm_meetings WHERE id = ?", (mid,))
    finally:
        await db.close()
    if not rows or not await M.meeting_visible(rows[0], user, await M.visible_cards(request)):
        raise HTTPException(status_code=404, detail="找不到這份會議紀錄，或你沒有權限看")
    m = rows[0]
    m["minutes"] = json.loads(m["minutes"] or "{}")
    m["cards"] = json.loads(m["cards"] or "[]")
    m["mine"] = m["user_id"] == user.get("id")
    return m


@router.get("/meetings/{mid}")
async def get_meeting(mid: int, request: Request):
    return await _meeting(mid, request)


@router.post("/meetings/{mid}/record")
async def record_meeting(mid: int, body: RecordIn, request: Request):
    m = await _meeting(mid, request)
    if not m["mine"]:
        raise HTTPException(status_code=403, detail="只有整理這份會議紀錄的人可以記錄到項目")
    mins = m["minutes"]
    mins["records"] = await _apply_record(mins.get("records") or [], body, [], request, await _refs(request))
    db = await get_db()
    try:
        await db.execute("UPDATE aipm_meetings SET minutes = ? WHERE id = ?", (json.dumps(mins, ensure_ascii=False), mid))
        await db.commit()
    finally:
        await db.close()
    return {"records": mins["records"]}


async def _closure(cid: int, request) -> dict:
    user = _member(request)
    db = await get_db()
    try:
        rows = await M._rows(db, "SELECT * FROM aipm_closures WHERE id = ?", (cid,))
        if not rows:
            raise HTTPException(status_code=404, detail="找不到這個結案對齊")
        c = rows[0]
        from .tasks import _get_visible
        await _get_visible(db, c["card_id"], user)
        if c["user_id"] != user.get("id"):
            root = (await aipm._root(db, c["card_id"]))["id"]
            if not await aipm.can_approve(db, root, user):
                raise HTTPException(status_code=403, detail="只有負責的人、專案負責人或看板管理人可以做結案對齊")
        return c
    finally:
        await db.close()


@router.post("/closures/{cid}/draft")
async def draft_closure(cid: int, request: Request):
    """AiPM drafts the 結案摘要 from the item's description and comments."""
    import asyncio
    c = await _closure(cid, request)
    user = request.state.user
    db = await get_db()
    try:
        if c["sub_id"]:
            rows = await M._rows(db, "SELECT body, created_at FROM task_comments WHERE id = ? OR parent_id = ? ORDER BY id", (c["sub_id"], c["sub_id"]))
        else:
            rows = await M._rows(db, "SELECT description AS body, created_at FROM tasks WHERE id = ?", (c["card_id"],))
            rows += await M._rows(db, "SELECT body, created_at FROM task_comments WHERE task_id = ? AND is_task = 0 ORDER BY id DESC LIMIT 40",
                                  (c["card_id"],))
        checks = await M.checklist(db, c)
    finally:
        await db.close()
    notes = "\n".join(f"- {str(r['created_at'])[:10]} {(r['body'] or '').strip()[:500]}" for r in rows if (r["body"] or "").strip())
    prompt = (f"項目「{c['title']}」已完成（{str(c['closed_at'] or '')[:10]}）。請根據下面的說明與紀錄，寫一段結案摘要（繁體中文，5–8 行）："
              f"做了什麼、結果、是否達到完成條件、留下了哪些紀錄、遺留事項或後續注意。不知道的不要編造，缺的寫「待補」。\n\n"
              f"檢查：{'；'.join(('✓' if x['ok'] else '✗') + x['text'] for x in checks)}\n\n說明與紀錄：\n{notes[:12000] or '（沒有）'}")
    try:
        text, model, _ = await asyncio.get_running_loop().run_in_executor(None, M._ask, prompt, M.MY_SYSTEM, user, "aipm_close", None)
    except (ValueError, RuntimeError) as e:
        _bad(e)
    return {"text": text.strip()[:3000], "model": model}


class AlignIn(BaseModel):
    summary: str

    @field_validator("summary")
    @classmethod
    def v_summary(cls, v):
        v = (v or "").strip()
        if len(v) < 4:
            raise ValueError("請寫一段結案摘要")
        return v[:3000]


@router.post("/closures/{cid}/align")
async def align_closure(cid: int, body: AlignIn, request: Request):
    """The 結案摘要 is kept as the person's own comment on the item (unless it is already in 歷史區)."""
    from datetime import datetime
    from .tasks import CommentIn, add_comment, is_history
    c = await _closure(cid, request)
    user = request.state.user
    db = await get_db()
    try:
        hist = await is_history(db, c["card_id"])
    finally:
        await db.close()
    if not hist:
        await add_comment(c["card_id"], CommentIn(body=f"【結案摘要】\n{body.summary}", parent_id=c["sub_id"]), request)
    db = await get_db()
    try:
        await db.execute("UPDATE aipm_closures SET aligned = 1, summary = ?, aligned_by = ?, aligned_at = ? WHERE id = ?",
                         (body.summary, user.get("id"), datetime.now().strftime("%Y-%m-%d %H:%M:%S"), cid))
        await db.commit()
    finally:
        await db.close()
    return {"ok": True}
