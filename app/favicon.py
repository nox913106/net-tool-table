"""
Fetch a website's icon and store it in the icon library.

Order:
  1. icons declared in the page <head> (apple-touch-icon / largest <link rel="icon">)
  2. /favicon.ico and /apple-touch-icon.png on the host, then on the parent domain
  3. public sites only: a favicon service (Google, then DuckDuckGo) — also used when the
     site only offers a tiny 16×16 icon, to get a sharper one

Requests look like a normal browser (many shops / CDNs block unknown clients), accept
intranet self-signed certificates, and are limited in size and time. Only http/https.
Internal hosts (private IPs, single-label names, .local/.lan/.corp…) are never sent to a
third-party service.
"""
import gzip
import io
import ipaddress
import logging
import re
import socket
import ssl
import urllib.error
import urllib.request
import zlib
from html.parser import HTMLParser
from typing import List, Optional, Tuple
from urllib.parse import quote, urljoin, urlparse

from .localapps import save_icon_image

log = logging.getLogger("tool_table.favicon")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
HEADERS = {
    "User-Agent": UA,
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate",
}
MAX_HTML = 768 * 1024          # icons live in <head>: a truncated page is fine
MAX_ICON = 1024 * 1024
TIMEOUT = 6
SHARP_ENOUGH = 48              # px — smaller icons trigger a look for a sharper one
INTERNAL_SUFFIXES = (".local", ".lan", ".internal", ".intranet", ".corp", ".home", ".localdomain", ".test")


class _HttpOnlyRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlparse(newurl).scheme not in ("http", "https"):
            raise urllib.error.HTTPError(newurl, code, "redirect to non-http URL refused", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _decode(body: bytes, encoding: str) -> bytes:
    encoding = (encoding or "").lower()
    try:
        if "gzip" in encoding:
            return gzip.GzipFile(fileobj=io.BytesIO(body)).read()
        if "deflate" in encoding:
            return zlib.decompress(body, -zlib.MAX_WBITS) if body[:1] != b"\x78" else zlib.decompress(body)
    except Exception:
        pass   # truncated stream: keep what we have
    return body


def _open(url: str, limit: int, accept: str = "*/*", truncate: bool = False) -> Tuple[bytes, str, str]:
    """GET url → (body, final_url, content_type). Retries without TLS verification for intranet certs."""
    for verify in (True, False):
        ctx = ssl.create_default_context()
        if not verify:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        opener = urllib.request.build_opener(_HttpOnlyRedirect(), urllib.request.HTTPSHandler(context=ctx))
        req = urllib.request.Request(url, headers={**HEADERS, "Accept": accept})
        try:
            with opener.open(req, timeout=TIMEOUT) as r:
                raw = r.read(limit + 1)
                if len(raw) > limit and not truncate:
                    raise ValueError(f"larger than {limit} bytes")
                body = _decode(raw[:limit] if truncate else raw, r.headers.get("Content-Encoding"))
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
            size = 1                                   # vector: we cannot rasterise it, try others first
        self.icons.append((size or 16, href))


def _image_size(data: bytes) -> int:
    """Largest edge in pixels (0 if not a readable bitmap)."""
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(data))
        sizes = img.info.get("sizes") or [img.size]
        return max(max(s) for s in sizes)
    except Exception:
        return 0


def is_public_host(host: str) -> bool:
    """True for internet hosts; False for IPs in private ranges, single-label and internal names."""
    host = (host or "").lower().rstrip(".")
    if not host or "." not in host or host.endswith(INTERNAL_SUFFIXES):
        return False
    try:
        return ipaddress.ip_address(host).is_global
    except ValueError:
        pass
    try:
        addrs = {ai[4][0] for ai in socket.getaddrinfo(host, None)}
    except OSError:
        return True   # cannot resolve here (e.g. proxy): the name itself looks public
    return bool(addrs) and all(ipaddress.ip_address(a.split("%")[0]).is_global for a in addrs)


def _parent_domain(host: str) -> Optional[str]:
    """24h.pchome.com.tw → pchome.com.tw ; www.example.com → example.com"""
    parts = host.split(".")
    if len(parts) <= 2:
        return None
    # keep 3 labels for two-part public suffixes such as com.tw / co.uk / org.au
    keep = 3 if len(parts[-1]) == 2 and parts[-2] in {"com", "net", "org", "gov", "edu", "co", "ac", "or", "ne", "go"} else 2
    return ".".join(parts[-keep:]) if len(parts) > keep else None


def _try_icon(url: str) -> Optional[bytes]:
    try:
        data, _, ctype = _open(url, MAX_ICON, accept="image/avif,image/webp,image/png,image/*,*/*;q=0.8")
    except Exception as e:
        log.info("favicon candidate %s: %s", url, e)
        return None
    if not data or b"<svg" in data[:2048].lower() or b"<html" in data[:512].lower():
        return None
    return data if _image_size(data) else None


def fetch_favicon(page_url: str, web_fallback: bool = True) -> Optional[str]:
    """Return the saved icon filename, or None if nothing usable was found."""
    parsed = urlparse(page_url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    host = parsed.hostname
    label = host.replace("www.", "")
    candidates: List[str] = []
    base = page_url

    # 1. icons declared by the page
    try:
        html, final_url, ctype = _open(page_url, MAX_HTML, accept="text/html,application/xhtml+xml,*/*;q=0.8", truncate=True)
        base = final_url
        if "html" in ctype or b"<html" in html[:4096].lower() or b"<head" in html[:8192].lower():
            p = _IconLinks()
            try:
                p.feed(html.decode("utf-8", "replace"))
            except Exception:
                pass
            candidates += [urljoin(final_url, href) for _, href in sorted(p.icons, key=lambda x: -x[0])]
    except Exception as e:
        log.warning("favicon: cannot read %s (%s)", page_url, e)

    # 2. conventional locations on the host and its parent domain
    final = urlparse(base)
    final_host = final.hostname or host
    port = f":{final.port}" if final.port else ""            # keep non-standard ports (intranet)
    for h in dict.fromkeys([final_host, host, _parent_domain(final_host)]):
        if h:
            root = f"{final.scheme or 'https'}://{h}{port}"
            candidates += [f"{root}/apple-touch-icon.png", f"{root}/favicon.ico"]

    best: Optional[bytes] = None
    best_size = 0
    for url in dict.fromkeys(candidates):
        if urlparse(url).scheme not in ("http", "https"):
            continue
        data = _try_icon(url)
        if data:
            size = _image_size(data)
            if size > best_size:
                best, best_size = data, size
            if best_size >= SHARP_ENOUGH:
                break

    # 3. public sites: favicon service (when nothing was found, or only a tiny icon)
    if web_fallback and best_size < SHARP_ENOUGH and is_public_host(final_host):
        domain = quote(final_host)
        for url in (f"https://www.google.com/s2/favicons?domain={domain}&sz=128",
                    f"https://icons.duckduckgo.com/ip3/{domain}.ico"):
            data = _try_icon(url)
            if data and _image_size(data) > best_size:
                best, best_size = data, _image_size(data)
                break

    if not best:
        log.warning("favicon: no usable icon for %s", page_url)
        return None
    return save_icon_image(best, "fav", label)
