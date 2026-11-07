"""
Fetch a website's icon and store it in the icon library.

Order: <link rel="apple-touch-icon"> (usually 180×180) → largest <link rel="icon"> →
/favicon.ico. Only http/https, small size limits, short timeouts. Intranet sites with
self-signed certificates are accepted (we only read an image).
"""
import re
import ssl
import urllib.error
import urllib.request
from html.parser import HTMLParser
from typing import List, Optional, Tuple
from urllib.parse import urljoin, urlparse

from .localapps import save_icon_image

UA = "Mozilla/5.0 (compatible; ToolTable favicon fetcher)"
MAX_HTML = 512 * 1024
MAX_ICON = 1024 * 1024
TIMEOUT = 6


class _HttpOnlyRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlparse(newurl).scheme not in ("http", "https"):
            raise urllib.error.HTTPError(newurl, code, "redirect to non-http URL refused", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open(url: str, limit: int) -> Tuple[bytes, str, str]:
    """GET url → (body, final_url, content_type). Retries without TLS verification for intranet certs."""
    for verify in (True, False):
        ctx = ssl.create_default_context()
        if not verify:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        opener = urllib.request.build_opener(_HttpOnlyRedirect(), urllib.request.HTTPSHandler(context=ctx))
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
        try:
            with opener.open(req, timeout=TIMEOUT) as r:
                body = r.read(limit + 1)
                if len(body) > limit:
                    raise ValueError("too large")
                return body, r.geturl(), (r.headers.get("Content-Type") or "").lower()
        except urllib.error.URLError as e:
            if verify and isinstance(getattr(e, "reason", None), ssl.SSLError):
                continue
            raise
    raise ValueError("unreachable")


class _IconLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.icons: List[Tuple[int, str]] = []

    def handle_starttag(self, tag, attrs):
        if tag != "link":
            return
        a = {k.lower(): (v or "") for k, v in attrs}
        rel = a.get("rel", "").lower()
        href = a.get("href", "").strip()
        if not href or "icon" not in rel or "mask-icon" in rel:
            return
        size = 0
        for m in re.finditer(r"(\d+)x(\d+)", a.get("sizes", "")):
            size = max(size, int(m.group(1)))
        if "apple-touch-icon" in rel:
            size = max(size, 180)
        if a.get("type", "").endswith("svg") or href.lower().split("?")[0].endswith(".svg"):
            size = max(size, 120)                     # vector: scales well
        self.icons.append((size or 16, href))


def _looks_like_image(data: bytes, ctype: str) -> bool:
    sig = data[:12]
    return (sig.startswith(b"\x89PNG") or sig.startswith(b"\xff\xd8") or sig[:4] in (b"GIF8", b"\0\0\1\0", b"BM")
            or (sig[:4] == b"RIFF" and sig[8:12] == b"WEBP") or ctype.startswith("image/"))


def fetch_favicon(page_url: str) -> Optional[str]:
    """Return the saved icon filename, or None if nothing usable was found."""
    parsed = urlparse(page_url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    label = parsed.hostname.replace("www.", "")
    candidates: List[str] = []
    try:
        html, final_url, ctype = _open(page_url, MAX_HTML)
        if "html" in ctype or html.lstrip()[:15].lower().startswith((b"<!doctype", b"<html")):
            p = _IconLinks()
            p.feed(html.decode("utf-8", "replace"))
            candidates = [urljoin(final_url, href) for _, href in sorted(p.icons, key=lambda x: -x[0])]
        base = final_url
    except Exception:
        base = page_url
    candidates.append(urljoin(base, "/favicon.ico"))

    seen = set()
    for url in candidates:
        if url in seen or urlparse(url).scheme not in ("http", "https", "data"):
            continue
        seen.add(url)
        try:
            if url.startswith("data:"):
                continue
            data, _, ctype = _open(url, MAX_ICON)
            if not data or not _looks_like_image(data, ctype):
                continue
            if b"<svg" in data[:2048].lower():
                continue                               # needs a rasteriser; try the next candidate
            return save_icon_image(data, "fav", label)
        except Exception:
            continue
    return None
