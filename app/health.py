"""
後台「系統狀態」: one health-check table (like CFXD_DailyReportDocSys).

The hardware / service checks of app/monitor.py, plus checks of the configuration (sign-in, administrators,
the secret key, background work, upgrades). Every item: group, name, level ok / warn / fail, detail, and for
anything not ok a hint (→ what to do). The last run is kept (settings key _health_last) so the page opens
instantly; 「立即檢查」 runs everything again, including the slow checks (AD, Entra, database integrity).
"""
import asyncio
import json
from datetime import datetime
from typing import List

from . import config as C
from . import sysconfig

LAST_KEY = "_health_last"

HINTS = {
    "disk": "清理舊備份或附件，或擴充磁碟；備份位置可改到另一顆磁碟或 NAS（備份還原）",
    "mem": "關掉主機上不需要的程式，或增加記憶體",
    "swap": "記憶體不足時才會用到 swap；長期偏高請增加記憶體",
    "load": "看「系統資訊 → 服務」哪個程序在忙；持續偏高請增加 CPU",
    "temp": "檢查主機散熱、風扇與機房溫度",
    "raid": "立即更換故障的磁碟並重建陣列",
    "backup": "到「備份還原」按「立即完整備份」，並確認備份位置有空間",
    "cert": "到「HTTPS 憑證」換上新的憑證（或重新產生自簽憑證）",
    "nginx": "在主機執行 sudo systemctl status nginx，或 sudo bash /opt/tool-table/scripts/tool-table.sh doctor",
    "ldap": "確認 DNS、防火牆與網域控制站；在「AD 驗證」按「測試」看詳細原因",
    "entra": "確認主機能連到 login.microsoftonline.com；在「AD 驗證」測試 Microsoft 登入",
    "db": "資料庫檢查失敗：先到「備份還原」下載最近的備份，再聯絡維護人員",
    "auth": "到「AD 驗證」啟用 AD 或 Microsoft 登入；本機管理員帳號只留作緊急使用",
    "admins": "AD 帳號登入一次後，到「帳號管理」把至少一位設為系統管理員",
    "key": "金鑰遺失時已加密的密碼（AD 服務帳號、Entra 用戶端密碼）要重新輸入",
    "teams": "到「發送與通知」按「測試」看是哪個頻道送不出去",
    "upgrade": "到「版本紀錄」看新版內容並按「升級到最新版」",
    "upgrade_svc": "在主機執行一次 sudo bash /opt/tool-table/scripts/tool-table.sh upgrade，之後就能在網頁升級",
}


def _it(group, key, name, level, detail):
    return {"key": key, "group": group, "name": name, "level": level, "detail": detail}


async def _config_checks() -> List[dict]:
    from .database import get_db
    from . import upgrade
    out = []
    G = "設定"
    if C.AUTH:
        L, E = sysconfig.ldap(), sysconfig.entra()
        modes = [x for x, on in (("AD（LDAP）", L.enabled), ("Microsoft Entra ID", E.enabled)) if on]
        out.append(_it(G, "auth", "登入方式", "ok" if modes else "warn",
                       "、".join(modes) + "，另有本機緊急帳號" if modes else "只有本機管理員帳號"))
        db = await get_db()
        try:
            cur = await db.execute("SELECT COUNT(*) FROM users WHERE source IN ('ldap', 'entra') AND role = 'sysadmin' AND active = 1")
            n_ad = (await cur.fetchone())[0]
            cur = await db.execute("SELECT COUNT(*) FROM users WHERE active = 1")
            n_all = (await cur.fetchone())[0]
            cur = await db.execute("SELECT COUNT(*), SUM(CASE WHEN sent_at IS NULL AND attempts >= 3 THEN 1 ELSE 0 END) FROM teams_queue WHERE sent_at IS NULL")
            q_wait, q_fail = await cur.fetchone()
            cur = await db.execute("SELECT COUNT(*), MIN(at) FROM audit_log")
            a_n, a_first = await cur.fetchone()
        finally:
            await db.close()
        out.append(_it(G, "admins", "系統管理員", "ok" if n_ad else "warn", f"AD／Microsoft 帳號 {n_ad} 位；啟用中的帳號共 {n_all} 位"))
        out.append(_it("背景工作", "teams", "Teams 通知佇列", "warn" if q_fail else "ok",
                       f"等待送出 {q_wait or 0} 則" + (f"，其中 {q_fail} 則重試多次仍失敗" if q_fail else "")))
    else:
        from .database import get_db
        db = await get_db()
        try:
            cur = await db.execute("SELECT COUNT(*), MIN(at) FROM audit_log")
            a_n, a_first = await cur.fetchone()
        finally:
            await db.close()
        out.append(_it(G, "auth", "版本型態", "ok", "單機版／開發模式（不需登入）"))
    out.append(_it(G, "key", "加密金鑰", "ok" if sysconfig.KEY_FILE.exists() else "warn",
                   str(sysconfig.KEY_FILE) if sysconfig.KEY_FILE.exists() else "還沒有產生（第一次儲存密碼時自動建立）"))
    from . import audit
    out.append(_it("背景工作", "audit", "稽核紀錄", "ok", f"{a_n or 0} 筆，最早 {(a_first or '—')[:10]}；保存 {audit.keep_days()} 天"))
    cur = upgrade.current()
    loop = asyncio.get_running_loop()
    if C.AUTH:
        head = await loop.run_in_executor(None, upgrade.remote_head)
        if not head:
            out.append(_it("版本", "upgrade", "程式版本", "ok", f"v{cur['version']}（{cur['commit'] or '—'}）；無法連線到 GitHub 檢查新版"))
        elif cur["commit"] and head.startswith(cur["commit"]):
            out.append(_it("版本", "upgrade", "程式版本", "ok", f"v{cur['version']}（{cur['commit']}），已是最新版"))
        else:
            new = await loop.run_in_executor(None, upgrade.new_versions, cur["version"])
            if new == []:
                out.append(_it("版本", "upgrade", "程式版本", "ok", f"v{cur['version']}（{cur['commit'] or '—'}）；GitHub 上沒有更新的版本"))
            else:
                out.append(_it("版本", "upgrade", "程式版本", "warn",
                               f"v{cur['version']}（{cur['commit'] or '—'}）；GitHub 上有新版" + (f" {new[0]['version']}" if new else f"（{head[:7]}）")))
        avail = await loop.run_in_executor(None, upgrade.available)
        out.append(_it("版本", "upgrade_svc", "網頁升級服務", "ok" if avail else "warn",
                       "tool-table-upgrade.path 已啟用" if avail else "主機尚未安裝（升級一次後就會有）"))
    else:
        out.append(_it("版本", "upgrade", "程式版本", "ok", f"v{cur['version']}；單機版從連線的伺服器自動更新"))
    return out


async def run(manual: bool = False) -> dict:
    from . import monitor
    loop = asyncio.get_running_loop()
    try:
        items = await loop.run_in_executor(None, lambda: monitor.checks(sysconfig.teams(), True, True, "zh-TW"))
    except Exception as e:  # noqa: BLE001 — e.g. a standalone copy on Windows without /proc
        items = [_it("系統", "monitor", "硬體與服務檢查", "warn", f"無法執行：{e}")]
    items = [dict(x) for x in items] + await _config_checks()
    for it in items:
        if it["level"] != "ok":
            base = it["key"].split(":")[0]
            it["hint"] = HINTS.get(base, "")
    res = {"at": datetime.now().strftime("%Y-%m-%d %H:%M"), "manual": manual, "items": items,
           "counts": {k: sum(1 for x in items if x["level"] == k) for k in ("ok", "warn", "fail")}}
    sysconfig._write(LAST_KEY, res)
    return res


async def last() -> dict:
    res = sysconfig._read(LAST_KEY)
    return res if res.get("items") else await run(False)
