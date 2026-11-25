"""
Backups managed from the admin UI (both editions) and from `tool-table.sh backup` (server).

Two kinds, on their own schedules (the app runs them itself, no cron needed):
  full         tool-table-YYYYmmdd-HHMMSS-full.tar.gz   everything
  incremental  tool-table-YYYYmmdd-HHMMSS-inc.tar.gz    the whole database + the files added or changed
                                                        since the previous backup
Every archive holds
  tool-table.db   consistent copy (SQLite online backup, safe while the app runs) — always complete
  .secret.key     so encrypted settings (AD service password, Entra secret, webhooks) still work after a restore
  icons/ attachments/   files (an incremental one: only the new / changed ones)
  manifest.json   EVERY file of that moment (size, mtime, sha256) and which archive holds it ("in"), the
                  database's checksum, and the check of database ↔ files (see check_refs)
  meta.json       version, time, reason, kind, base
An incremental backup therefore needs the archives its manifest names (its chain back to a full one):
restore collects each file from there and verifies its checksum; downloading an incremental backup
gives one complete archive built from the chain. Old backups go after the days to keep, except those
a kept backup still needs. Restoring first takes a full safety backup of the current state.
Backups from before manifests (tool-table-YYYYmmdd-HHMMSS.tar.gz) are full ones and still restore.
"""
import hashlib
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
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

from . import config as C
from . import images, sysconfig
from .database import DB_DIR, DB_PATH

log = logging.getLogger("tool_table.backup")
BACKUP_DIR = Path(os.environ.get("TOOL_TABLE_APP_BACKUP_DIR") or DB_DIR / "backups")
NAME_RE = re.compile(r"^tool-table-\d{8}-\d{6}(-[a-z]+)?(-\d{1,3})?\.tar\.gz$")
MAX_UPLOAD = 2 * 1024 * 1024 * 1024
KIND_LABEL = {"full": "完整", "inc": "增量", "before": "還原前（完整）", "upload": "上傳", "": "完整"}
FULL_KINDS = ("full", "before", "upload", "scheduled", "manual", "")


def _dir() -> Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    return BACKUP_DIR


def safe_path(name: str) -> Path:
    if not NAME_RE.match(name or ""):
        raise ValueError("備份檔名不正確")
    return _dir() / name


def kind_of(name: str) -> str:
    m = NAME_RE.match(name)
    return (m.group(1) or "-")[1:] if m else ""


def new_name(tag: str = "") -> Path:
    """tool-table-<stamp>[-tag][-n].tar.gz that does not exist yet."""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base = f"tool-table-{stamp}{('-' + tag) if tag else ''}"
    for n in range(0, 1000):
        p = _dir() / (f"{base}.tar.gz" if n == 0 else f"{base}-{n}.tar.gz")
        if not p.exists():
            return p
    raise RuntimeError("too many backups in one second")


def _sha(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _current_files() -> Dict[str, Path]:
    """Every file that belongs in a backup, by its name inside the archive."""
    out = {}
    if C.ICON_DIR.is_dir():
        for f in sorted(C.ICON_DIR.iterdir()):
            if f.is_file() and not f.is_symlink():
                out["icons/" + f.name] = f
    if images.IMAGE_DIR.is_dir():
        for f in sorted(images.IMAGE_DIR.iterdir()):
            if f.is_file() and not f.is_symlink() and not f.name.endswith(".part"):
                out["attachments/" + f.name] = f
    return out


def read_manifest(path: Path) -> Optional[dict]:
    """The manifest of a backup (None: a backup from before manifests — a full one). Files kept in the
    archive itself point at its current file name, whatever it was called when made (downloaded and
    uploaded again, it has another name)."""
    try:
        with tarfile.open(path, "r:gz") as tar:
            try:
                f = tar.extractfile("manifest.json")
            except KeyError:
                return None
            m = json.loads(f.read()) if f else None
    except (OSError, tarfile.TarError, ValueError):
        return None
    if not isinstance(m, dict):
        return None
    own = m.get("name")
    for v in m.get("files", {}).values():
        if v.get("in") in (own, ".", None):
            v["in"] = path.name
    m["name"] = path.name
    return m


def check_refs(db_file: Path, files: Dict[str, dict]) -> dict:
    """Database ↔ files: every attachment / synced file / icon the database names must be in the backup.
    `files` is the manifest's file list. Also: the database's own integrity check."""
    con = sqlite3.connect(db_file)
    try:
        ok = con.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        have_att = {k[len("attachments/"):] for k in files if k.startswith("attachments/")}
        have_icon = {k[len("icons/"):] for k in files if k.startswith("icons/")}

        def col(sql):
            try:
                return [r[0] for r in con.execute(sql).fetchall() if r[0]]
            except sqlite3.Error:
                return []
        att = col("SELECT stored FROM task_images WHERE COALESCE(pending, 0) = 0")
        blobs = col("SELECT stored FROM sync_blobs")
        icons = col("SELECT DISTINCT icon FROM nodes WHERE icon IS NOT NULL AND icon != '' AND icon NOT LIKE '%/%' AND icon NOT LIKE '%:%'")
        miss_att = sorted(set(a for a in att if a not in have_att))
        miss_blob = sorted(set(b for b in blobs if b not in have_att))
        miss_icon = sorted(set(i for i in icons if i not in have_icon))
        counts = {}
        for t in ("tasks", "task_comments", "task_images", "task_time", "nodes", "users", "notifications"):
            try:
                counts[t] = con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            except sqlite3.Error:
                pass
    finally:
        con.close()
    referenced = set(att) | set(blobs)
    return {"db_ok": ok, "attachments": len(set(att)), "synced_files": len(set(blobs)), "icons_used": len(set(icons)),
            "missing_attachments": miss_att[:50], "missing_synced": miss_blob[:50], "missing_icons": miss_icon[:50],
            "unreferenced_files": len([a for a in have_att if a not in referenced]), "rows": counts,
            "ok": ok and not miss_att and not miss_blob}


def _summary(chk: dict) -> str:
    if not chk:
        return ""
    if not chk.get("db_ok"):
        return "資料庫完整性檢查失敗"
    bad = len(chk.get("missing_attachments") or []) + len(chk.get("missing_synced") or [])
    if bad:
        return f"有 {bad} 個附件在資料庫裡有紀錄但檔案不見了"
    s = f"資料庫正常，{chk.get('attachments', 0)} 個附件全部對得上"
    if chk.get("missing_icons"):
        s += f"；{len(chk['missing_icons'])} 個圖示找不到"
    return s


def _latest_with_manifest() -> Optional[Path]:
    """The newest backup an incremental one can build on: it has a manifest and its whole chain is here."""
    for p in sorted(_dir().glob("tool-table-*.tar.gz"), key=lambda p: p.stat().st_mtime, reverse=True):
        if NAME_RE.match(p.name) and kind_of(p.name) in ("full", "inc", "before", "upload"):
            m = read_manifest(p)
            if m and chain_ok(m):
                return p
    return None


def chain_ok(manifest: dict) -> bool:
    return all((_dir() / n).exists() for n in {v["in"] for v in manifest.get("files", {}).values()} | {manifest.get("name")} if n)


def make_backup(reason: str = "manual", incremental: bool = False) -> dict:
    """A full backup, or an incremental one on top of the latest backup (a full one when there is none
    or its chain is incomplete)."""
    from .main import VERSION
    parent, pman = None, None
    if incremental:
        parent = _latest_with_manifest()
        pman = read_manifest(parent) if parent else None
        if not pman or not chain_ok(pman):
            incremental, parent, pman = False, None, None        # nothing to build on: a full one
    kind = "inc" if incremental else ("full" if reason in ("manual", "scheduled", "full") else reason)
    target = new_name(kind)
    files = _current_files()
    manifest_files = {}
    old = (pman or {}).get("files", {})
    to_add = []
    for arc, f in files.items():
        st = f.stat()
        prev = old.get(arc)
        if prev and prev.get("size") == st.st_size and int(prev.get("mtime", -1)) == int(st.st_mtime) and prev.get("sha256"):
            manifest_files[arc] = {**prev}                  # unchanged: kept in the archive that already has it
        else:
            manifest_files[arc] = {"size": st.st_size, "mtime": int(st.st_mtime), "sha256": _sha(f), "in": target.name}
            to_add.append(arc)
    with tempfile.TemporaryDirectory(dir=_dir()) as tmp:
        db_copy = Path(tmp) / "tool-table.db"
        src = sqlite3.connect(DB_PATH)
        dst = sqlite3.connect(db_copy)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
        chk = check_refs(db_copy, manifest_files)
        manifest = {"format": 2, "name": target.name, "kind": kind, "base": parent.name if parent else None,
                    "created": datetime.now().isoformat(timespec="seconds"), "version": VERSION,
                    "db": {"size": db_copy.stat().st_size, "sha256": _sha(db_copy)},
                    "files": manifest_files, "added": len(to_add), "check": chk}
        partial = target.with_suffix(".partial")
        with tarfile.open(partial, "w:gz") as tar:
            tar.add(db_copy, arcname="tool-table.db")
            for arc in to_add:
                tar.add(files[arc], arcname=arc)
            if sysconfig.KEY_FILE.exists():
                tar.add(sysconfig.KEY_FILE, arcname=".secret.key")
            for name, obj in (("manifest.json", manifest),
                              ("meta.json", {"version": VERSION, "created": manifest["created"], "reason": reason,
                                             "kind": kind, "base": manifest["base"]})):
                raw = json.dumps(obj, ensure_ascii=False).encode()
                info = tarfile.TarInfo(name)
                info.size = len(raw)
                info.mtime = int(time.time())
                tar.addfile(info, io.BytesIO(raw))
        os.chmod(partial, 0o600)
        os.replace(partial, target)
    return describe(target, manifest)


def describe(p: Path, manifest: Optional[dict] = None) -> dict:
    st = p.stat()
    k = kind_of(p.name)
    m = manifest if manifest is not None else read_manifest(p)
    out = {"name": p.name, "size": st.st_size, "created": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
           "kind": KIND_LABEL.get(k, "完整"), "type": "inc" if k == "inc" else "full"}
    if m:
        out.update(base=m.get("base"), files=len(m.get("files", {})), added=m.get("added"),
                   total=sum(v.get("size", 0) for v in m.get("files", {}).values()) + m.get("db", {}).get("size", 0),
                   check=_summary(m.get("check") or {}), check_ok=bool((m.get("check") or {}).get("ok")),
                   chain=sorted({v["in"] for v in m.get("files", {}).values()} - {p.name}),
                   complete=chain_ok(m))
    else:
        out.update(complete=True)
    return out


def list_backups() -> list:
    out = [describe(p) for p in sorted(_dir().glob("tool-table-*.tar.gz"), key=lambda p: p.name, reverse=True) if NAME_RE.match(p.name)]
    needed = {}
    for b in out:
        for n in b.get("chain") or []:
            needed.setdefault(n, []).append(b["name"])
    for b in out:
        b["needed_by"] = len(needed.get(b["name"], []))
    return out


def purge(keep_days: int) -> int:
    """Delete backups older than keep_days, except those a kept backup still needs (an incremental's chain),
    and never the newest full backup."""
    cutoff = time.time() - max(1, keep_days) * 86400
    all_ = [p for p in _dir().glob("tool-table-*.tar.gz") if NAME_RE.match(p.name)]
    keep = [p for p in all_ if p.stat().st_mtime >= cutoff]
    protected = set()
    for p in keep:
        m = read_manifest(p)
        if m:
            protected |= {v["in"] for v in m.get("files", {}).values()}
    fulls = sorted((p for p in all_ if kind_of(p.name) in FULL_KINDS and kind_of(p.name) != "upload"), key=lambda p: p.name)
    if fulls:
        protected.add(fulls[-1].name)
    n = 0
    for p in all_:
        if p.stat().st_mtime < cutoff and p.name not in protected:
            p.unlink(missing_ok=True)
            n += 1
    return n


def dependents(name: str) -> list:
    return [b["name"] for b in list_backups() if name in (b.get("chain") or [])]


def _check_members(tar: tarfile.TarFile):
    names = set()
    for m in tar.getmembers():
        n = m.name
        if n.startswith("/") or ".." in Path(n).parts or m.issym() or m.islnk() or m.isdev():
            raise ValueError(f"備份檔內容不安全：{n}")
        if not (n in ("tool-table.db", "meta.json", "manifest.json", ".secret.key", "icons", "attachments")
                or n.startswith("icons/") or n.startswith("attachments/")):
            raise ValueError(f"不是 IPMS 的備份檔（多出 {n}）")
        names.add(n)
    if "tool-table.db" not in names:
        raise ValueError("備份檔裡沒有資料庫")


def _extract(path: Path, dest: Path, only=None):
    with tarfile.open(path, "r:gz") as tar:
        _check_members(tar)
        members = [m for m in tar.getmembers() if only is None or m.name in only]
        try:
            tar.extractall(dest, members=members, filter="data")
        except TypeError:                               # Python < 3.11.4: members were checked above
            tar.extractall(dest, members=members)


def assemble(path: Path, dest: Path) -> dict:
    """Put the complete state of a backup into dest (database, key, every file from its chain) and
    verify it: each file's checksum, the database's checksum and integrity. Returns the manifest (or {})."""
    m = read_manifest(path)
    _extract(path, dest)
    if m:
        missing = [n for n in {v["in"] for v in m["files"].values()} if not (_dir() / n).exists() and n != path.name]
        if missing:
            raise ValueError("這份增量備份需要的備份檔不見了：" + "、".join(sorted(missing)))
        by_arch: Dict[str, list] = {}
        for arc, v in m["files"].items():
            if v["in"] != path.name:
                by_arch.setdefault(v["in"], []).append(arc)
        for arch, names in by_arch.items():
            _extract(_dir() / arch, dest, only=set(names))
        for arc, v in m["files"].items():
            f = dest / arc
            if not f.is_file():
                raise ValueError(f"備份裡缺少檔案：{arc}")
            if _sha(f) != v["sha256"]:
                raise ValueError(f"檔案內容和備份紀錄不符（可能損壞）：{arc}")
        if m.get("db", {}).get("sha256") and _sha(dest / "tool-table.db") != m["db"]["sha256"]:
            raise ValueError("備份裡的資料庫和紀錄不符（可能損壞）")
    con = sqlite3.connect(dest / "tool-table.db")
    try:
        ok = con.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        con.execute("SELECT COUNT(*) FROM nodes")
    except sqlite3.Error as e:
        raise ValueError(f"備份裡的資料庫無法讀取：{e}")
    finally:
        con.close()
    if not ok:
        raise ValueError("備份裡的資料庫損壞（integrity_check 失敗）")
    return m or {}


def consolidate(path: Path) -> Path:
    """One complete archive for this backup (an incremental one gathered from its chain), in a temp file."""
    with tempfile.TemporaryDirectory(dir=_dir()) as tmp:
        stage = Path(tmp) / "s"
        stage.mkdir()
        m = assemble(path, stage)
        out = Path(tempfile.mkstemp(dir=_dir(), suffix=".download")[1])
        with tarfile.open(out, "w:gz") as tar:
            for f in sorted(stage.rglob("*")):
                if f.is_file() and f.name not in ("manifest.json", "meta.json"):
                    tar.add(f, arcname=f.relative_to(stage).as_posix())
            if m:
                full = {**m, "kind": "full", "base": None, "files": {k: {**v, "in": "."} for k, v in m["files"].items()}}
                raw = json.dumps(full, ensure_ascii=False).encode()
                info = tarfile.TarInfo("manifest.json")
                info.size, info.mtime = len(raw), int(time.time())
                tar.addfile(info, io.BytesIO(raw))
        return out


def _keep_audit(staged: Path):
    """Copy the audit rows the backup does not have into the database about to be restored."""
    import sqlite3
    try:
        cur = sqlite3.connect(DB_PATH)
        rows = cur.execute("SELECT at, actor_id, actor, action, target, detail, ip, ok FROM audit_log ORDER BY id").fetchall()
        cur.close()
    except sqlite3.Error:
        return
    con = sqlite3.connect(staged)
    try:
        con.execute("""CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT,
                       at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime')),
                       actor_id INTEGER, actor TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT, ok INTEGER NOT NULL DEFAULT 1)""")
        last = con.execute("SELECT COALESCE(MAX(at), '') FROM audit_log").fetchone()[0]
        con.executemany("INSERT INTO audit_log (at, actor_id, actor, action, target, detail, ip, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        [r for r in rows if r[0] > last])
        con.commit()
    finally:
        con.close()


def restore(path: Path) -> dict:
    """Replace the database, icons, attachments and key with the backup's (gathered from its chain and
    verified first). A full safety backup is taken before anything changes."""
    with tempfile.TemporaryDirectory(dir=_dir()) as tmp:
        stage = Path(tmp)
        m = assemble(path, stage)
        safety = make_backup("before")
        staged = DB_PATH.with_suffix(".restoring")
        shutil.copy2(stage / "tool-table.db", staged)
        _keep_audit(staged)                              # 稽核紀錄 newer than the backup survive the restore
        os.replace(staged, DB_PATH)                      # connections are opened per request
        for extra in ("-wal", "-shm"):
            Path(str(DB_PATH) + extra).unlink(missing_ok=True)
        for sub, target, ok_name in (("icons", C.ICON_DIR, lambda n: True), ("attachments", images.IMAGE_DIR, images.path)):
            src = stage / sub
            if not src.is_dir() and not m:
                continue                                 # older backups without attachments: keep the current ones
            target.mkdir(parents=True, exist_ok=True)
            for old in target.iterdir():
                if old.is_file():
                    old.unlink()
            if src.is_dir():
                for f in src.iterdir():
                    if f.is_file() and ok_name(f.name):
                        shutil.copy2(f, target / f.name)
        key = stage / ".secret.key"
        if key.exists():
            shutil.copy2(key, sysconfig.KEY_FILE)
            os.chmod(sysconfig.KEY_FILE, 0o600)
    sysconfig.invalidate()
    return {"restored": path.name, "safety_backup": safety["name"], "files": len((m or {}).get("files", {}))}


def _due(cfg, now: datetime):
    """What the schedule wants now: 'full', 'inc' or None (after a failure: nothing for an hour)."""
    try:
        if cfg.last_fail and (now - datetime.fromisoformat(cfg.last_fail)).total_seconds() < 3600:
            return None
    except ValueError:
        pass
    try:
        hh, mm = (int(x) for x in cfg.time.split(":"))
    except ValueError:
        hh, mm = 3, 30
    at = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if cfg.enabled and now.weekday() in (cfg.full_days or []) and now >= at and (cfg.last_full or "")[:10] != now.date().isoformat():
        return "full"
    if cfg.inc_enabled:
        last = max(cfg.last_full or "", cfg.last_inc or "")
        try:
            age = (now - datetime.fromisoformat(last)).total_seconds() if last else None
        except ValueError:
            age = None
        if age is None or age >= max(1, cfg.inc_every_hours) * 3600:
            return "inc"
    return None


def run_scheduled():
    """Called every minute: run a full or incremental backup when its time has come."""
    cfg = sysconfig.backup()
    now = datetime.now()
    what = _due(cfg, now)
    if not what:
        return
    try:
        b = make_backup("scheduled", incremental=what == "inc")
        removed = purge(cfg.keep_days)
        kind = "增量" if b["type"] == "inc" else "完整"
        result = f"成功：{kind} {b['name']}" + (f"（{b.get('check')}）" if b.get("check") else "") \
            + (f"（清掉 {removed} 份過期備份）" if removed else "")
        if b.get("check_ok") is False:
            result = "警告：" + result[3:]
    except Exception as e:                      # never let the scheduler die
        log.exception("scheduled backup failed")
        result = f"失敗：{e}"
        b = {"type": what}
    stamp = now.isoformat(timespec="seconds")
    values = {"last_run": stamp, "last_result": result}
    if result.startswith("失敗"):
        values["last_fail"] = stamp             # try again in an hour, not every minute
    else:
        values["last_fail"] = ""
        values["last_full" if b.get("type") == "full" else "last_inc"] = stamp
    sysconfig.save_backup(values)
