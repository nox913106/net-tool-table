"""
AI 接入點 API (app/ai.py).

  GET    /api/ai                         settings, services (no keys), presets — administrators
  PUT    /api/ai/settings                on/off, allow cloud, routing mode, limits, system prompt
  POST   /api/ai/providers               add a service       PUT /api/ai/providers/{pid}   change it
  DELETE /api/ai/providers/{pid}         remove it           POST /api/ai/providers/{pid}/test   one short test call
  POST   /api/ai/playground              ask the chosen services (備援 or 並行) and compare the answers
  GET    /api/ai/usage                   recent calls
  POST   /api/ai/ask                     for features and integrations: any signed-in user (not a guest), when AI is on
"""
import asyncio
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from .. import ai
from ..auth import current_user, require_admin

router = APIRouter(prefix="/api/ai", tags=["ai"])


class SettingsIn(BaseModel):
    enabled: Optional[bool] = None
    allow_cloud: Optional[bool] = None
    mode: Optional[str] = None
    timeout: Optional[int] = None
    max_output_tokens: Optional[int] = None
    temperature: Optional[float] = None
    system_prompt: Optional[str] = None
    images_to_cloud: Optional[bool] = None
    aipm_enabled: Optional[bool] = None
    aipm_patrol: Optional[str] = None
    aipm_daily: Optional[bool] = None


class ProviderIn(BaseModel):
    values: dict
    api_key: Optional[str] = None          # None = keep, "" = clear


class AskIn(BaseModel):
    prompt: str
    system: Optional[str] = None
    mode: Optional[str] = None             # fallback | parallel
    ids: Optional[List[int]] = None


def _run(fn, *a):
    return asyncio.get_running_loop().run_in_executor(None, fn, *a)


@router.get("")
async def overview(_: dict = Depends(require_admin)):
    s = ai.settings()
    rows = await _run(ai.providers)
    return {"settings": s, "providers": [ai.public(p, s) for p in rows], "presets": ai.PRESETS, "groups": ai.GROUPS,
            "kinds": ai.KINDS, "billing": ai.BILLING, "locations": ai.LOCATIONS,
            "usable": sum(1 for p in rows if not ai.blocked_reason(p, s))}


@router.put("/settings")
async def put_settings(body: SettingsIn, request: Request, _: dict = Depends(require_admin)):
    v = body.model_dump(exclude_none=True)
    if "mode" in v and v["mode"] not in ("fallback", "parallel"):
        raise HTTPException(status_code=400, detail="呼叫方式只能是備援或並行")
    if "timeout" in v and not 5 <= v["timeout"] <= 900:
        raise HTTPException(status_code=400, detail="逾時要在 5–900 秒之間")
    if "max_output_tokens" in v and not 64 <= v["max_output_tokens"] <= 128000:
        raise HTTPException(status_code=400, detail="輸出上限要在 64–128000 token 之間")
    if "temperature" in v and not 0 <= v["temperature"] <= 2:
        raise HTTPException(status_code=400, detail="溫度要在 0–2 之間")
    if "system_prompt" in v:
        v["system_prompt"] = v["system_prompt"][:8000]
    if "aipm_patrol" in v:
        import re
        m = re.match(r"^([01]?\d|2[0-3]):([0-5]\d)$", v["aipm_patrol"].strip())
        if not m:
            raise HTTPException(status_code=400, detail="巡檢時間格式是 HH:MM，例如 08:30")
        v["aipm_patrol"] = f"{int(m.group(1)):02d}:{m.group(2)}"
    old = ai.settings()
    s = ai.save_settings(v)
    request.state.audit_detail = "；".join(f"{k} {old[k]} → {s[k]}" for k in v if k != "system_prompt" and old[k] != s[k]) \
        + ("；系統提示詞已修改" if v.get("system_prompt") is not None and old["system_prompt"] != s["system_prompt"] else "")
    return s


@router.post("/providers")
async def add_provider(body: ProviderIn, request: Request, _: dict = Depends(require_admin)):
    try:
        p = await _run(ai.save_provider, None, body.values, body.api_key or None)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    request.state.audit_target = p["name"]
    request.state.audit_detail = f"{ai.LOCATIONS.get(p['location'])}／{ai.KINDS.get(p['kind'])}／{p.get('model') or p.get('deployment')}"
    return ai.public(p)


@router.put("/providers/{pid}")
async def change_provider(pid: int, body: ProviderIn, request: Request, _: dict = Depends(require_admin)):
    old = await _run(ai.provider, pid)
    if not old:
        raise HTTPException(status_code=404, detail="找不到這個 AI 服務")
    try:
        p = await _run(ai.save_provider, pid, body.values, body.api_key)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    request.state.audit_target = p["name"]
    changed = [k for k in ai.FIELDS if k in body.values and str(old.get(k)) != str(p.get(k))]
    request.state.audit_detail = ("修改 " + "、".join(changed) if changed else "") + ("；金鑰已更換" if body.api_key else "；金鑰已清除" if body.api_key == "" else "")
    return ai.public(p)


@router.delete("/providers/{pid}")
async def remove_provider(pid: int, request: Request, _: dict = Depends(require_admin)):
    p = await _run(ai.provider, pid)
    if not p:
        raise HTTPException(status_code=404, detail="找不到這個 AI 服務")
    await _run(ai.delete_provider, pid)
    request.state.audit_target = p["name"]
    return {"success": True}


@router.post("/providers/{pid}/test")
async def test_provider(pid: int, request: Request, user: dict = Depends(require_admin)):
    """A short call with a fixed prompt (no company data), even when the service or AI is switched off."""
    p = await _run(ai.provider, pid)
    if not p:
        raise HTTPException(status_code=404, detail="找不到這個 AI 服務")
    if ai.key_of(p) is None:
        raise HTTPException(status_code=400, detail="金鑰無法解密，請重新輸入")
    s = ai.settings()
    r = await _run(lambda: ai.call(p, "You are a connectivity test. Reply with one short sentence.", "請用一句繁體中文回覆：連線測試成功。",
                                   "test", user.get("id"), {"timeout": min(60, s["timeout"]), "max_output_tokens": 256, "temperature": 0}))
    request.state.audit_target = p["name"]
    return r


@router.post("/playground")
async def playground(body: AskIn, user: dict = Depends(require_admin)):
    if not body.prompt.strip():
        raise HTTPException(status_code=400, detail="請輸入要問的內容")
    try:
        return await _run(lambda: ai.ask(body.prompt[:50000], body.system, body.mode, body.ids, "playground", user.get("id"), True))
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/usage")
async def usage(_: dict = Depends(require_admin)):
    return await _run(ai.recent, 60)


@router.post("/ask")
async def ask(body: AskIn, user: dict = Depends(current_user)):
    if user.get("role") == "guest":
        raise HTTPException(status_code=403, detail="帳號尚未開通")
    if not body.prompt.strip():
        raise HTTPException(status_code=400, detail="請輸入要問的內容")
    try:
        return await _run(lambda: ai.ask(body.prompt[:50000], body.system, body.mode, body.ids, "ask", user.get("id")))
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ================================================================ AI 助理 (app/ai_assist.py)
def _member(user: dict):
    if user.get("role") == "guest":
        raise HTTPException(status_code=403, detail="帳號尚未開通")


def _ask(prompt: str, user: dict, purpose: str, system: Optional[str] = None, mode: Optional[str] = None) -> dict:
    try:
        return ai.ask(prompt, system, mode, None, purpose, user.get("id"))
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/status")
async def status(user: dict = Depends(current_user)):
    """Whether the AI features are on for this person (the pages show the AI buttons only then)."""
    s = ai.settings()
    n = len(await _run(ai.usable)) if s["enabled"] else 0
    return {"enabled": bool(s["enabled"] and n and user.get("role") != "guest"), "mode": s["mode"], "usable": n}


class ReportIn(BaseModel):
    kind: str                              # summary | blocked | week | next_week
    scope: str = "mine"                    # project | mine | all
    project_id: Optional[int] = None
    mode: Optional[str] = None


@router.post("/report")
async def report(body: ReportIn, request: Request, user: dict = Depends(current_user)):
    from .. import ai_assist as A
    _member(user)
    if body.kind not in A.KINDS or body.scope not in ("project", "mine", "all"):
        raise HTTPException(status_code=400, detail="報告類型或範圍無效")
    try:
        data = await A.collect(request, body.scope, body.project_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    from datetime import date
    today = date.today()
    data["lists"] = A.lists(data["items"], today)
    data["context"] = A._context(data["items"], today)
    header = {"project": f"範圍：專案「{data['project']}」與歸屬的卡片。", "mine": f"範圍：{user.get('display_name') or user.get('username')} 參與的工作。",
              "all": "範圍：我看得到的所有工作。"}[body.scope]
    if not data["items"]:
        return {"title": A.TITLES[body.kind], "lists": data["lists"], "result": None, "empty": True}
    prompt = A.build_report_prompt(body.kind, data, header)
    res = await _run(lambda: _ask(prompt, user, f"report:{body.kind}", None, body.mode))
    return {"title": A.TITLES[body.kind], "lists": data["lists"], "result": res}


class TaskSuggestIn(BaseModel):
    card_id: int
    comment_id: Optional[int] = None
    mode: Optional[str] = None


@router.post("/task-suggest")
async def task_suggest(body: TaskSuggestIn, request: Request, user: dict = Depends(current_user)):
    """One card or subtask: suggested content, execution flow, screenshots to keep as records."""
    from .. import ai_assist as A
    from ..database import get_db
    from .tasks import _get_visible
    _member(user)
    db = await get_db()
    try:
        t = await _get_visible(db, body.card_id, user)
        cur = await db.execute("SELECT id, title, body, task_parent_id FROM task_comments WHERE task_id = ? AND is_task = 1", (body.card_id,))
        subs = {r["id"]: dict(r) for r in await cur.fetchall()}
        proj = None
        if t.get("project_id"):
            cur = await db.execute("SELECT title FROM tasks WHERE id = ?", (t["project_id"],))
            r = await cur.fetchone()
            proj = r["title"] if r else None
    finally:
        await db.close()
    lines = [f"專案：{proj}" if proj else "", f"卡片：{t['title']}", f"卡片說明：{(t.get('description') or '').strip()[:1500]}" if t.get("description") else ""]
    if body.comment_id:
        s = subs.get(body.comment_id)
        if not s:
            raise HTTPException(status_code=404, detail="找不到這個子任務")
        chain, cid = [], s["task_parent_id"]
        while cid in subs and len(chain) < 20:
            chain.insert(0, subs[cid]["title"]); cid = subs[cid]["task_parent_id"]
        sib = [x["title"] for x in subs.values() if x["task_parent_id"] == s["task_parent_id"] and x["id"] != s["id"]][:20]
        body_txt = (s["body"] or "").strip()
        lines += [f"上層：{' › '.join(chain)}" if chain else "", f"這項工作：{s['title']}",
                  f"目前說明：{body_txt[:1500]}" if body_txt and body_txt != s["title"] else "",
                  f"同一層的其他工作：{'、'.join(sib)}" if sib else ""]
        target = s["title"]
    else:
        sib = [x["title"] for x in subs.values() if not x["task_parent_id"]][:30]
        lines += [f"底下的子任務：{'、'.join(sib)}" if sib else "", "這項工作：整張卡片"]
        target = t["title"]
    prompt = A.TASK_PROMPT + "\n\n" + "\n".join(x for x in lines if x)
    res = await _run(lambda: _ask(prompt, user, "task-suggest", None, body.mode))
    return {"target": target, "result": res}


class DraftIn(BaseModel):
    name: str
    brief: str = ""
    start: Optional[str] = None
    end: Optional[str] = None
    levels: int = 3
    mode: Optional[str] = None


@router.post("/project/draft")
async def project_draft(body: DraftIn, user: dict = Depends(current_user)):
    """生成專案: the AI's plan (one per model in 並行 mode), normalised, ready to preview."""
    from .. import ai_assist as A
    _member(user)
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="請輸入專案名稱")
    levels = max(2, min(5, body.levels))
    when = f"預計 {body.start or '近期'} 開始" + (f"、{body.end} 前完成" if body.end else "")
    prompt = A.PROJECT_PROMPT.replace("{levels}", str(levels)) + \
        f"\n\n專案名稱：{body.name.strip()[:200]}\n{when}\n需求與範圍：\n{body.brief.strip()[:6000] or '（未提供，請依名稱規劃常見的做法）'}"
    res = await _run(lambda: _ask(prompt, user, "project-draft", "你是資深的 IT 基礎建設專案經理，熟悉機房、網路、系統與資安專案的規劃與驗收。只輸出 JSON。", body.mode))
    drafts = []
    for r in res["results"]:
        d = {"name": r["name"], "model": r["model"], "ok": False, "error": r["error"], "latency_ms": r["latency_ms"]}
        if r["ok"]:
            try:
                d["plan"] = A.normalize_plan(A.parse_json(r["text"]), levels)
                d["ok"], d["error"] = True, None
            except ValueError as e:
                d["error"] = str(e)
        drafts.append(d)
    return {"drafts": drafts}


class CreateIn(BaseModel):
    plan: dict
    start: Optional[str] = None


@router.post("/project/create")
async def project_create(body: CreateIn, request: Request, user: dict = Depends(current_user)):
    """Create the previewed plan: a project card and its subtasks (through the Excel import pipeline, so the
    usual permissions apply), then each item's content, flow and screenshot list as its description."""
    from datetime import date
    from .. import ai_assist as A
    from .tasks import CommentEdit, TaskUpdate, _import_apply, _import_plan, edit_comment, update_task
    _member(user)
    try:
        plan = A.normalize_plan(body.plan, 6)
        start = date.fromisoformat(body.start) if body.start else date.today()
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=str(e) or "日期格式錯誤")
    items = A.plan_items(plan, start)
    texts = [it.pop("_text", "") for it in items]
    rows = await _import_plan(items, user)
    bad = [e for o in rows for e in o["errors"]]
    if bad:
        raise HTTPException(status_code=400, detail="無法建立：" + "；".join(dict.fromkeys(bad))[:300])
    await _import_apply(rows, request)
    card = next((o for o in rows if o["kind"] == "card"), None)
    if not card or not card.get("id"):
        raise HTTPException(status_code=400, detail="專案卡沒有建立")
    cid = int(card["id"][1:])
    desc = plan["description"] + "\n\n（由 AI 助理生成，請檢查後調整）"
    await update_task(cid, TaskUpdate(description=desc.strip()[:5000]), request)
    for o, txt in zip(rows, texts):
        if o["kind"] == "sub" and o.get("id") and txt:
            try:
                await edit_comment(cid, int(o["id"][1:]), CommentEdit(body=txt), request)
            except HTTPException:
                pass
    request.state.audit_target = plan["title"]
    request.state.audit_detail = f"AI 生成專案，{sum(1 for o in rows if o['kind'] == 'sub')} 項工作"
    return {"id": cid, "items": sum(1 for o in rows if o.get("id")), "errors": [e for o in rows for e in o["errors"]]}
