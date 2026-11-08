"""
Backups managed from the admin UI (both editions).

A backup is <data dir>/backups/tool-table-YYYYmmdd-HHMMSS.tar.gz with
  tool-table.db   consistent copy (SQLite online backup, safe while the app runs)
  icons/          the icon library
  .secret.key     so encrypted settings (AD service password) still work after a restore
  meta.json       version, time, reason
The schedule (daily time, days to keep) is a setting; the app runs it itself, no cron needed.
Restoring first takes a safety backup of the current state.
"""
import io
import json
import logging
import os
import re
import shutil
import sqlite3
import tarfile
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path

from . import config as C
from . import sysconfig
from .database import DB_DIR, DB_PATH

log = logging.getLogger("tool_table.backup")
BACKUP_DIR = DB_DIR / "backups"
NAME_RE = re.compile(r"^tool-table-\d{8}-\d{6}(-[a-z]+)?(-\d{1,3})?\.tar\.gz$")
MAX_UPLOAD = 500 * 1024 * 1024


def _dir() -> Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    return BACKUP_DIR


def safe_path(name: str) -> Path:
    if not NAME_RE.match(name or ""):
        raise ValueError("備份檔名不正確")
    return _dir() / name


def new_name(tag: str = "") -> Path:
    """tool-table-<stamp>[-tag][-n].tar.gz that does not exist yet."""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base = f"tool-table-{stamp}{('-' + tag) if tag else ''}"
    for n in range(0, 1000):
        p = _dir() / (f"{base}.tar.gz" if n == 0 else f"{base}-{n}.tar.gz")
        if not p.exists():
            return p
    raise RuntimeError("too many backups in one second")


def make_backup(reason: str = "manual") -> dict:
    from .main import VERSION
    target = new_name("" if reason in ("manual", "scheduled") else reason)
    with tempfile.TemporaryDirectory(dir=_dir()) as tmp:
        db_copy = Path(tmp) / "tool-table.db"
        src = sqlite3.connect(DB_PATH)
        dst = sqlite3.connect(db_copy)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
        partial = target.with_suffix(".partial")
        with tarfile.open(partial, "w:gz") as tar:
            tar.add(db_copy, arcname="tool-table.db")
            if C.ICON_DIR.is_dir():
                tar.add(C.ICON_DIR, arcname="icons", filter=lambda ti: None if ti.issym() or ti.islnk() else ti)
            if sysconfig.KEY_FILE.exists():
                tar.add(sysconfig.KEY_FILE, arcname=".secret.key")
            meta = json.dumps({"version": VERSION, "created": datetime.now().isoformat(timespec="seconds"),
                               "reason": reason}, ensure_ascii=False).encode()
            info = tarfile.TarInfo("meta.json")
            info.size = len(meta)
            info.mtime = int(time.time())
            tar.addfile(info, io.BytesIO(meta))
        os.chmod(partial, 0o600)
        os.replace(partial, target)
    return describe(target)


def describe(p: Path) -> dict:
    st = p.stat()
    return {"name": p.name, "size": st.st_size, "created": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
            "kind": "安全備份（還原前）" if "-before" in p.name else "上傳" if "-upload" in p.name else "備份"}


def list_backups() -> list:
    return [describe(p) for p in sorted(_dir().glob("tool-table-*.tar.gz"), reverse=True) if NAME_RE.match(p.name)]


def purge(keep_days: int) -> int:
    cutoff = time.time() - max(1, keep_days) * 86400
    n = 0
    for p in _dir().glob("tool-table-*.tar.gz"):
        if NAME_RE.match(p.name) and p.stat().st_mtime < cutoff:
            p.unlink(missing_ok=True)
            n += 1
    return n


def _check_members(tar: tarfile.TarFile):
    names = set()
    for m in tar.getmembers():
        n = m.name
        if n.startswith("/") or ".." in Path(n).parts or m.issym() or m.islnk() or m.isdev():
            raise ValueError(f"備份檔內容不安全：{n}")
        if not (n in ("tool-table.db", "meta.json", ".secret.key", "icons") or n.startswith("icons/")):
            raise ValueError(f"不是 Tool Table 的備份檔（多出 {n}）")
        names.add(n)
    if "tool-table.db" not in names:
        raise ValueError("備份檔裡沒有資料庫")


def restore(path: Path) -> dict:
    """Replace the database, icons and key with the backup's. A safety backup is taken first."""
    with tarfile.open(path, "r:gz") as tar:
        _check_members(tar)
        with tempfile.TemporaryDirectory(dir=_dir()) as tmp:
            try:
                tar.extractall(tmp, filter="data")
            except TypeError:                           # Python < 3.11.4: members were checked above
                tar.extractall(tmp)
            new_db = Path(tmp) / "tool-table.db"
            con = sqlite3.connect(new_db)
            try:
                ok = con.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
                con.execute("SELECT COUNT(*) FROM nodes")
            except sqlite3.Error as e:
                raise ValueError(f"備份裡的資料庫無法讀取：{e}")
            finally:
                con.close()
            if not ok:
                raise ValueError("備份裡的資料庫損壞（integrity_check 失敗）")
            safety = make_backup("before")
            staged = DB_PATH.with_suffix(".restoring")
            shutil.copy2(new_db, staged)
            os.replace(staged, DB_PATH)                 # connections are opened per request
            for extra in ("-wal", "-shm"):
                Path(str(DB_PATH) + extra).unlink(missing_ok=True)
            icons = Path(tmp) / "icons"
            if icons.is_dir():
                C.ICON_DIR.mkdir(parents=True, exist_ok=True)
                for old in C.ICON_DIR.iterdir():
                    if old.is_file():
                        old.unlink()
                for f in icons.iterdir():
                    if f.is_file():
                        shutil.copy2(f, C.ICON_DIR / f.name)
            key = Path(tmp) / ".secret.key"
            if key.exists():
                shutil.copy2(key, sysconfig.KEY_FILE)
                os.chmod(sysconfig.KEY_FILE, 0o600)
    sysconfig.invalidate()
    return {"restored": path.name, "safety_backup": safety["name"]}


def run_scheduled():
    """Called every minute: run the daily backup when its time has come."""
    cfg = sysconfig.backup()
    if not cfg.enabled:
        return
    now = datetime.now()
    try:
        hh, mm = (int(x) for x in cfg.time.split(":"))
    except ValueError:
        hh, mm = 3, 30
    due = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if now < due or cfg.last_run[:10] == now.date().isoformat():
        return
    try:
        b = make_backup("scheduled")
        removed = purge(cfg.keep_days)
        result = f"成功：{b['name']}" + (f"（清掉 {removed} 份過期備份）" if removed else "")
    except Exception as e:                      # never let the scheduler die
        log.exception("scheduled backup failed")
        result = f"失敗：{e}"
    sysconfig.save_backup({"last_run": now.isoformat(timespec="seconds"), "last_result": result})
