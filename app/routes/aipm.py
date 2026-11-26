"""
AiPM API (app/aipm.py).

  GET  /api/aipm/inbox                     my questions from AiPM and the projects with suggestions waiting
  GET  /api/aipm/{card_id}                 the conversation, open items, what the system sees, the items to point at
  POST /api/aipm/{card_id}/chat            the engineer's note + screenshots (also kept as a comment) → AiPM's review
  POST /api/aipm/{card_id}/review          ask AiPM to look at the project now
  POST /api/aipm/items/{id}/apply          採用 a suggested change          POST .../dismiss   略過
  POST /api/aipm/items/{id}/undo           復原 a change                     POST .../resolve   追蹤事項完成
  POST /api/aipm/items/{id}/answer         answer AiPM's question (kept as a comment; AiPM reviews again)

Every change uses the board's route functions with the caller's request, so the usual permissions apply.
"""
import json
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, field_validator

from .. import ai, aipm
from ..auth import current_user
from ..database import get_db

router = APIRouter(prefix="/api/aipm", tags=["aipm"])


def _member(user: dict):
    if user.get("role") == "guest":
        raise HTTPException(status_code=403, detail="帳號尚未開通")


async def _visible_root(card_id: int, user: dict) -> dict:
    from .tasks import _get_visible, is_history
    db = await get_db()
    try:
        await _get_visible(db, card_id, user)
        try:
            root = await aipm._root(db, card_id)
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))
        await _get_visible(db, root["id"], user)
        root["history"] = await is_history(db, root["id"])
        return root
    finally:
        await db.close()


def _plain(v):
    return v.isoformat() if hasattr(v, "isoformat") else v


def _item(r: dict) -> dict:
    out = dict(r)
    for k in ("action", "undo", "options"):
        try:
            out[k] = json.loads(r[k]) if r.get(k) else None
        except ValueError:
            out[k] = None
    if out.get("undo"):
        out["undo"] = True                                    # the old text stays on the server
    return out


async def state(root: dict, request: Request) -> dict:
    user = request.state.user
    try:
        snap = await aipm.snapshot(request, root["id"])
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM aipm_messages WHERE card_id = ? ORDER BY id DESC LIMIT 60", (root["id"],))
        msgs = [dict(r) for r in await cur.fetchall()][::-1]
        cur = await db.execute("""SELECT * FROM aipm_items WHERE card_id = ? AND (status = 'pending' OR id IN
                                      (SELECT id FROM aipm_items WHERE card_id = ? AND status != 'pending' ORDER BY id DESC LIMIT 40))
                                  ORDER BY id DESC""", (root["id"], root["id"]))
        items = [_item(dict(r)) for r in await cur.fetchall()]
        cur = await db.execute("SELECT * FROM aipm_runs WHERE card_id = ?", (root["id"],))
        run = await cur.fetchone()
        uids = {m["user_id"] for m in msgs if m["user_id"]} | {i["assignee_id"] for i in items if i.get("assignee_id")} \
            | {i["done_by"] for i in items if i.get("done_by")}
        names = {}
        if uids:
            cur = await db.execute(f"SELECT id, username, display_name FROM users WHERE id IN ({','.join('?' * len(uids))})", list(uids))
            names = {r["id"]: r["display_name"] or r["username"] for r in await cur.fetchall()}
    finally:
        await db.close()
    for m in msgs:
        m["payload"] = json.loads(m["payload"]) if m.get("payload") else None
        m["images"] = json.loads(m["images"]) if m.get("images") else []
        m["who"] = names.get(m["user_id"]) if m["user_id"] else None
    for i in items:
        i["assignee"] = names.get(i.get("assignee_id"))
        i["done_by_name"] = names.get(i.get("done_by"))
    s = ai.settings()
    pool = ai.usable() if s["enabled"] else []
    return {"root": {k: root[k] for k in ("id", "title", "kind", "status")}, "history": root.get("history", False),
            "enabled": aipm.enabled() and bool(pool), "me": user.get("id"),
            "vision": any(ai.sees_images(p, s) for p in pool), "auto_low": bool(s.get("aipm_auto_low", True)),
            "patrol": s.get("aipm_patrol") or "08:30",
            "run": dict(run) if run else None, "messages": msgs, "items": items, "signals": snap["signals"],
            "targets": [{"code": it["code"], "title": it["title"], "kind": it["kind"], "card": it["card"],
                         "sub": it["id"] if it["kind"] == "sub" else None, "level": it["level"], "status": it["status"]}
                        for it in snap["items"]],
            "counts": A_counts(snap)}


def A_counts(snap) -> dict:
    from ..ai_assist import lists
    return lists(snap["items"], snap["today"])["counts"]


@router.get("/inbox")
async def inbox(request: Request):
    user = current_user(request)
    me = user.get("id")
    db = await get_db()
    try:
        cur = await db.execute("""SELECT i.id, i.card_id, i.title, i.code, i.options, i.created_at, t.title AS card_title
                                  FROM aipm_items i JOIN tasks t ON t.id = i.card_id
                                  WHERE i.kind = 'question' AND i.status = 'pending' AND i.assignee_id IS ? ORDER BY i.id DESC LIMIT 30""", (me,))
        questions = [dict(r) for r in await cur.fetchall()]
        cur = await db.execute("""SELECT i.card_id, t.title, COUNT(*) AS n FROM aipm_items i JOIN tasks t ON t.id = i.card_id
                                  WHERE i.kind = 'proposal' AND i.status = 'pending' AND (t.owner_id IS ?
                                     OR t.id IN (SELECT task_id FROM task_members WHERE user_id IS ? AND role = 'assignee'))
                                  GROUP BY i.card_id ORDER BY MAX(i.id) DESC LIMIT 20""", (me, me))
        projects = [dict(r) for r in await cur.fetchall()]
    finally:
        await db.close()
    for q in questions:
        q["options"] = json.loads(q["options"]) if q.get("options") else []
    return {"enabled": aipm.enabled(), "questions": questions, "projects": projects}


@router.get("/{card_id}")
async def get_state(card_id: int, request: Request):
    user = current_user(request)
    _member(user)
    root = await _visible_root(card_id, user)
    return await state(root, request)


class ChatIn(BaseModel):
    text: str = ""
    images: List[int] = []
    card: Optional[int] = None             # the item the note is about (a card of this project)
    sub: Optional[int] = None              # … or one of its subtasks
    code: Optional[str] = None
    record: bool = True                    # also keep it as a comment on that item

    @field_validator("text")
    @classmethod
    def v_text(cls, v):
        return (v or "").strip()[:4000]


def _fail(e):
    raise HTTPException(status_code=400, detail=aipm._err(e))


@router.post("/{card_id}/chat")
async def chat(card_id: int, body: ChatIn, request: Request):
    from .tasks import CommentIn, add_comment, _comment
    user = current_user(request)
    _member(user)
    root = await _visible_root(card_id, user)
    if root["history"]:
        raise HTTPException(status_code=403, detail="歷史區的專案不能再修改")
    if not body.text and not body.images:
        raise HTTPException(status_code=400, detail="請描述一下狀況或貼上截圖")
    target = body.card or root["id"]
    tr = await _visible_root(target, user)
    if tr["id"] != root["id"]:
        raise HTTPException(status_code=400, detail="這個項目不屬於這個專案")
    if body.sub:
        db = await get_db()
        try:
            c = await _comment(db, target, body.sub)
            if not c["is_task"]:
                raise HTTPException(status_code=400, detail="只能指向子任務")
        finally:
            await db.close()
    if body.record:
        await add_comment(target, CommentIn(body=body.text, images=body.images, parent_id=body.sub), request)
    db = await get_db()
    try:
        pics = await aipm.load_images(db, target, body.images, user)
    finally:
        await db.close()
    msg = {"text": body.text, "code": body.code, "images": len(pics), "image_ids": [{"id": i, "task": target} for i in body.images]}
    try:
        res = await aipm.review(root["id"], request, "chat", msg, pics)
    except (ValueError, RuntimeError) as e:
        _fail(e)
    out = await state(root, request)
    out["result"] = res
    return out


@router.post("/{card_id}/review")
async def review_now(card_id: int, request: Request):
    user = current_user(request)
    _member(user)
    root = await _visible_root(card_id, user)
    if root["history"]:
        raise HTTPException(status_code=403, detail="歷史區的專案不能再修改")
    try:
        res = await aipm.review(root["id"], request, "manual")
    except (ValueError, RuntimeError) as e:
        _fail(e)
    out = await state(root, request)
    out["result"] = res
    return out


async def _load_item(item_id: int, user: dict):
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM aipm_items WHERE id = ?", (item_id,))
        r = await cur.fetchone()
    finally:
        await db.close()
    if not r:
        raise HTTPException(status_code=404, detail="找不到這個項目")
    root = await _visible_root(r["card_id"], user)
    return dict(r), root


@router.post("/items/{item_id}/apply")
async def apply_item(item_id: int, request: Request):
    user = current_user(request)
    _member(user)
    it, root = await _load_item(item_id, user)
    if it["kind"] != "proposal" or it["status"] != "pending":
        raise HTTPException(status_code=400, detail="這個建議已經處理過了")
    try:
        undo = await aipm.apply_action(json.loads(it["action"]), request)
    except (ValueError, HTTPException) as e:
        await aipm._set(item_id, error=aipm._err(e)[:300])
        _fail(e)
    await aipm._set(item_id, status="applied", undo=json.dumps(undo, ensure_ascii=False), done_by=user.get("id"), error=None)
    return await state(root, request)


@router.post("/items/{item_id}/undo")
async def undo_item(item_id: int, request: Request):
    user = current_user(request)
    _member(user)
    it, root = await _load_item(item_id, user)
    if it["kind"] != "proposal" or it["status"] not in ("applied", "auto") or not it.get("undo"):
        raise HTTPException(status_code=400, detail="這個變更不能復原")
    try:
        await aipm.undo_action(json.loads(it["action"]), json.loads(it["undo"]), request)
    except (ValueError, HTTPException) as e:
        _fail(e)
    await aipm._set(item_id, status="undone", done_by=user.get("id"))
    return await state(root, request)


@router.post("/items/{item_id}/dismiss")
async def dismiss_item(item_id: int, request: Request):
    user = current_user(request)
    _member(user)
    it, root = await _load_item(item_id, user)
    if it["status"] != "pending":
        raise HTTPException(status_code=400, detail="這個項目已經處理過了")
    await aipm._set(item_id, status="dismissed", done_by=user.get("id"))
    return await state(root, request)


@router.post("/items/{item_id}/resolve")
async def resolve_item(item_id: int, request: Request):
    user = current_user(request)
    _member(user)
    it, root = await _load_item(item_id, user)
    if it["kind"] != "tracking" or it["status"] != "pending":
        raise HTTPException(status_code=400, detail="這個項目已經處理過了")
    await aipm._set(item_id, status="resolved", done_by=user.get("id"))
    return await state(root, request)


class AnswerIn(BaseModel):
    text: str

    @field_validator("text")
    @classmethod
    def v_text(cls, v):
        v = (v or "").strip()[:2000]
        if not v:
            raise ValueError("請輸入回答")
        return v


@router.post("/items/{item_id}/answer")
async def answer_item(item_id: int, body: AnswerIn, request: Request):
    from .tasks import CommentIn, add_comment
    user = current_user(request)
    _member(user)
    it, root = await _load_item(item_id, user)
    if it["kind"] != "question" or it["status"] != "pending":
        raise HTTPException(status_code=400, detail="這個問題已經回答過了")
    await aipm._set(item_id, status="answered", answer=body.text, done_by=user.get("id"))
    text = f"回覆 AiPM 的問題「{it['title']}」：{body.text}"
    if not root["history"]:
        try:
            await add_comment(it["target_card"] or root["id"], CommentIn(body=text, parent_id=it["target_sub"]), request)
        except HTTPException:
            pass
    out_err = None
    try:
        await aipm.review(root["id"], request, "chat", {"text": text, "code": it["code"], "images": 0})
    except (ValueError, RuntimeError) as e:
        out_err = aipm._err(e)
    out = await state(root, request)
    out["warning"] = out_err
    return out
