"""
Local programs (Windows portable edition)

When IPMS runs as the portable ToolTable.exe, the server *is* the user's PC, so
it can do what a web page cannot: launch programs and read shortcuts / exe icons.

Everything here is gated by `require_local()`:
  * the feature must be enabled (TOOL_TABLE_LOCAL_APPS=1, set by portable/launcher.py)
  * the request must come from this machine (127.0.0.1 / ::1)
  * the Host header must be a loopback name (blocks DNS-rebinding attacks)
  * the request must carry `X-Tool-Table: 1` (forces a CORS preflight, which this
    server never approves, so other websites cannot trigger it)

Programs are stored as normal link nodes whose URL is a file: URL, e.g.
  file:///C:/Program Files/Notepad++/notepad++.exe
"""
import hashlib
import io
import os
import re
import struct
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

from fastapi import HTTPException, Request

from .config import ICON_DIR, LOCAL_APPS

LOOPBACK = {"127.0.0.1", "::1", "localhost"}
IS_WINDOWS = os.name == "nt"


# ---------------------------------------------------------------- guards ---
def local_allowed(request: Request) -> bool:
    if not LOCAL_APPS:
        return False
    client = request.client.host if request.client else ""
    host = (request.headers.get("host") or "").rsplit(":", 1)[0].strip("[]").lower()
    return client in LOOPBACK and host in LOOPBACK


def require_local(request: Request):
    if not LOCAL_APPS:
        raise HTTPException(status_code=403, detail="這個功能只能在 Windows 單機版使用")
    if not local_allowed(request):
        raise HTTPException(status_code=403, detail="只能在執行單機版的這台電腦上使用")
    if request.headers.get("x-tool-table") != "1":
        raise HTTPException(status_code=403, detail="缺少必要的請求標頭")


def is_file_url(url: Optional[str]) -> bool:
    return bool(url) and url.strip().lower().startswith("file:")


# ------------------------------------------------------ path <-> file URL ---
def path_to_url(path: str) -> str:
    """C:\\Program Files\\x.exe → file:///C:/Program Files/x.exe ; \\\\srv\\share\\x → file://srv/share/x"""
    p = path.strip().strip('"')
    if p.startswith("\\\\"):
        return "file://" + p[2:].replace("\\", "/")
    return "file:///" + p.replace("\\", "/").lstrip("/")


def url_to_path(url: str) -> str:
    u = url.strip()
    if not u.lower().startswith("file:"):
        return u
    rest = u[5:]
    if rest.startswith("///"):
        p = rest[3:]
        p = p if re.match(r"^[A-Za-z]:", p) else "/" + p   # POSIX path when not a drive
    elif rest.startswith("//"):
        p = "//" + rest[2:]                                   # UNC
    else:
        p = rest
    p = re.sub(r"%([0-9A-Fa-f]{2})", lambda m: chr(int(m.group(1), 16)), p)
    return p.replace("/", "\\") if IS_WINDOWS else p


def normalize_target(value: str) -> str:
    """Accept a pasted Windows path (C:\\..., \\\\server\\...) and turn it into a file: URL."""
    v = (value or "").strip().strip('"')
    if re.match(r"^[A-Za-z]:[\\/]", v) or v.startswith("\\\\"):
        return path_to_url(v)
    if not IS_WINDOWS and v.startswith("/") and not v.startswith("//"):
        return "file://" + v                       # POSIX path (development on Linux / macOS)
    return v


def expand_env(s: str) -> str:
    return re.sub(r"%([^%]+)%", lambda m: os.environ.get(m.group(1), m.group(0)), s or "")


# ----------------------------------------------------- shortcut parsing ---
class ShortcutError(ValueError):
    pass


def _c_string(data: bytes, off: int, unicode: bool = False) -> str:
    if unicode:
        end = off
        while end + 1 < len(data) and data[end:end + 2] != b"\0\0":
            end += 2
        return data[off:end].decode("utf-16-le", "replace")
    end = data.find(b"\0", off)
    return data[off:end if end >= 0 else len(data)].decode("mbcs" if IS_WINDOWS else "cp1252", "replace")


def _idlist_path(idlist: bytes) -> str:
    """Best-effort path from a shell item ID list (drive item + file entry items)."""
    parts, off = [], 0
    while off + 2 <= len(idlist):
        size = struct.unpack_from("<H", idlist, off)[0]
        if size == 0:
            break
        item = idlist[off:off + size]
        kind = item[2] if len(item) > 2 else 0
        if kind & 0x70 == 0x20 and len(item) > 5:                  # volume: "C:\"
            parts = [item[3:].split(b"\0")[0].decode("ascii", "replace").rstrip("\\")]
        elif kind & 0x70 == 0x30 and len(item) > 14:               # file entry
            name = item[14:].split(b"\0")[0].decode("cp1252", "replace")
            beef = item.find(b"\x04\x00\xef\xbe")                  # extension block 0xBEEF0004 → long name
            if beef >= 4:
                block = beef - 4                                   # size(2) version(2) signature(4) …
                ext_size, version = struct.unpack_from("<HH", item, block)
                rel = 46 if version >= 9 else 42 if version >= 8 else 38 if version >= 7 else 20
                if rel < ext_size:
                    name = _c_string(item, block + rel, unicode=True) or name
            if parts:
                parts.append(name)
        off += size
    return "\\".join(parts) if parts else ""


def parse_lnk(data: bytes) -> dict:
    """Parse a Windows .lnk (MS-SHLLINK). Returns target, args, cwd, icon, icon_index, name."""
    if len(data) < 0x4C or struct.unpack_from("<I", data, 0)[0] != 0x4C:
        raise ShortcutError("不是 Windows 捷徑檔（.lnk）")
    flags = struct.unpack_from("<I", data, 0x14)[0]
    icon_index = struct.unpack_from("<i", data, 0x38)[0]
    unicode = bool(flags & 0x80)
    off = 0x4C
    target = ""

    if flags & 0x01:                                               # LinkTargetIDList
        size = struct.unpack_from("<H", data, off)[0]
        idpath = _idlist_path(data[off + 2: off + 2 + size])
        off += 2 + size
    else:
        idpath = ""

    if flags & 0x02:                                               # LinkInfo
        li_size, hdr_size, li_flags = struct.unpack_from("<III", data, off)
        vol_off, base_off, net_off, suffix_off = struct.unpack_from("<IIII", data, off + 12)
        if hdr_size >= 0x24:
            base_u, suffix_u = struct.unpack_from("<II", data, off + 28)
        else:
            base_u = suffix_u = 0
        suffix = _c_string(data, off + suffix_u, True) if suffix_u else _c_string(data, off + suffix_off)
        if li_flags & 0x01:
            base = _c_string(data, off + base_u, True) if base_u else _c_string(data, off + base_off)
            target = base + suffix
        elif li_flags & 0x02 and net_off:                          # \\server\share
            net = off + net_off
            net_name_off = struct.unpack_from("<I", data, net + 8)[0]
            share = _c_string(data, net + net_name_off)
            target = share.rstrip("\\") + ("\\" + suffix if suffix else "")
        off += li_size

    strings = {}
    for bit, key in ((0x04, "name"), (0x08, "relative"), (0x10, "cwd"), (0x20, "args"), (0x40, "icon")):
        if flags & bit:
            count = struct.unpack_from("<H", data, off)[0]
            off += 2
            n = count * 2 if unicode else count
            raw = data[off:off + n]
            strings[key] = raw.decode("utf-16-le" if unicode else "cp1252", "replace")
            off += n

    env_target = env_icon = ""
    while off + 8 <= len(data):                                    # ExtraData blocks
        size, sig = struct.unpack_from("<II", data, off)
        if size < 4:
            break
        if sig in (0xA0000001, 0xA0000007) and size >= 0x314:      # Environment / IconEnvironment
            value = _c_string(data, off + 8 + 260, True) or _c_string(data, off + 8)
            if sig == 0xA0000001:
                env_target = value
            else:
                env_icon = value
        off += size

    target = target or expand_env(env_target) or idpath
    if not target:
        raise ShortcutError("無法讀出捷徑目標（可能是 Microsoft Store 應用程式的捷徑），請改用程式的執行檔")
    return {
        "target": target,
        "args": strings.get("args", ""),
        "cwd": expand_env(strings.get("cwd", "")),
        "icon": expand_env(env_icon or strings.get("icon", "")),
        "icon_index": icon_index,
        "description": strings.get("name", ""),
    }


def parse_url_file(data: bytes) -> dict:
    """Internet shortcut (.url): [InternetShortcut] URL=..."""
    text = data.decode("utf-8", "replace")
    url = re.search(r"^\s*URL\s*=\s*(\S+)", text, re.M | re.I)
    if not url:
        raise ShortcutError("讀不到捷徑中的網址")
    return {"url": url.group(1).strip()}


# ------------------------------------------------------ locate an exe ---
def search_roots():
    env = os.environ.get
    home = Path.home()
    roots = [env("ProgramFiles"), env("ProgramFiles(x86)"), env("ProgramW6432"),
             os.path.join(env("LOCALAPPDATA") or "", "Programs"), env("APPDATA"),
             str(home / "Desktop"), str(home / "Downloads"), str(home / "Documents"),
             os.path.join(env("PUBLIC") or "", "Desktop")]
    shallow = [os.path.join(env("SystemRoot") or "C:\\Windows", "System32"), env("SystemRoot")]
    shallow += (env("PATH") or "").split(os.pathsep)
    seen, deep_list, shallow_list = set(), [], []
    for lst, out in ((roots, deep_list), (shallow, shallow_list)):
        for r in lst:
            if r and os.path.isdir(r) and r.lower() not in seen:
                seen.add(r.lower())
                out.append(r)
    return deep_list, shallow_list


def locate(name: str, size: int, budget: float = 8.0) -> Optional[str]:
    """Find a file by name + size in the usual program folders (bounded by time and depth)."""
    name_l = name.lower()
    deep, shallow = search_roots()
    for d in shallow:
        p = os.path.join(d, name)
        if os.path.isfile(p) and os.path.getsize(p) == size:
            return p
    start = time.monotonic()
    for root in deep:
        base_depth = root.rstrip("\\/").count(os.sep)
        for dirpath, dirnames, filenames in os.walk(root):
            if time.monotonic() - start > budget:
                return None
            if dirpath.count(os.sep) - base_depth >= 6:
                dirnames[:] = []
            dirnames[:] = [d for d in dirnames if not d.startswith((".", "$"))]
            for f in filenames:
                if f.lower() == name_l:
                    p = os.path.join(dirpath, f)
                    try:
                        if os.path.getsize(p) == size:
                            return p
                    except OSError:
                        pass
    return None


# ------------------------------------------------------------- icons ---
def _safe_slug(text: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-.").lower()
    return slug[:40] or "icon"


def save_icon_image(data: bytes, prefix: str, label: str) -> str:
    """Normalise any image (ico/png/jpg/gif/webp/bmp) to a PNG in the icon folder. Returns its filename."""
    from PIL import Image  # lazy: only needed for these features

    img = Image.open(io.BytesIO(data))
    if img.format == "ICO":                                        # pick the largest frame
        sizes = sorted(img.info.get("sizes") or [img.size], key=lambda s: s[0] * s[1])
        img = img.ico.getimage(sizes[-1])
    img.load()
    img = img.convert("RGBA")
    if max(img.size) > 256:
        img.thumbnail((256, 256))
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    png = buf.getvalue()
    digest = hashlib.sha1(png).hexdigest()[:8]
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    for existing in ICON_DIR.glob(f"{prefix}-*-{digest}.png"):    # same picture already saved
        return existing.name
    name = f"{prefix}-{_safe_slug(label)}-{digest}.png"
    (ICON_DIR / name).write_bytes(png)
    return name


def icon_from_file(path: str, index: int = 0, label: str = "") -> Optional[str]:
    """Icon of an exe/dll (resource), or an .ico/.png file. Returns saved icon filename or None."""
    path = expand_env(path)
    if not path or not os.path.isfile(path):
        return None
    label = label or Path(path).stem
    ext = Path(path).suffix.lower()
    try:
        if ext in (".ico", ".png", ".bmp", ".jpg", ".jpeg", ".gif", ".webp"):
            return save_icon_image(Path(path).read_bytes(), "app", label)
        from icoextract import IconExtractor  # lazy
        ex = IconExtractor(path)
        try:
            data = ex.get_icon(num=max(index, 0)).getvalue()
        except Exception:
            data = ex.get_icon(num=0).getvalue()
        return save_icon_image(data, "app", label)
    except Exception:
        return None


def program_name(path: str) -> str:
    """ProductName / FileDescription from the exe's version info, else the file name."""
    stem = Path(path).stem
    if Path(path).suffix.lower() not in (".exe", ".dll"):
        return stem
    try:
        import pefile  # lazy
        pe = pefile.PE(path, fast_load=True)
        pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_RESOURCE"]])
        info = {}
        for fi in getattr(pe, "FileInfo", []) or []:
            for entry in fi:
                for st in getattr(entry, "StringTable", []) or []:
                    for k, v in st.entries.items():
                        info[k.decode(errors="ignore")] = v.decode(errors="ignore").strip()
        pe.close()
        for key in ("ProductName", "FileDescription"):
            v = info.get(key, "")
            if v and len(v) <= 60:
                return v
    except Exception:
        pass
    return stem


# ------------------------------------------------------------- launch ---
def launch(path: str, args: str = "", cwd: str = ""):
    path = expand_env(path)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"找不到：{path}")
    workdir = expand_env(cwd) if cwd and os.path.isdir(expand_env(cwd)) else (
        os.path.dirname(path) if os.path.isfile(path) else None)
    if IS_WINDOWS:
        os.startfile(path, "open", args or "", workdir)   # exe, documents, folders, .lnk …
    else:  # used when developing / testing on Linux or macOS
        import shlex
        if os.path.isfile(path) and os.access(path, os.X_OK):
            cmd = [path, *shlex.split(args or "")]
        else:
            cmd = ["open" if sys.platform == "darwin" else "xdg-open", path]
        subprocess.Popen(cmd, cwd=workdir, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
