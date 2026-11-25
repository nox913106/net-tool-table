"""
Which version of the program is this — the same answer on the server and on a standalone copy.

The build id is a fingerprint of the files the Windows client is made of (app/, frontend/, resource/icon/,
portable/launcher.py, requirements.txt), line endings normalised so a Windows checkout and a Linux one
agree. Same files → same id; any change → another id. `deps` fingerprints requirements.txt alone: when
it differs, replacing the program files is not enough (new Python packages) and the full installer is needed.

package() zips exactly those files: what a standalone copy downloads from its server to update itself.
"""
import hashlib
import io
import zipfile
from functools import lru_cache
from pathlib import Path
from typing import List, Tuple

PARTS = ("app", "frontend", "resource/icon")
SINGLE = ("portable/launcher.py", "requirements.txt")
SKIP_DIRS = {"__pycache__", ".pytest_cache"}
SKIP_EXT = {".pyc", ".pyo"}


def files(root: Path) -> List[Tuple[str, Path]]:
    out = []
    for part in PARTS:
        base = root / part
        if not base.is_dir():
            continue
        for f in sorted(base.rglob("*")):
            if f.is_file() and not (set(f.relative_to(root).parts) & SKIP_DIRS) and f.suffix not in SKIP_EXT:
                out.append((f.relative_to(root).as_posix(), f))
    for rel in SINGLE:
        f = root / rel
        if f.is_file():
            out.append((rel, f))
    return sorted(out)


def _norm(data: bytes) -> bytes:
    return data.replace(b"\r\n", b"\n")


@lru_cache(maxsize=4)
def _info(root: str) -> dict:
    h = hashlib.sha256()
    for rel, f in files(Path(root)):
        h.update(rel.encode() + b"\0" + hashlib.sha256(_norm(f.read_bytes())).digest())
    req = Path(root) / "requirements.txt"
    deps = hashlib.sha256(_norm(req.read_bytes())).hexdigest()[:12] if req.is_file() else ""
    return {"build": h.hexdigest()[:16], "deps": deps}


def info(root: Path) -> dict:
    return dict(_info(str(root)))


def forget():
    _info.cache_clear()


def package(root: Path) -> bytes:
    """The update a standalone copy installs: the program files (no data, no Python)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for rel, f in files(root):
            z.write(f, rel)
    return buf.getvalue()


def check_dir(root: Path) -> str:
    """The build id of an unpacked package (to verify a download before switching to it)."""
    _info.cache_clear()
    try:
        return info(root)["build"]
    finally:
        _info.cache_clear()
