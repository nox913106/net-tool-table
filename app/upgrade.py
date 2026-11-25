"""
後台「版本紀錄」: the running version, every version in CHANGELOG.md, new versions on GitHub, and the
「升級到最新版」 button (same design as CFXD_DailyReportDocSys).

The service has no root rights and cannot upgrade itself. The button only drops a request file in
<data>/upgrade_request/; the tool-table-upgrade.path unit (root) sees it and runs
`tool-table.sh web-upgrade` — exactly what `tool-table.sh upgrade` does on the host (backup first →
git pull → packages → restart → health check). The request's content is never used (only whether it exists);
the source is always the installed git remote. Progress and the log are written by root to
/var/lib/tool-table-upgrade (readable, not writable, by the service).
"""
import json
import os
import re
import subprocess
import time
import urllib.request
from datetime import datetime
from pathlib import Path

from . import config as C
from .database import DB_DIR

APP_DIR = Path(__file__).resolve().parent.parent
REPO = "nox913106/net-tool-table"
CHANGELOG_URL = f"https://raw.githubusercontent.com/{REPO}/main/CHANGELOG.md"
UPGRADE_CMD = "sudo bash /opt/tool-table/scripts/tool-table.sh upgrade"
STATE_DIR = Path(os.environ.get("TOOL_TABLE_UPGRADE_STATE") or "/var/lib/tool-table-upgrade")
REQUEST = DB_DIR / "upgrade_request" / "request.json"
ROW = re.compile(r"^\|\s*(v\d+\.\d+\.\d+)\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*(.*)\|\s*$")
TYPES = {"X": "核心架構", "Y": "功能", "Z": "修正", "—": "初版"}
_cache: dict = {}


def _git(*args, timeout=10) -> str:
    try:
        r = subprocess.run(["git", "-c", f"safe.directory={APP_DIR}", "-C", str(APP_DIR), *args],
                           capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip() if r.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def current() -> dict:
    v = (APP_DIR / "VERSION").read_text().strip() if (APP_DIR / "VERSION").is_file() else "0.0.0"
    return {"version": v, "commit": _git("rev-parse", "--short=7", "HEAD")}


def parse(text: str) -> list:
    rows = []
    for line in (text or "").splitlines():
        m = ROW.match(line)
        if m:
            v, d, c, t, body = (x.strip() for x in m.groups())
            rows.append({"version": v, "date": d, "commit": c.strip("`"), "type": t, "text": body})
    return rows


def changelog() -> list:
    p = APP_DIR / "CHANGELOG.md"
    return parse(p.read_text(encoding="utf-8")) if p.is_file() else []


def _cached(key, fn, ttl=300):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    val = fn()
    _cache[key] = (time.time(), val)
    return val


def remote_head() -> str:
    """The newest commit on GitHub main ('' when the host cannot reach GitHub or this is not a git checkout)."""
    def get():
        out = _git("ls-remote", "origin", "refs/heads/main", timeout=15)
        return out.split()[0] if out else ""
    return _cached("head", get)


def _ver(v):
    return tuple(int(x) for x in re.findall(r"\d+", v)[:3])


def new_versions(cur: str):
    """Versions on GitHub newer than the running one (newest first); None when GitHub cannot be read."""
    def get():
        try:
            with urllib.request.urlopen(CHANGELOG_URL, timeout=8) as r:
                return r.read().decode("utf-8", "replace")
        except Exception:
            return None
    text = _cached("changelog", get)
    if text is None:
        return None
    return [r for r in parse(text) if _ver(r["version"]) > _ver(cur)]


def available() -> bool:
    """Is the host's upgrade trigger installed (it comes with an upgrade run on the host once)?"""
    if not C.AUTH:
        return False
    try:
        r = subprocess.run(["systemctl", "is-active", "tool-table-upgrade.path"], capture_output=True, text=True, timeout=5)
        return r.stdout.strip() == "active"
    except (OSError, subprocess.SubprocessError):
        return False


def log_tail(lines=80) -> str:
    try:
        text = (STATE_DIR / "upgrade.log").read_text(encoding="utf-8", errors="replace")[-20000:]
    except OSError:
        return ""
    return "\n".join(re.sub(r"\x1b\[[0-9;]*m", "", text).splitlines()[-lines:])


def status() -> dict:
    """{state: running / done / error, msg, from, to, at, pending, log}; state is empty if never upgraded."""
    st = {}
    try:
        st = json.loads((STATE_DIR / "status.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    st["pending"] = REQUEST.exists()
    st["log"] = log_tail()
    return st


def busy() -> bool:
    st = status()
    return st["pending"] or st.get("state") == "running"


def request(user: dict):
    REQUEST.parent.mkdir(parents=True, exist_ok=True)
    tmp = REQUEST.with_suffix(".tmp")
    tmp.write_text(json.dumps({"by": (user or {}).get("username"), "at": datetime.now().isoformat(timespec="seconds")}))
    os.replace(tmp, REQUEST)


def overview() -> dict:
    cur = current()
    head = remote_head()
    up_to_date = bool(head) and bool(cur["commit"]) and head.startswith(cur["commit"])
    new = [] if up_to_date or not head else new_versions(cur["version"])
    if new == []:                       # a different commit but no newer version on GitHub (e.g. running ahead of main)
        up_to_date = bool(head)
    rows = changelog()
    return {
        "current": cur, "rows": rows, "types": TYPES,
        "counts": {k: sum(1 for r in rows if r["type"] == k) for k in ("X", "Y", "Z")},
        "remote": head[:7], "up_to_date": up_to_date,
        "new": new,
        "available": available(), "server": C.AUTH, "status": status(), "cmd": UPGRADE_CMD, "repo": REPO,
    }
