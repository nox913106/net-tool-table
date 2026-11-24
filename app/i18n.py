"""
Server-side languages (Traditional Chinese, English).

The server's own texts are written in Traditional Chinese. app/i18n_en.json maps each one
(with {0} {1} … where values are filled in) to English. Responses are translated on the way
out, for people using the English interface:
  - error messages (detail / validation messages) of every API response,
  - a short list of fields that only ever hold texts the server wrote (notification text,
    problem descriptions, role names, sync log labels …), never what people typed.
Text with values filled in is recognised by pattern: “「主機房」落後基準線 5 天…” →
““主機房” is 5 days behind its baseline…”. People's own content is left as it is.

tr(zh, *args) translates one text for code that builds output itself (Excel, Teams).
The language of a request: the X-Lang header the web pages send, else the account's language.
"""
import contextvars
import json
import re
from pathlib import Path
from typing import Optional

LANG = contextvars.ContextVar("tt_lang", default="zh-TW")
_EN = json.loads(Path(__file__).with_name("i18n_en.json").read_text(encoding="utf-8"))
_HAN = re.compile(r"[一-鿿]")
_PH = re.compile(r"\{(\d+)\}")


def _patterns():
    out = []
    for zh, en in _EN.items():
        if not _PH.search(zh):
            continue
        literal = _PH.sub("", zh)
        if not _HAN.search(literal):            # “{0} {1}” would match anything
            continue
        seen, rx = set(), ""
        for part in re.split(r"(\{\d+\})", zh):
            m = _PH.fullmatch(part)
            if m:
                g = m.group(1)
                rx += f"(?P=a{g})" if g in seen else f"(?P<a{g}>.*?)"
                seen.add(g)
            else:
                rx += re.escape(part)
        out.append((len(literal), re.compile("^" + rx + "$", re.S), en))
    out.sort(key=lambda x: -x[0])               # the most specific first
    return out


_PATTERNS = _patterns()


def lang() -> str:
    return LANG.get()


def tr(zh: str, *args, lang: Optional[str] = None) -> str:
    """One known text in the current (or given) language, with {0} {1} … filled in."""
    s = _EN.get(zh, zh) if (lang or LANG.get()) == "en" else zh
    return _PH.sub(lambda m: str(args[int(m.group(1))]) if int(m.group(1)) < len(args) else m.group(0), s) if args else s


def translate(text, lang: Optional[str] = None, depth: int = 0):
    """A text the server wrote (possibly with values in it) → English when English is on; anything else unchanged."""
    if (lang or LANG.get()) != "en" or not isinstance(text, str) or not _HAN.search(text):
        return text
    if text in _EN:
        return _EN[text]
    best, best_han = text, len(_HAN.findall(text))
    for _, rx, en in _PATTERNS:                 # several may fit: keep the one that leaves the least Chinese
        m = rx.match(text)
        if not m:
            continue
        vals = {k[1:]: v for k, v in m.groupdict().items()}
        if depth < 2:
            vals = {k: translate(v, "en", depth + 1) for k, v in vals.items()}
        out = _PH.sub(lambda g: vals.get(g.group(1), g.group(0)), en)
        han = len(_HAN.findall(out))
        if han < best_han:
            best, best_han = out, han
    return best


# fields that only hold texts written by the server (never what people typed)
SERVER_FIELDS = {"detail", "msg", "message", "text", "type_zh", "role_label", "label", "why", "what", "field", "error", "errors", "result"}


def _walk(obj, fields):
    if isinstance(obj, dict):
        return {k: ([translate(x) for x in v] if k in fields and isinstance(v, list) and all(isinstance(x, str) for x in v)
                    else translate(v) if k in fields and isinstance(v, str) else _walk(v, fields)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_walk(x, fields) for x in obj]
    return obj


PATH_FIELDS = {"/api/sync/client": {"note"},                       # the sync log's notes
               "/api/tasks/projects/analysis": {"title", "type_zh"}}  # 結案 / “…：本週超載” (only exact template matches change)


def localize(data, path: str = ""):
    fields = set(SERVER_FIELDS)
    for prefix, extra in PATH_FIELDS.items():
        if path.startswith(prefix):
            fields |= extra
    return _walk(data, fields)


async def middleware(request, call_next):
    """Set the request's language; for English, translate the server's texts in JSON answers."""
    want = (request.headers.get("x-lang") or request.cookies.get("tt_lang") or "").strip()
    token = LANG.set("en" if want == "en" else "zh-TW")
    try:
        response = await call_next(request)
        if LANG.get() != "en" or not request.url.path.startswith("/api/") \
                or not (response.headers.get("content-type") or "").startswith("application/json"):
            return response
        body = b"".join([chunk async for chunk in response.body_iterator])
        try:
            data = json.loads(body)
        except ValueError:
            data = None
        from starlette.responses import Response
        if data is None:
            return Response(body, status_code=response.status_code, headers=dict(response.headers))
        out = json.dumps(localize(data, request.url.path), ensure_ascii=False).encode()
        headers = {k: v for k, v in response.headers.items() if k.lower() not in ("content-length",)}
        return Response(out, status_code=response.status_code, headers=headers, media_type="application/json")
    finally:
        LANG.reset(token)
