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
