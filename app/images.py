"""
Images on board cards and comments.

Files live in <data dir>/attachments/<random>.<ext>; the database (task_images) knows which card
or comment each belongs to. Only real raster images are accepted (PNG / JPEG / GIF / WebP, checked
by their first bytes, never by name or browser-sent type) — no SVG, so an image can never carry script.
They are served only through /api/tasks/{id}/images/{image_id}, after the same visibility check as the card.
"""
import os
import secrets
import time
from pathlib import Path
from typing import Optional

from .config import DATA_DIR

IMAGE_DIR = DATA_DIR / "attachments"
MAX_BYTES = 10 * 1024 * 1024
MAX_PER_CARD = 30
MAX_PER_COMMENT = 10
PENDING_HOURS = 24          # comment images uploaded but never posted are removed after this

TYPES = {"png": "image/png", "jpg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}


def sniff(head: bytes) -> Optional[str]:
    """File extension from the magic bytes, or None if it is not an accepted image."""
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return None


def _dir() -> Path:
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    return IMAGE_DIR


def store(data: bytes) -> tuple:
    """Write the bytes under a random name. Returns (stored_name, mime). Raises ValueError."""
    if not data:
        raise ValueError("檔案是空的")
    if len(data) > MAX_BYTES:
        raise ValueError(f"圖片太大（上限 {MAX_BYTES // 1024 // 1024} MB）")
    ext = sniff(data[:16])
    if not ext:
        raise ValueError("只能上傳圖片（PNG、JPG、GIF、WebP）")
    name = f"{secrets.token_hex(16)}.{ext}"
    tmp = _dir() / (name + ".part")
    tmp.write_bytes(data)
    os.replace(tmp, IMAGE_DIR / name)
    return name, TYPES[ext]


def copy(stored: str) -> Optional[str]:
    """Duplicate a stored image (used when a recurring card spawns its next occurrence)."""
    src = path(stored)
    if not src or not src.is_file():
        return None
    ext = stored.rsplit(".", 1)[-1]
    name = f"{secrets.token_hex(16)}.{ext}"
    (_dir() / name).write_bytes(src.read_bytes())
    return name


def path(stored: str) -> Optional[Path]:
    """Path of a stored image, refusing anything that is not one of our own random names."""
    base, _, ext = (stored or "").partition(".")
    if len(base) != 32 or ext not in TYPES or not all(c in "0123456789abcdef" for c in base):
        return None
    return IMAGE_DIR / stored


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
