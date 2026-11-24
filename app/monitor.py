"""
System and hardware checks for the server edition, with Teams alerts.

Every minute: disk space (the data disk and /), memory, CPU load, temperature (when the machine exposes
sensors), software RAID, reboots, the daily backup, the HTTPS certificate, nginx; every ten minutes: AD and
Microsoft Entra ID reachability; every hour: a database quick check. Each check is ok / warn / fail.
A check that becomes warn or fail sends an alert to the Teams channels that want “system”; while it stays
wrong a reminder goes out every few hours (setting), and a recovery notice when it is fine again. At the
scheduled times a status report goes to the channels that want “health”. Thresholds are settings.
"""
import glob
import json
import os
import shutil
import subprocess
import time
from datetime import datetime
from typing import Dict, List, Optional

from . import sysconfig

STATE_KEY = "_monitor_state"
_last = {"slow": 0.0, "hourly": 0.0, "results": {}}


def _item(out, key, group, name, level, detail, value=None):
    out.append({"key": key, "group": group, "name": name, "level": level, "detail": detail, "value": value})


def _gb(n):
    return f"{n / 1024 ** 3:.1f} GB"


def checks(c=None, slow: bool = False, hourly: bool = False, lang: str = "zh-TW") -> List[dict]:
    """Run the checks; slow / hourly ones only when asked (their last result is reused otherwise)."""
    c = c or sysconfig.teams()
    en = lang == "en"
    Z = lambda zh, e: e if en else zh
    out: List[dict] = []
    # ---------------- disks
    from .database import DB_DIR
    seen = set()
    for label, path in ((Z("資料磁碟", "Data disk"), str(DB_DIR)), (Z("系統磁碟", "System disk"), "/")):
        try:
            st = os.stat(path)
            if st.st_dev in seen:
                continue
            seen.add(st.st_dev)
            u = shutil.disk_usage(path)
            pct = u.used / u.total * 100 if u.total else 0
            lvl = "fail" if pct >= c.disk_fail else "warn" if pct >= c.disk_warn else "ok"
            _item(out, f"disk:{path}", Z("儲存空間", "Storage"), f"{label}（{path}）" if not en else f"{label} ({path})", lvl,
                  Z(f"已用 {_gb(u.used)} / 共 {_gb(u.total)}（{pct:.0f}%），剩 {_gb(u.free)}",
                    f"{_gb(u.used)} used of {_gb(u.total)} ({pct:.0f}%), {_gb(u.free)} free"), round(pct, 1))
        except OSError:
            pass
    # ---------------- memory
    try:
        with open("/proc/meminfo") as f:
            mem = {ln.split(":")[0]: int(ln.split()[1]) for ln in f if ":" in ln}
        total, avail = mem.get("MemTotal", 0), mem.get("MemAvailable", 0)
        if total:
            free = avail / total * 100
            lvl = "fail" if free <= c.mem_fail else "warn" if free <= c.mem_warn else "ok"
            _item(out, "mem", Z("硬體", "Hardware"), Z("記憶體", "Memory"), lvl,
                  Z(f"可用 {avail // 1024} MB / 共 {total // 1024} MB（{free:.0f}%）", f"{avail // 1024} MB available of {total // 1024} MB ({free:.0f}%)"), round(free, 1))
        st, sf = mem.get("SwapTotal", 0), mem.get("SwapFree", 0)
        if st:
            used = (st - sf) / st * 100
            _item(out, "swap", Z("硬體", "Hardware"), Z("置換空間（swap）", "Swap"), "warn" if used >= 50 else "ok",
                  Z(f"已用 {used:.0f}%", f"{used:.0f}% used"), round(used, 1))
    except OSError:
        pass
    # ---------------- CPU load
    try:
        l1, l5, l15 = os.getloadavg()
        cores = os.cpu_count() or 1
        per = l5 / cores
        lvl = "fail" if per >= c.load_fail else "warn" if per >= c.load_warn else "ok"
        _item(out, "load", Z("硬體", "Hardware"), Z("CPU 負載", "CPU load"), lvl,
              Z(f"5 分鐘平均 {l5:.2f}（{cores} 核，每核 {per:.2f}）", f"5-minute average {l5:.2f} ({cores} cores, {per:.2f} per core)"), round(per, 2))
    except OSError:
        pass
    # ---------------- temperature (when the machine exposes sensors; most VMs do not)
    temps = []
    for p in glob.glob("/sys/class/thermal/thermal_zone*/temp") + glob.glob("/sys/class/hwmon/hwmon*/temp*_input"):
        try:
            v = int(open(p).read().strip()) / 1000
            if 0 < v < 150:
                temps.append(v)
        except (OSError, ValueError):
            pass
    if temps:
        t = max(temps)
        lvl = "fail" if t >= c.temp_fail else "warn" if t >= c.temp_warn else "ok"
        _item(out, "temp", Z("硬體", "Hardware"), Z("溫度", "Temperature"), lvl, Z(f"最高 {t:.0f}°C", f"highest {t:.0f}°C"), round(t, 1))
    # ---------------- software RAID
    try:
        md = open("/proc/mdstat").read()
        for line in md.splitlines():
            if "[" in line and "_" in line.split("[")[-1] and "]" in line:
                _item(out, "raid", Z("硬體", "Hardware"), "RAID", "fail", Z(f"磁碟陣列降級：{line.strip()}", f"array degraded: {line.strip()}"))
                break
        else:
            if "md" in md:
                _item(out, "raid", Z("硬體", "Hardware"), "RAID", "ok", Z("磁碟陣列正常", "arrays healthy"))
    except OSError:
        pass
    # ---------------- reboots
    try:
        boot = next(int(ln.split()[1]) for ln in open("/proc/stat") if ln.startswith("btime"))
        _item(out, "boot", Z("系統", "System"), Z("開機時間", "Boot time"), "ok",
              Z(f"{datetime.fromtimestamp(boot):%Y-%m-%d %H:%M} 開機", f"up since {datetime.fromtimestamp(boot):%Y-%m-%d %H:%M}"), boot)
    except (OSError, StopIteration):
        pass
    # ---------------- backups
    b = sysconfig.backup()
    if b.enabled:
        age_h = None
        if b.last_run:
            try:
                age_h = (datetime.now() - datetime.fromisoformat(b.last_run)).total_seconds() / 3600
            except ValueError:
                pass
        if b.last_result.startswith("失敗"):
            lvl, d = "fail", Z(f"上次自動備份失敗：{b.last_result[3:]}", f"the last automatic backup failed: {b.last_result[3:]}")
        elif age_h is None or age_h > c.backup_hours:
            lvl, d = "warn", Z(f"超過 {c.backup_hours} 小時沒有成功的自動備份", f"no successful automatic backup for over {c.backup_hours} hours")
        else:
            lvl, d = "ok", Z(f"{b.last_run.replace('T', ' ')[:16]} 備份成功", f"backed up {b.last_run.replace('T', ' ')[:16]}")
        _item(out, "backup", Z("系統", "System"), Z("自動備份", "Automatic backup"), lvl, d)
    # ---------------- HTTPS certificate
    cert_file = os.environ.get("TOOL_TABLE_TLS_CERT") or "/etc/tool-table/tls/server.crt"
    if os.path.exists(cert_file):
        try:
            from cryptography import x509
            cert = x509.load_pem_x509_certificates(open(cert_file, "rb").read())[0]
            end = getattr(cert, "not_valid_after_utc", None) or cert.not_valid_after
            days = (end.replace(tzinfo=None) - datetime.utcnow()).days
            lvl = "fail" if days <= c.cert_fail else "warn" if days <= c.cert_warn else "ok"
            _item(out, "cert", Z("系統", "System"), Z("HTTPS 憑證", "HTTPS certificate"), lvl,
                  Z(f"還有 {days} 天到期（{end:%Y-%m-%d}）", f"expires in {days} days ({end:%Y-%m-%d})"), days)
        except Exception as e:
            _item(out, "cert", Z("系統", "System"), Z("HTTPS 憑證", "HTTPS certificate"), "warn", str(e)[:120])
    # ---------------- nginx
    if shutil.which("systemctl") and os.path.exists("/etc/nginx") and os.path.isdir("/run/systemd/system"):
        try:
            state = subprocess.run(["systemctl", "is-active", "nginx"], capture_output=True, text=True, timeout=5).stdout.strip()
            if state in ("active", "inactive", "failed", "activating", "deactivating"):
                _item(out, "nginx", Z("服務", "Services"), "nginx", "ok" if state == "active" else "fail",
                      Z("執行中", "running") if state == "active" else state)
        except (OSError, subprocess.SubprocessError):
            pass
    # ---------------- every ten minutes: directories
    if slow:
        from . import entra, ldapauth
        if ldapauth.enabled():
            try:
                ok = _ldap_reachable()
                _item(out, "ldap", Z("服務", "Services"), "AD（LDAP）", "ok" if ok else "fail",
                      Z("可以連線", "reachable") if ok else Z("連不到任何網域控制站", "no domain controller reachable"))
            except Exception as e:
                _item(out, "ldap", Z("服務", "Services"), "AD（LDAP）", "fail", str(e)[:160])
        if entra.enabled():
            try:
                entra._http("GET", f"{entra.LOGIN}/{sysconfig.entra().tenant_id}/v2.0/.well-known/openid-configuration", timeout=8)
                _item(out, "entra", Z("服務", "Services"), "Microsoft Entra ID", "ok", Z("可以連線", "reachable"))
            except Exception as e:
                _item(out, "entra", Z("服務", "Services"), "Microsoft Entra ID", "warn", str(e)[:160])
    # ---------------- every hour: the database
    if hourly:
        try:
            import sqlite3
            from .database import DB_PATH
            with sqlite3.connect(DB_PATH, timeout=10) as db:
                r = db.execute("PRAGMA quick_check").fetchone()[0]
            _item(out, "db", Z("系統", "System"), Z("資料庫", "Database"), "ok" if r == "ok" else "fail",
                  Z("檢查正常", "check passed") if r == "ok" else r[:160])
        except Exception as e:
            _item(out, "db", Z("系統", "System"), Z("資料庫", "Database"), "fail", str(e)[:160])
    return out


def _ldap_reachable() -> bool:
    import socket
    from urllib.parse import urlsplit
    url = sysconfig.ldap().url
    for u in [x.strip() for x in url.replace(";", ",").replace(" ", ",").split(",") if x.strip()]:
        p = urlsplit(u if "://" in u else "ldap://" + u)
        port = p.port or (636 if p.scheme == "ldaps" else 389)
        try:
            with socket.create_connection((p.hostname, port), timeout=4):
                return True
        except OSError:
            continue
    return False


# ------------------------------------------------------------------ alerts
def _state() -> dict:
    import sqlite3
    from .database import DB_PATH
    try:
        with sqlite3.connect(DB_PATH) as db:
            r = db.execute("SELECT value FROM settings WHERE key = ?", (STATE_KEY,)).fetchone()
        return json.loads(r[0]) if r else {}
    except Exception:
        return {}


def _save_state(st: dict):
    import sqlite3
    from .database import DB_PATH
    with sqlite3.connect(DB_PATH) as db:
        db.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                   (STATE_KEY, json.dumps(st, ensure_ascii=False)))


async def tick(now: Optional[float] = None) -> int:
    """Called every minute (server edition): run the checks, queue alerts and recoveries, the scheduled report."""
    import asyncio
    from . import teams
    now = now or time.time()
    c = sysconfig.teams()
    want_alerts, want_report = teams.active_channels("system", c), teams.active_channels("health", c)
    if not (want_alerts or want_report):
        return 0
    slow = now - _last["slow"] >= 600
    hourly = now - _last["hourly"] >= 3600
    L = teams.lang(c)
    items = await asyncio.get_running_loop().run_in_executor(None, lambda: checks(c, slow, hourly, L))
    if slow:
        _last["slow"] = now
    if hourly:
        _last["hourly"] = now
    # results of the slow / hourly checks are kept between runs
    for it in items:
        if it["key"] in ("ldap", "entra", "db"):
            _last["results"][it["key"]] = it
    have = {it["key"] for it in items}
    items += [v for k, v in _last["results"].items() if k not in have]
    st = _state()
    sent = 0
    en = L == "en"
    base = teams.site_url(c)
    msgs = []
    # reboots: the boot time changed
    boot = next((it for it in items if it["key"] == "boot"), None)
    if boot and st.get("boot") and st["boot"] != boot["value"]:
        msgs.append(("warn", ("[Restart] The server restarted" if en else "【重新開機】伺服器重新開機了"), [boot["detail"]]))
    if boot:
        st["boot"] = boot["value"]
    repeat = float(c.repeat_hours or 0) * 3600
    checks_st = st.setdefault("checks", {})
    for it in items:
        if it["key"] == "boot":
            continue
        prev = checks_st.get(it["key"], {"level": "ok", "at": 0})
        lvl = it["level"]
        title = f"{it['group']} / {it['name']}"
        if lvl != "ok" and (prev["level"] == "ok" or (lvl == "fail" and prev["level"] == "warn")):
            tag = ("[Alert]" if lvl == "fail" else "[Warning]") if en else ("【告警】" if lvl == "fail" else "【注意】")
            msgs.append((lvl, f"{tag} {title}", [it["detail"]]))
            checks_st[it["key"]] = {"level": lvl, "since": now, "at": now}
        elif lvl != "ok" and repeat and now - prev.get("at", 0) >= repeat:
            hours = (now - prev.get("since", now)) / 3600
            tag = ("[Still wrong]" if en else "【仍未恢復】")
            msgs.append((lvl, f"{tag} {title}", [it["detail"], f"{hours:.1f} h" if en else f"已持續 {hours:.1f} 小時"]))
            checks_st[it["key"]] = {**prev, "level": lvl, "at": now}
        elif lvl == "ok" and prev["level"] != "ok":
            msgs.append(("ok", f"{'[Recovered]' if en else '【已恢復】'} {title}", [it["detail"]]))
            checks_st[it["key"]] = {"level": "ok", "at": now}
        elif lvl != "ok":
            checks_st[it["key"]] = {**prev, "level": lvl}
    _save_state(st)
    from .database import get_db
    db = await get_db()
    try:
        for lvl, title, lines in msgs:
            for ch in want_alerts:
                await teams.enqueue(db, ch["id"], "system", teams.card(title, lines, f"{base}/admin#system", lvl,
                                                                       "Open system settings" if en else "開啟系統設定"))
                sent += 1
        # the scheduled report
        if want_report and _report_due(c, st):
            st["report"] = datetime.now().isoformat(timespec="minutes")
            _save_state(st)
            payload = report(items, c, L)
            if payload:
                for ch in want_report:
                    await teams.enqueue(db, ch["id"], "health", payload)
                    sent += 1
        await db.commit()
    finally:
        await db.close()
    return sent


def _report_due(c, st) -> bool:
    now = datetime.now()
    slots = []
    for t in str(c.health_times or "").replace("，", ",").split(","):
        try:
            h, m = (int(x) for x in t.strip().split(":"))
            slots.append(now.replace(hour=h, minute=m, second=0, microsecond=0))
        except ValueError:
            continue
    past = [s for s in slots if s <= now]
    if not past:
        return False
    return (st.get("report") or "") < past[-1].isoformat(timespec="minutes")


def report(items: List[dict], c, L: str) -> Optional[dict]:
    from . import teams
    en = L == "en"
    bad = [it for it in items if it["level"] != "ok"]
    if not bad and c.health_only_abnormal:
        return None
    n = {k: sum(1 for it in items if it["level"] == k) for k in ("ok", "warn", "fail")}
    title = (f"[System status] OK {n['ok']}, warning {n['warn']}, alert {n['fail']}" if en
             else f"【系統狀態】正常 {n['ok']}、注意 {n['warn']}、告警 {n['fail']}")
    lines = [f"• [{'Alert' if it['level'] == 'fail' else 'Warning'}] {it['group']} / {it['name']}: {it['detail']}" if en
             else f"• [{'告警' if it['level'] == 'fail' else '注意'}] {it['group']} / {it['name']}：{it['detail']}" for it in bad]
    if not bad:
        lines.append("Everything is fine." if en else "全部正常。")
    disks = [f"• {it['name']}: {it['detail']}" if en else f"• {it['name']}：{it['detail']}" for it in items if it["key"].startswith("disk:")]
    if disks:
        lines += ["", "Storage:" if en else "儲存空間："] + disks
    level = "fail" if n["fail"] else "warn" if n["warn"] else "ok"
    return teams.card(title, lines, f"{teams.site_url(c)}/admin#system", level, "Open system settings" if en else "開啟系統設定")
