"""
Attachments on board cards and comments: images and documents.

Files live in <data dir>/attachments/<random>.<ext>; the database (task_images) knows which card
or comment each belongs to and whether it is an image (shown as a thumbnail) or a file (a download).
Every upload is checked by its content, not only its name:
  images     PNG / JPEG / GIF / WebP magic bytes (no SVG, so an image can never carry script)
  pdf        %PDF-
  doc/xls/ppt          OLE2 compound file header
  docx/xlsx/pptx       a ZIP holding [Content_Types].xml and word/ xl/ or ppt/
  text (md json yaml yml toml txt py rs mmd mermaid)   UTF-8, UTF-16 (with BOM) or Big5 text, no NUL bytes;
                       served with that charset so old Notepad (Big5) files display correctly
They are served only through /api/tasks/{id}/images/{attachment_id}, after the same visibility check
as the card, with nosniff and a sandbox CSP; text is served as text/plain, Office files as downloads.
"""
import io
import os
import secrets
import time
import zipfile
from pathlib import Path
from typing import Optional

from .config import DATA_DIR

IMAGE_DIR = DATA_DIR / "attachments"
MAX_BYTES = 10 * 1024 * 1024            # images
MAX_FILE_BYTES = 25 * 1024 * 1024       # documents
MAX_PER_CARD = 30
MAX_PER_COMMENT = 10
PENDING_HOURS = 24          # comment attachments uploaded but never posted are removed after this

IMAGE_TYPES = {"png": "image/png", "jpg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}
OLE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
OFFICE = {
    "pdf": "application/pdf",
    "doc": "application/msword",
    "xls": "application/vnd.ms-excel",
    "ppt": "application/vnd.ms-powerpoint",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}
TEXT_EXT = ("md", "json", "yaml", "yml", "toml", "txt", "py", "rs", "mmd", "mermaid")
OOXML_DIR = {"docx": "word/", "xlsx": "xl/", "pptx": "ppt/"}
FILE_TYPES = {**OFFICE, **{e: "text/plain; charset=utf-8" for e in TEXT_EXT}}
ALL_EXT = set(IMAGE_TYPES) | set(FILE_TYPES)
INLINE = set(IMAGE_TYPES) | {"pdf"} | set(TEXT_EXT)      # opened in the browser; the rest downloads
ACCEPT_LABEL = "圖片（PNG、JPG、GIF、WebP）、PDF、Word、Excel、PowerPoint、md、json、yaml、toml、txt、py、rs、mermaid"


def sniff(head: bytes) -> Optional[str]:
    """Image extension from the magic bytes, or None."""
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return None


def _ext_of(filename: str) -> str:
    name = (filename or "").rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def text_charset(data: bytes) -> Optional[str]:
    """Charset of a text upload (utf-8 / utf-16 / big5), or None if it is not text."""
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        try:
            data.decode("utf-16")
            return "utf-16"
        except UnicodeDecodeError:
            return None
    if b"\x00" in data:
        return None
    for cs, codec in (("utf-8", "utf-8"), ("big5", "cp950")):
        try:
            data.decode(codec)
            return cs
        except UnicodeDecodeError:
            continue
    return None


def _ooxml_ok(data: bytes, ext: str) -> bool:
    if not data.startswith(b"PK\x03\x04"):
        return False
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = z.namelist()
    except (zipfile.BadZipFile, ValueError):
        return False
    return "[Content_Types].xml" in names and any(n.startswith(OOXML_DIR[ext]) for n in names)


def classify(data: bytes, filename: str) -> tuple:
    """(ext, mime, kind) for an accepted upload. Raises ValueError with a message for the user."""
    if not data:
        raise ValueError("檔案是空的")
    img = sniff(data[:16])
    if img:
        if len(data) > MAX_BYTES:
            raise ValueError(f"圖片太大（上限 {MAX_BYTES // 1024 // 1024} MB）")
        return img, IMAGE_TYPES[img], "image"
    ext = _ext_of(filename)
    if ext not in FILE_TYPES:
        raise ValueError(f"不支援這種檔案。可以上傳：{ACCEPT_LABEL}")
    if len(data) > MAX_FILE_BYTES:
        raise ValueError(f"檔案太大（上限 {MAX_FILE_BYTES // 1024 // 1024} MB）")
    mime = FILE_TYPES[ext]
    if ext in TEXT_EXT:
        cs = text_charset(data)
        if not cs:
            raise ValueError(f"「{filename or ext}」不是文字檔（文字檔需為 UTF-8、UTF-16 或 Big5 編碼）")
        return ext, f"text/plain; charset={cs}", "file"
    ok = (data.startswith(b"%PDF-") if ext == "pdf"
          else data.startswith(OLE) if ext in ("doc", "xls", "ppt")
          else _ooxml_ok(data, ext))
    if not ok:
        raise ValueError(f"「{filename or ext}」的內容不是 {ext} 檔（可能只是改了副檔名）")
    return ext, mime, "file"


def _dir() -> Path:
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    return IMAGE_DIR


def store(data: bytes, filename: str = "") -> tuple:
    """Check and write the bytes under a random name. Returns (stored_name, mime, kind). Raises ValueError."""
    ext, mime, kind = classify(data, filename)
    name = f"{secrets.token_hex(16)}.{ext}"
    tmp = _dir() / (name + ".part")
    tmp.write_bytes(data)
    os.replace(tmp, IMAGE_DIR / name)
    return name, mime, kind


def copy(stored: str) -> Optional[str]:
    """Duplicate a stored file (used when a recurring card spawns its next occurrence)."""
    src = path(stored)
    if not src or not src.is_file():
        return None
    ext = stored.rsplit(".", 1)[-1]
    name = f"{secrets.token_hex(16)}.{ext}"
    (_dir() / name).write_bytes(src.read_bytes())
    return name


def path(stored: str) -> Optional[Path]:
    """Path of a stored file, refusing anything that is not one of our own random names."""
    base, _, ext = (stored or "").partition(".")
    if len(base) != 32 or ext not in ALL_EXT or not all(c in "0123456789abcdef" for c in base):
        return None
    return IMAGE_DIR / stored


def inline(stored: str) -> bool:
    return stored.rsplit(".", 1)[-1] in INLINE


def remove(names):
    for n in names:
        p = path(n)
        if p:
            p.unlink(missing_ok=True)


def sweep_orphans(known: set, min_age: int = 3600) -> int:
    """Delete files no database row points at (older than min_age seconds, so uploads in flight survive)."""
    if not IMAGE_DIR.is_dir():
        return 0
    n = 0
    cutoff = time.time() - min_age
    for p in IMAGE_DIR.iterdir():
        if p.is_file() and p.name not in known and p.stat().st_mtime < cutoff:
            p.unlink(missing_ok=True)
            n += 1
    return n
