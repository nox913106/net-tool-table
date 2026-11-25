"""
系統資訊 (後台): hardware, operating system, runtime, services, system packages and Python packages.

Read fresh every time (/proc, /sys, systemctl, dpkg-query, importlib.metadata); nothing is stored.
Runs as the service account (not root): what it cannot read shows as “無法取得” instead of failing the page.
Works on the Windows standalone copy too (sections that only exist on Linux are simply shorter).
"""
import importlib.metadata as md
import os
import platform
import re
import shutil
import socket
import sqlite3
import ssl
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

from . import config as C

UNITS = ("tool-table", "tool-table-apply.path", "tool-table-upgrade.path", "tool-table-backup.timer", "nginx")
TOOLS = (
    ("nginx", ["nginx", "-v"]),
    ("SQLite（指令）", ["sqlite3", "--version"]),
    ("OpenSSL（指令）", ["openssl", "version"]),
    ("git", ["git", "--version"]),
    ("curl", ["curl", "--version"]),
    ("systemd", ["systemctl", "--version"]),
)
APT = ("python3", "python3-venv", "python3-pip", "nginx", "openssl", "curl", "ca-certificates", "iproute2", "git")
APP_DIR = Path(__file__).resolve().parent.parent


def _run(cmd, timeout=8):
    exe = shutil.which(cmd[0]) or next((p for p in (f"/usr/sbin/{cmd[0]}", f"/sbin/{cmd[0]}") if os.path.exists(p)), None)
    if not exe:
        return None
    try:
        r = subprocess.run([exe, *cmd[1:]], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None
    return (r.stdout or r.stderr).strip()


def _read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read().strip()
    except OSError:
        return None


def size(n):
    if n is None:
        return "—"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


def _duration(sec):
    d = timedelta(seconds=int(sec))
    return (f"{d.days} 天 " if d.days else "") + f"{d.seconds // 3600} 小時 {d.seconds % 3600 // 60} 分"


def _safe(fn):
    try:
        return fn()
    except Exception as e:  # noqa: BLE001 — one section failing never breaks the page
        return [["無法取得", f"{type(e).__name__}: {str(e)[:200]}", ""]]


# ---------------------------------------------------------------- hardware
def hardware():
    rows = []
    cpu = _read("/proc/cpuinfo") or ""
    model = next((ln.split(":", 1)[1].strip() for ln in cpu.splitlines() if ln.lower().startswith(("model name", "hardware", "cpu model"))), None)
    phys = {ln.split(":", 1)[1].strip() for ln in cpu.splitlines() if ln.startswith("physical id")}
    cores = {ln.split(":", 1)[1].strip() for ln in cpu.splitlines() if ln.startswith("core id")}
    rows.append(["CPU 型號", model or platform.processor() or "—", platform.machine()])
    rows.append(["CPU 數量", f"{os.cpu_count()} 執行緒" + (f"、{len(phys)} 顆 × {len(cores)} 核" if phys and cores else ""), ""])
    if hasattr(os, "getloadavg"):
        rows.append(["系統負載", " / ".join(f"{x:.2f}" for x in os.getloadavg()), "1 / 5 / 15 分鐘平均"])
    mem = {}
    for ln in (_read("/proc/meminfo") or "").splitlines():
        k, _, v = ln.partition(":")
        if v.strip().endswith("kB"):
            mem[k] = int(v.split()[0]) * 1024
    if mem:
        total, avail = mem.get("MemTotal"), mem.get("MemAvailable")
        rows.append(["記憶體", f"{size(total)}，可用 {size(avail)}", f"已用 {(1 - avail / total) * 100:.0f}%" if total and avail else ""])
        rows.append(["Swap", f"{size(mem['SwapTotal'])}，可用 {size(mem.get('SwapFree'))}" if mem.get("SwapTotal") else "未設定", ""])
    vendor, product = _read("/sys/class/dmi/id/sys_vendor"), _read("/sys/class/dmi/id/product_name")
    if vendor or product:
        bios = _read("/sys/class/dmi/id/bios_version")
        rows.append(["主機型號", " ".join(x for x in (vendor, product) if x), f"BIOS {bios}" if bios else ""])
    virt = _run(["systemd-detect-virt"])
    if virt is not None:
        rows.append(["虛擬化", "實體機" if virt == "none" else virt, ""])
    for name in sorted(os.listdir("/sys/block")) if os.path.isdir("/sys/block") else []:
        if name.startswith(("loop", "ram", "zram", "sr", "dm-")):
            continue
        sectors = _read(f"/sys/block/{name}/size")
        if not sectors or sectors == "0":
            continue
        rot = _read(f"/sys/block/{name}/queue/rotational")
        model_ = _read(f"/sys/block/{name}/device/model") or ""
        rows.append([f"磁碟 {name}", size(int(sectors) * 512), " ".join(x for x in (model_, {"0": "SSD", "1": "HDD"}.get(rot, "")) if x)])
    return rows


def filesystems():
    """Where the program, data, attachments and backups live."""
    from . import backup, images
    from .database import DB_DIR
    paths = [("程式", APP_DIR), ("資料", DB_DIR), ("附件", images.IMAGE_DIR), ("圖示", C.ICON_DIR), ("備份", backup.BACKUP_DIR), ("根目錄", Path(os.path.abspath(os.sep)))]
    mounts = []
    for ln in (_read("/proc/mounts") or "").splitlines():
        p = ln.split()
        if len(p) >= 3:
            mounts.append((p[1].replace("\\040", " "), p[0], p[2]))
    rows, seen = [], set()
    for label, path in paths:
        path = str(path)
        if not os.path.exists(path):
            continue
        real = os.path.realpath(path)
        mp = max((m for m in mounts if real == m[0] or real.startswith(m[0].rstrip("/") + "/")), key=lambda m: len(m[0]), default=None)
        u = shutil.disk_usage(real)
        key = mp[0] if mp else os.path.splitdrive(real)[0] or real
        rows.append({"label": label, "path": path, "mount": mp[0] if mp else "—", "device": mp[1] if mp else "—",
                     "fstype": mp[2] if mp else "—", "total": size(u.total), "free": size(u.free),
                     "used_pct": round(u.used / u.total * 100) if u.total else 0, "dup": key in seen})
        seen.add(key)
    return rows


# ---------------------------------------------------------------- operating system
def operating_system():
    rows = []
    osr = {}
    for ln in (_read("/etc/os-release") or "").splitlines():
        k, _, v = ln.partition("=")
        osr[k] = v.strip('"')
    rows.append(["作業系統", osr.get("PRETTY_NAME") or platform.platform(), osr.get("VERSION_CODENAME", "")])
    rows.append(["核心", platform.release(), platform.version()[:80]])
    rows.append(["主機名稱", socket.gethostname(), socket.getfqdn() if socket.getfqdn() != socket.gethostname() else ""])
    up = _read("/proc/uptime")
    if up:
        sec = float(up.split()[0])
        rows.append(["開機時間", (datetime.now() - timedelta(seconds=sec)).strftime("%Y-%m-%d %H:%M"), f"已運作 {_duration(sec)}"])
    tz = _read("/etc/timezone") or (os.path.realpath("/etc/localtime").split("zoneinfo/")[-1] if os.path.exists("/etc/localtime") else "")
    rows.append(["時區", tz or time.tzname[0], datetime.now().astimezone().strftime("UTC%z")])
    sync = _run(["timedatectl", "show", "-p", "NTPSynchronized", "--value"])
    if sync:
        ntp = _run(["timedatectl", "show-timesync", "-p", "ServerName", "--value"])
        rows.append(["時間同步", "已同步" if sync == "yes" else "未同步", f"時間伺服器 {ntp}" if ntp else ""])
    rows.append(["語系", os.environ.get("LANG") or "—", ""])
    return rows


# ---------------------------------------------------------------- runtime
def runtime():
    from . import upgrade
    from .database import DB_PATH
    v = upgrade.current()
    rows = [["程式版本", f"v{v['version']}" + (f"（{v['commit']}）" if v.get("commit") else ""), str(APP_DIR)]]
    rows.append(["版本型態", "伺服器版（需要登入）" if C.AUTH else "單機版 / 開發模式（不需登入）", ""])
    rows.append(["Python", f"{platform.python_implementation()} {platform.python_version()}", sys.executable])
    venv = sys.prefix != getattr(sys, "base_prefix", sys.prefix)
    rows.append(["虛擬環境", sys.prefix if venv else "未使用", f"基底 {sys.base_prefix}" if venv else ""])
    try:
        import pwd
        user = pwd.getpwuid(os.geteuid()).pw_name
    except (ImportError, KeyError, AttributeError):
        user = os.environ.get("USERNAME") or "—"
    rows.append(["服務程序", f"PID {os.getpid()}，帳號 {user}", "uvicorn"])
    rows.append(["OpenSSL（Python）", ssl.OPENSSL_VERSION, ""])
    rows.append(["SQLite 函式庫", sqlite3.sqlite_version, "Python 內建 sqlite3 模組連結的版本"])
    try:
        con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
        mode = con.execute("PRAGMA journal_mode").fetchone()[0]
        pages, psize = con.execute("PRAGMA page_count").fetchone()[0], con.execute("PRAGMA page_size").fetchone()[0]
        con.close()
        total = sum(os.path.getsize(f) for f in (str(DB_PATH), str(DB_PATH) + "-wal") if os.path.exists(f))
        rows.append(["資料庫", f"SQLite，{size(total)}", f"{DB_PATH}；journal {mode}；{pages} 頁 × {psize} B"])
    except sqlite3.Error as e:
        rows.append(["資料庫", "無法取得", str(e)])
    for label, cmd in TOOLS:
        out = _run(cmd)
        line = (out or "").splitlines()[0] if out else None
        rows.append([label, re.sub(r"^nginx version: ", "", line) if line else "未安裝或無法執行", ""])
    return rows


# ---------------------------------------------------------------- services
def services():
    props = "LoadState,ActiveState,SubState,UnitFileState,MainPID,ActiveEnterTimestamp,MemoryCurrent,NRestarts"
    rows = []
    for unit in UNITS:
        out = _run(["systemctl", "show", unit, "-p", props])
        p = dict(ln.split("=", 1) for ln in (out or "").splitlines() if "=" in ln)
        if not p.get("ActiveState"):
            return []                                   # not run by systemd (standalone copy, container, dev)
        mem, since = p.get("MemoryCurrent", ""), p.get("ActiveEnterTimestamp", "")
        rows.append({"unit": unit, "ok": p.get("ActiveState") == "active",
                     "state": f"{p.get('ActiveState', '?')}（{p.get('SubState', '?')}）" if p.get("LoadState") != "not-found" else "未安裝",
                     "enabled": p.get("UnitFileState", ""), "pid": p.get("MainPID") if p.get("MainPID") not in (None, "0") else "",
                     "since": since.split(" ", 1)[1] if " " in since else since,
                     "memory": size(int(mem)) if mem.isdigit() else "", "restarts": p.get("NRestarts", "")})
    return rows


# ---------------------------------------------------------------- packages
def system_packages():
    out = _run(["dpkg-query", "-W", "-f", "${Package}\t${Version}\t${db:Status-Abbrev}\t${binary:Summary}\n"], timeout=20)
    if out is None:
        return None, 0
    allpk = {}
    for ln in out.splitlines():
        p = ln.split("\t")
        if len(p) >= 3 and p[2].startswith("ii"):
            allpk[p[0].split(":")[0]] = (p[1], p[3] if len(p) > 3 else "")
    rows = [{"name": n, "version": allpk[n][0] if n in allpk else "未安裝", "summary": allpk.get(n, ("", ""))[1], "installed": n in allpk}
            for n in APT + ("systemd-timesyncd", "libsqlite3-0", "libssl3", "libssl3t64") if n in allpk or n in APT]
    return rows, len(allpk)


def _norm(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def python_packages():
    req = {}
    for ln in (_read(APP_DIR / "requirements.txt") or "").splitlines():
        m = re.match(r"^\s*([A-Za-z0-9_.\-\[\]]+)\s*(==|>=|~=|<=|>|<)?\s*([^\s;#]*)", ln)
        if m and m.group(1) and not ln.lstrip().startswith("#"):
            req[_norm(m.group(1).split("[")[0])] = (m.group(2) or "", m.group(3) or "")
    rows, seen = [], set()
    for dist in md.distributions():
        name = dist.metadata.get("Name") or "?"
        key = _norm(name)
        if key in seen:
            continue
        seen.add(key)
        op, want = req.get(key, ("", ""))
        rows.append({"name": name, "version": dist.version, "summary": (dist.metadata.get("Summary") or "")[:120],
                     "direct": key in req, "required": f"{op}{want}" if want else ("✓" if key in req else None),
                     "mismatch": bool(op == "==" and want and want != dist.version)})
    for key, (op, want) in req.items():
        if key not in seen:
            rows.append({"name": key, "version": "未安裝", "summary": "", "direct": True, "required": f"{op}{want}" or "✓", "mismatch": True})
    rows.sort(key=lambda r: (not r["direct"], r["name"].lower()))
    return rows


def all_system_packages():
    out = _run(["dpkg-query", "-W", "-f", "${Package}\t${Version}\t${db:Status-Abbrev}\n"], timeout=20) or ""
    return sorted((p[0], p[1]) for p in (ln.split("\t") for ln in out.splitlines()) if len(p) >= 3 and p[2].startswith("ii"))


def collect():
    t0 = time.monotonic()
    try:
        pk, n_all = system_packages()
    except Exception:  # noqa: BLE001
        pk, n_all = None, 0
    info = {"generated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "hardware": _safe(hardware), "filesystems": _safe(filesystems),
            "os": _safe(operating_system), "runtime": _safe(runtime), "services": _safe(services),
            "system_packages": pk, "system_packages_total": n_all, "python_packages": _safe(python_packages)}
    info["elapsed"] = f"{time.monotonic() - t0:.2f}"
    return info
