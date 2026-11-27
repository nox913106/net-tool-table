"""
AI 接入點 (後台「系統設定 → AI 接入點」): any number of AI services, cloud and on-premises, used one after
another (備援) or all at once (並行) — the same design as CFXD_DailyReportDocSys's app/ai_providers.py.

Five call protocols (kind) cover every way in:
  openai        OpenAI-compatible Chat Completions: OpenAI, Mistral, DeepSeek, xAI, OpenRouter, Groq, Together,
                company AI gateways (LiteLLM …), and on-premises Ollama, LM Studio, vLLM, llama.cpp, LocalAI
  azure_openai  Azure OpenAI (pay as you go or PTU)
  anthropic     Anthropic Claude API (the official `anthropic` SDK)
  gemini        Google Gemini API
  bedrock       AWS Bedrock Converse API (Bedrock API key)

location: cloud (data leaves the company — only used when 「允許雲端」 is on) or onprem (stays inside).
billing:  token (per token, optional budget per period), monthly (fixed fee, optional token quota),
          self_hosted (no per-call cost; an optional monthly cost for comparison).
Routing (settings.mode): fallback — the first usable service by priority, the next one when it fails or is
over budget; parallel — every usable service at once, each answer returned (to compare or combine models).

API keys are encrypted with the system key (app/sysconfig.py), never returned. Every call is logged in ai_usage
(tokens, cost, latency, error). Tables are local to each copy and never synced.
"""
import json
import re
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, datetime
from typing import List, Optional

from . import sysconfig
from .database import DB_PATH

CONF_KEY = "_ai"
KINDS = {"openai": "OpenAI 相容 API", "azure_openai": "Azure OpenAI", "anthropic": "Anthropic Claude API",
         "gemini": "Google Gemini API", "bedrock": "AWS Bedrock"}
LOCATIONS = {"cloud": "雲端", "onprem": "地端"}
BILLING = {"token": "按量計費（token）", "monthly": "包月（固定月費）", "self_hosted": "自建主機"}
TOKEN_PARAMS = ("max_tokens", "max_completion_tokens", "none")

P = dict
# Presets: the defaults a new service starts from. Prices change: only Claude's are filled in.
PRESETS = {
    # ---- 雲端：按量
    "anthropic": P(group="cloud_token", label="Anthropic Claude API", kind="anthropic", vision=1, model="claude-opus-5-5",
                   price_in=4.0, price_out=20.0, hint="預設 Claude Opus 5.5（每 100 萬 token：input US$4、output US$20）；也可填 claude-sonnet-5-5、claude-haiku-5-5"),
    "openai": P(group="cloud_token", label="OpenAI API", kind="openai", vision=1, base_url="https://api.openai.com/v1",
                token_param="max_completion_tokens", hint="模型名稱依 OpenAI 文件填寫"),
    "gemini": P(group="cloud_token", label="Google Gemini API", kind="gemini", vision=1, base_url="https://generativelanguage.googleapis.com",
                hint="模型名稱依 Google AI Studio 文件填寫"),
    "azure_openai": P(group="cloud_token", label="Azure OpenAI（按量）", kind="azure_openai", vision=1, base_url="https://<資源名稱>.openai.azure.com",
                      api_version="2024-10-21", token_param="max_completion_tokens", hint="填部署名稱（deployment），模型名稱可留空"),
    "bedrock": P(group="cloud_token", label="AWS Bedrock（按量）", kind="bedrock", region="ap-northeast-1",
                 hint="填 Bedrock 模型 ID 或推論設定檔 ID；金鑰使用 Bedrock API 金鑰"),
    "mistral": P(group="cloud_token", label="Mistral AI", kind="openai", base_url="https://api.mistral.ai/v1"),
    "deepseek": P(group="cloud_token", label="DeepSeek", kind="openai", base_url="https://api.deepseek.com/v1"),
    "xai": P(group="cloud_token", label="xAI Grok", kind="openai", base_url="https://api.x.ai/v1"),
    "openrouter": P(group="cloud_token", label="OpenRouter（多家模型）", kind="openai", base_url="https://openrouter.ai/api/v1"),
    "groq": P(group="cloud_token", label="Groq", kind="openai", base_url="https://api.groq.com/openai/v1"),
    "together": P(group="cloud_token", label="Together AI", kind="openai", base_url="https://api.together.xyz/v1"),
    "custom_cloud": P(group="cloud_token", label="其他 OpenAI 相容服務（雲端）", kind="openai", base_url=""),
    # ---- 雲端：包月
    "azure_ptu": P(group="cloud_monthly", label="Azure OpenAI PTU（預留容量）", kind="azure_openai", billing="monthly",
                   base_url="https://<資源名稱>.openai.azure.com", api_version="2024-10-21", token_param="max_completion_tokens",
                   hint="Provisioned Throughput：按月計費，填月費與部署名稱"),
    "bedrock_pt": P(group="cloud_monthly", label="AWS Bedrock Provisioned Throughput", kind="bedrock", billing="monthly",
                    region="ap-northeast-1", hint="模型 ID 填 Provisioned Throughput 的 ARN"),
    "anthropic_commit": P(group="cloud_monthly", label="Anthropic Claude（企業包月／預付）", kind="anthropic", vision=1, billing="monthly",
                          model="claude-opus-5-5", hint="預付或承諾用量合約：填月費與額度；呼叫方式與 Claude API 相同"),
    # ---- 地端（資料不離開公司）
    "gateway": P(group="onprem", label="公司 AI 閘道（OpenAI 相容，例如 LiteLLM）", kind="openai", location="onprem", billing="monthly",
                 base_url="", hint="閘道後面可以接多個雲端或地端模型；依合約填月費與每月 token 額度"),
    "ollama": P(group="onprem", label="Ollama", kind="openai", location="onprem", billing="self_hosted",
                base_url="http://ai-host:11434/v1", hint="例如 qwen3:32b、llama3.3:70b"),
    "lmstudio": P(group="onprem", label="LM Studio", kind="openai", location="onprem", billing="self_hosted", base_url="http://ai-host:1234/v1"),
    "vllm": P(group="onprem", label="vLLM", kind="openai", location="onprem", billing="self_hosted", base_url="http://ai-host:8000/v1"),
    "llamacpp": P(group="onprem", label="llama.cpp server", kind="openai", location="onprem", billing="self_hosted", base_url="http://ai-host:8080/v1"),
    "localai": P(group="onprem", label="LocalAI", kind="openai", location="onprem", billing="self_hosted", base_url="http://ai-host:8080/v1"),
    "custom_onprem": P(group="onprem", label="其他地端 OpenAI 相容服務", kind="openai", location="onprem", billing="self_hosted", base_url=""),
}
GROUPS = {"cloud_token": "雲端：按量計費", "cloud_monthly": "雲端：包月／預留容量", "onprem": "地端：自建主機與公司閘道"}

DEFAULTS = {"enabled": False, "allow_cloud": False, "mode": "fallback", "timeout": 120, "max_output_tokens": 16000,
            "temperature": 0.2, "images_to_cloud": False,
            "aipm_enabled": True, "aipm_patrol": "08:30", "aipm_daily": True, "aipm_autostart": True, "system_prompt": "你是 IPMS（基礎建設專案管理系統）的助理。用繁體中文，簡潔、條列，只根據提供的內容回答，不要編造。"}
FIELDS = {  # column: (type, default)
    "name": (str, ""), "preset": (str, ""), "kind": (str, "openai"), "location": (str, "cloud"), "billing": (str, "token"),
    "base_url": (str, ""), "model": (str, ""), "deployment": (str, ""), "api_version": (str, ""), "region": (str, ""),
    "token_param": (str, "max_tokens"), "send_temperature": (int, 1), "extra_body": (str, ""), "enabled": (int, 1),
    "priority": (int, 100), "price_in": (float, 0.0), "price_out": (float, 0.0), "currency": (str, "USD"),
    "monthly_budget": (float, 0.0), "monthly_fee": (float, 0.0), "monthly_token_quota": (int, 0), "reset_day": (int, 1),
    "note": (str, ""), "vision": (int, 0),
}


# ---------------------------------------------------------------- storage
async def ensure(db):
    cols = ", ".join(f"{k} {'INTEGER' if t is int else 'REAL' if t is float else 'TEXT'} DEFAULT {json.dumps(d) if t is str else d}"
                     for k, (t, d) in FIELDS.items())
    await db.execute(f"CREATE TABLE IF NOT EXISTS ai_providers (id INTEGER PRIMARY KEY AUTOINCREMENT, {cols}, api_key_enc TEXT, "
                     "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP)")
    cur = await db.execute("PRAGMA table_info(ai_providers)")
    have = {r[1] for r in await cur.fetchall()}
    for k, (t, d) in FIELDS.items():                     # columns added in later versions (vision …)
        if k not in have:
            await db.execute(f"ALTER TABLE ai_providers ADD COLUMN {k} {'INTEGER' if t is int else 'REAL' if t is float else 'TEXT'} "
                             f"DEFAULT {json.dumps(d) if t is str else d}")
    await db.execute("""CREATE TABLE IF NOT EXISTS ai_usage (id INTEGER PRIMARY KEY AUTOINCREMENT,
                            at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime')),
                            provider_id INTEGER, provider_name TEXT, model TEXT, purpose TEXT, user_id INTEGER,
                            ok INTEGER NOT NULL DEFAULT 0, error TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
                            cost REAL DEFAULT 0, currency TEXT, latency_ms INTEGER)""")
    await db.execute("CREATE INDEX IF NOT EXISTS idx_ai_usage ON ai_usage(provider_id, at)")


def _con():
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    return con


def settings() -> dict:
    s = sysconfig._read(CONF_KEY)
    return {k: s.get(k, v) for k, v in DEFAULTS.items()}


def save_settings(values: dict) -> dict:
    cur = settings()
    for k, v in values.items():
        if k in DEFAULTS:
            cur[k] = v
    sysconfig._write(CONF_KEY, cur)
    return cur


def clean(values: dict) -> dict:
    out = {}
    for k, (t, d) in FIELDS.items():
        if k not in values or values[k] is None:
            continue
        v = values[k]
        try:
            out[k] = t(bool(v)) if t is int and isinstance(v, bool) else t(v)
        except (TypeError, ValueError):
            raise ValueError(f"欄位「{k}」格式不對")
        if t is str:
            out[k] = out[k].strip()[:4000]
    if "kind" in out and out["kind"] not in KINDS:
        raise ValueError("呼叫協定無效")
    if "location" in out and out["location"] not in LOCATIONS:
        raise ValueError("位置只能是雲端或地端")
    if "billing" in out and out["billing"] not in BILLING:
        raise ValueError("計費方式無效")
    if "token_param" in out and out["token_param"] not in TOKEN_PARAMS:
        raise ValueError("輸出上限參數無效")
    if out.get("base_url") and not re.match(r"^https?://", out["base_url"]):
        raise ValueError("服務網址要以 http:// 或 https:// 開頭")
    if out.get("extra_body"):
        try:
            if not isinstance(json.loads(out["extra_body"]), dict):
                raise ValueError
        except ValueError:
            raise ValueError("額外參數必須是 JSON 物件，例如 {\"top_p\": 0.9}")
    if "reset_day" in out:
        out["reset_day"] = min(max(out["reset_day"], 1), 28)
    return out


def providers() -> List[dict]:
    con = _con()
    try:
        return [dict(r) for r in con.execute("SELECT * FROM ai_providers ORDER BY priority, id")]
    finally:
        con.close()


def provider(pid: int) -> Optional[dict]:
    con = _con()
    try:
        r = con.execute("SELECT * FROM ai_providers WHERE id = ?", (pid,)).fetchone()
        return dict(r) if r else None
    finally:
        con.close()


def save_provider(pid: Optional[int], values: dict, api_key: Optional[str]) -> dict:
    """api_key: None = keep the stored one, "" = clear, anything else = replace (encrypted)."""
    v = clean(values)
    con = _con()
    try:
        if api_key is not None:
            v["api_key_enc"] = sysconfig.encrypt(api_key, "ai-key") if api_key else None
        if pid:
            if v:
                con.execute(f"UPDATE ai_providers SET {', '.join(k + ' = ?' for k in v)}, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                            (*v.values(), pid))
        else:
            if not v.get("name"):
                raise ValueError("請填名稱")
            cur = con.execute(f"INSERT INTO ai_providers ({', '.join(v)}) VALUES ({', '.join('?' * len(v))})", tuple(v.values()))
            pid = cur.lastrowid
        con.commit()
    finally:
        con.close()
    return provider(pid)


def delete_provider(pid: int):
    con = _con()
    try:
        con.execute("DELETE FROM ai_providers WHERE id = ?", (pid,))
        con.commit()
    finally:
        con.close()


def key_of(p: dict) -> Optional[str]:
    """The decrypted key; '' when none is set, None when it cannot be decrypted (key file replaced)."""
    if not p.get("api_key_enc"):
        return ""
    return sysconfig.decrypt(p["api_key_enc"], "ai-key") or None


# ---------------------------------------------------------------- billing and limits
def period_start(p: dict, today: Optional[date] = None) -> str:
    today = today or date.today()
    day = min(max(p.get("reset_day") or 1, 1), 28)
    if today.day >= day:
        return f"{today.year:04d}-{today.month:02d}-{day:02d} 00:00:00"
    y, m = (today.year - 1, 12) if today.month == 1 else (today.year, today.month - 1)
    return f"{y:04d}-{m:02d}-{day:02d} 00:00:00"


def period_usage(p: dict) -> dict:
    con = _con()
    try:
        r = con.execute("""SELECT COUNT(*), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cost), 0),
                                  COALESCE(SUM(ok), 0) FROM ai_usage WHERE provider_id = ? AND at >= ?""", (p["id"], period_start(p))).fetchone()
    finally:
        con.close()
    calls, tin, tout, cost, ok = r
    return {"calls": calls, "ok": ok, "input": tin, "output": tout, "tokens": tin + tout, "cost": round(float(cost), 4),
            "since": period_start(p)[:10]}


def cost_of(p: dict, tin: int, tout: int) -> float:
    if p.get("billing") != "token":
        return 0.0
    return round((tin * (p.get("price_in") or 0) + tout * (p.get("price_out") or 0)) / 1_000_000, 6)


def blocked_reason(p: dict, s: Optional[dict] = None, usage: Optional[dict] = None) -> str:
    """Why this service cannot be used right now ('' = usable)."""
    s = s or settings()
    if not p.get("enabled"):
        return "已停用"
    if p.get("location") == "cloud" and not s["allow_cloud"]:
        return "雲端服務：尚未允許把資料送到公司外部"
    if key_of(p) is None:
        return "金鑰無法解密（加密金鑰可能已更換），請重新輸入"
    if p["kind"] == "azure_openai" and not p.get("deployment"):
        return "沒有填部署名稱"
    if p["kind"] != "azure_openai" and not p.get("model"):
        return "沒有填模型名稱"
    if p["kind"] in ("openai", "azure_openai") and not p.get("base_url"):
        return "沒有填服務網址"
    usage = usage or period_usage(p)
    if p.get("billing") == "token" and p.get("monthly_budget") and usage["cost"] >= p["monthly_budget"]:
        return f"本期費用 {usage['cost']:.2f} 已達預算上限 {p['monthly_budget']:g} {p.get('currency') or ''}"
    if p.get("billing") == "monthly" and p.get("monthly_token_quota") and usage["tokens"] >= p["monthly_token_quota"]:
        return f"本期已用 {usage['tokens']:,} token，達到額度 {p['monthly_token_quota']:,}"
    return ""


def usable(ids: Optional[List[int]] = None) -> List[dict]:
    s = settings()
    return [p for p in providers() if (not ids or p["id"] in ids) and not blocked_reason(p, s)]


# ---------------------------------------------------------------- calling
@dataclass
class Reply:
    text: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0


def _post(url, body, headers, timeout):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}：{e.read()[:300].decode('utf-8', 'replace')}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"無法連線：{e.reason}") from e
    except TimeoutError as e:
        raise RuntimeError("逾時，服務沒有在時間內回覆") from e


def _extra(p):
    return json.loads(p["extra_body"]) if (p.get("extra_body") or "").strip() else {}


def _images(o):
    return o.get("images") or []


def _openai_body(p, system, user, o):
    content = user
    if _images(o):
        content = [{"type": "text", "text": user}] + [
            {"type": "image_url", "image_url": {"url": f"data:{im['mime']};base64,{im['data']}"}} for im in _images(o)]
    body = {"messages": [{"role": "system", "content": system}, {"role": "user", "content": content}], "stream": False}
    if p.get("send_temperature"):
        body["temperature"] = o["temperature"]
    if p.get("token_param") in ("max_tokens", "max_completion_tokens"):
        body[p["token_param"]] = o["max_output_tokens"]
    return body


def _openai_reply(data, fallback):
    choice = (data.get("choices") or [{}])[0]
    u = data.get("usage") or {}
    return Reply((choice.get("message") or {}).get("content") or "", data.get("model") or fallback,
                 u.get("prompt_tokens", 0), u.get("completion_tokens", 0))


def call_openai(p, key, system, user, o):
    body = {"model": p["model"], **_openai_body(p, system, user, o), **_extra(p)}
    data = _post(p["base_url"].rstrip("/") + "/chat/completions", body, {"Authorization": f"Bearer {key}"} if key else {}, o["timeout"])
    return _openai_reply(data, p["model"])


def call_azure(p, key, system, user, o):
    url = (f"{p['base_url'].rstrip('/')}/openai/deployments/{urllib.parse.quote(p['deployment'])}/chat/completions"
           f"?api-version={urllib.parse.quote(p.get('api_version') or '2024-10-21')}")
    data = _post(url, {**_openai_body(p, system, user, o), **_extra(p)}, {"api-key": key}, o["timeout"])
    return _openai_reply(data, p.get("model") or p["deployment"])


# Claude models that support the API's server-side fallback (a declined request re-runs on another model)
CLAUDE_FALLBACK_MODELS = ("claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5")


def call_anthropic(p, key, system, user, o):
    import anthropic
    client = anthropic.Anthropic(api_key=key or None, base_url=p.get("base_url") or None, timeout=o["timeout"], max_retries=1)
    kwargs = dict(model=p["model"], max_tokens=o["max_output_tokens"], system=system,
                  messages=[{"role": "user", "content": [
                      *({"type": "image", "source": {"type": "base64", "media_type": im["mime"], "data": im["data"]}} for im in _images(o)),
                      {"type": "text", "text": user}]}], **_extra(p))
    try:
        if p["model"] in CLAUDE_FALLBACK_MODELS and not p.get("base_url"):
            resp = client.beta.messages.create(**kwargs, betas=["server-side-fallback-2026-07-01"], fallbacks="default")
        else:
            resp = client.messages.create(**kwargs)
    except anthropic.AuthenticationError as e:
        raise RuntimeError("Claude API 金鑰無效") from e
    except anthropic.PermissionDeniedError as e:
        raise RuntimeError("Claude API 金鑰沒有權限") from e
    except anthropic.NotFoundError as e:
        raise RuntimeError(f"找不到模型 {p['model']}") from e
    except anthropic.RateLimitError as e:
        raise RuntimeError("Claude API 超過速率限制，請稍後再試") from e
    except anthropic.APIStatusError as e:
        raise RuntimeError(f"Claude API HTTP {e.status_code}：{e.message}") from e
    except anthropic.APIConnectionError as e:
        raise RuntimeError(f"無法連線到 Claude API：{e}") from e
    if resp.stop_reason == "refusal":
        raise RuntimeError("Claude 拒絕回覆這次的內容")
    text = "".join(b.text for b in resp.content if b.type == "text")
    u = resp.usage
    tin = (u.input_tokens or 0) + (getattr(u, "cache_read_input_tokens", 0) or 0) + (getattr(u, "cache_creation_input_tokens", 0) or 0)
    return Reply(text, resp.model, tin, u.output_tokens or 0)


def call_gemini(p, key, system, user, o):
    url = f"{(p.get('base_url') or 'https://generativelanguage.googleapis.com').rstrip('/')}/v1beta/models/{urllib.parse.quote(p['model'])}:generateContent"
    cfg = {"maxOutputTokens": o["max_output_tokens"]}
    if p.get("send_temperature"):
        cfg["temperature"] = o["temperature"]
    body = {"systemInstruction": {"parts": [{"text": system}]}, "contents": [{"role": "user", "parts": [
                *({"inline_data": {"mime_type": im["mime"], "data": im["data"]}} for im in _images(o)), {"text": user}]}],
            "generationConfig": cfg, **_extra(p)}
    data = _post(url, body, {"x-goog-api-key": key}, o["timeout"])
    parts = ((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
    u = data.get("usageMetadata") or {}
    return Reply("".join(x.get("text", "") for x in parts), data.get("modelVersion") or p["model"],
                 u.get("promptTokenCount", 0), u.get("candidatesTokenCount", 0))


def call_bedrock(p, key, system, user, o):
    base = p.get("base_url") or f"https://bedrock-runtime.{p.get('region') or 'ap-northeast-1'}.amazonaws.com"
    cfg = {"maxTokens": o["max_output_tokens"]}
    if p.get("send_temperature"):
        cfg["temperature"] = o["temperature"]
    body = {"system": [{"text": system}], "messages": [{"role": "user", "content": [
                *({"image": {"format": im["mime"].split("/")[-1].replace("jpg", "jpeg"), "source": {"bytes": im["data"]}}} for im in _images(o)),
                {"text": user}]}], "inferenceConfig": cfg, **_extra(p)}
    data = _post(f"{base.rstrip('/')}/model/{urllib.parse.quote(p['model'], safe='')}/converse", body,
                 {"Authorization": f"Bearer {key}"}, o["timeout"])
    content = ((data.get("output") or {}).get("message") or {}).get("content") or []
    u = data.get("usage") or {}
    return Reply("".join(x.get("text", "") for x in content), p["model"], u.get("inputTokens", 0), u.get("outputTokens", 0))


CALLERS = {"openai": call_openai, "azure_openai": call_azure, "anthropic": call_anthropic, "gemini": call_gemini, "bedrock": call_bedrock}


def _log(p, purpose, user_id, ok, err, reply, cost, ms):
    con = _con()
    try:
        con.execute("""INSERT INTO ai_usage (provider_id, provider_name, model, purpose, user_id, ok, error, input_tokens, output_tokens,
                                             cost, currency, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (p["id"], p["name"], (reply.model if reply else None) or p.get("model") or p.get("deployment"), purpose, user_id,
                     1 if ok else 0, (err or "")[:500] or None, reply.input_tokens if reply else 0, reply.output_tokens if reply else 0,
                     cost, p.get("currency"), ms))
        con.commit()
    finally:
        con.close()


def call(p: dict, system: str, user: str, purpose: str = "ask", user_id: Optional[int] = None, opts: Optional[dict] = None,
         images: Optional[List[dict]] = None) -> dict:
    """One service; never raises: {provider_id, name, location, ok, text, model, input_tokens, output_tokens, cost, latency_ms, error}.
    images: [{mime, data (base64)}] — only for a service marked 「可看圖片」 (see sees_images)."""
    s = settings()
    o = dict(opts or {"timeout": s["timeout"], "max_output_tokens": s["max_output_tokens"], "temperature": s["temperature"]})
    o["images"] = images or []
    t0 = time.monotonic()
    reply, err = None, None
    try:
        key = key_of(p)
        if key is None:
            raise RuntimeError("金鑰無法解密，請重新輸入")
        reply = CALLERS[p["kind"]](p, key, system, user, o)
        reply.text = re.sub(r"<think>.*?</think>", "", reply.text or "", flags=re.S).strip()   # reasoning models' thoughts
        if not reply.text:
            raise RuntimeError("服務沒有回傳內容")
    except Exception as e:  # noqa: BLE001 — every failure becomes a row in the result and in ai_usage
        err, reply = str(e)[:500] or type(e).__name__, None
    ms = int((time.monotonic() - t0) * 1000)
    cost = cost_of(p, reply.input_tokens, reply.output_tokens) if reply else 0.0
    _log(p, purpose, user_id, reply is not None, err, reply, cost, ms)
    return {"provider_id": p["id"], "name": p["name"], "location": p.get("location"), "ok": reply is not None,
            "text": reply.text if reply else "", "model": (reply.model if reply else None) or p.get("model") or p.get("deployment"),
            "input_tokens": reply.input_tokens if reply else 0, "output_tokens": reply.output_tokens if reply else 0,
            "cost": cost, "currency": p.get("currency"), "latency_ms": ms, "error": err}


def sees_images(p: dict, s: Optional[dict] = None) -> bool:
    """Screenshots go to a service only when it is marked 「可看圖片」 and is on-premises — or cloud images are allowed."""
    s = s or settings()
    return bool(p.get("vision")) and (p.get("location") == "onprem" or bool(s.get("images_to_cloud")))


def ask(prompt: str, system: Optional[str] = None, mode: Optional[str] = None, ids: Optional[List[int]] = None,
        purpose: str = "ask", user_id: Optional[int] = None, ignore_switch: bool = False,
        images: Optional[List[dict]] = None) -> dict:
    """Route one question. mode fallback: the first usable service by priority that answers (the others are
    tried in turn); parallel: every usable service at once. {mode, results: [...], answer: first good result or None}."""
    s = settings()
    if not s["enabled"] and not ignore_switch:
        raise RuntimeError("AI 接入點尚未啟用")
    mode = mode or s["mode"]
    pool = usable(ids)
    if not pool:
        raise RuntimeError("沒有可用的 AI 服務（都已停用、雲端未允許、超過預算或設定不完整）")
    system = system or s["system_prompt"]
    if images:
        # services that may see the screenshots first; the others still answer from the text alone
        pool = sorted(pool, key=lambda p: 0 if sees_images(p, s) else 1)

    def one(p):
        if not images or sees_images(p, s):
            return call(p, system, prompt, purpose, user_id, images=images if images else None)
        note = f"\n\n（工程師附了 {len(images)} 張截圖，但這個 AI 服務不能看圖或不允許把圖片送到雲端，請只依文字判斷，需要時請對方用文字補充截圖內容。）"
        return call(p, system, prompt + note, purpose, user_id)

    if mode == "parallel":
        with ThreadPoolExecutor(max_workers=min(8, len(pool))) as ex:
            results = list(ex.map(one, pool))
    else:
        results = []
        for p in pool:
            r = one(p)
            results.append(r)
            if r["ok"]:
                break
    ans = next((r for r in results if r["ok"]), None)
    return {"mode": mode, "results": results, "answer": ans,
            "images_seen": bool(images) and bool(ans) and sees_images(next(p for p in pool if p["id"] == ans["provider_id"]), s)}


def recent(limit: int = 40) -> List[dict]:
    con = _con()
    try:
        return [dict(r) for r in con.execute("SELECT * FROM ai_usage ORDER BY id DESC LIMIT ?", (limit,))]
    finally:
        con.close()


def public(p: dict, s: Optional[dict] = None) -> dict:
    """A provider for the admin page: no key, plus whether one is set, this period's use and why it is blocked."""
    out = {k: v for k, v in p.items() if k != "api_key_enc"}
    out["key_set"] = bool(p.get("api_key_enc"))
    out["usage"] = period_usage(p)
    out["blocked"] = blocked_reason(p, s, out["usage"])
    return out
