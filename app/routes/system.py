"""
System settings API (admins only) — everything an operator needs, without a shell.

  GET  /api/system/ldap              AD settings (the service password is never returned)
  PUT  /api/system/ldap              save (bind_password: omitted = keep, "" = clear)
  POST /api/system/ldap/test         try the settings in the form (connection / sign-in / search)
  GET  /api/system/security          session lifetime, lockout
  PUT  /api/system/security
  GET  /api/system/info              version, edition, paths, ports (read only)
  GET  /api/system/backup            schedule + list of backups (kind, chain, database ↔ files check)
  PUT  /api/system/backup            schedule: full (days, time), incremental (every N hours), keep_days
  POST /api/system/backups           back up now ({kind: full | inc})
  GET  /api/system/backups/{name}    download (an incremental one: one complete archive built from its chain)
  DELETE /api/system/backups/{name}
  POST /api/system/backups/{name}/restore
  POST /api/system/backups/upload    upload a backup file (then restore it)
  GET  /api/system/tls               current HTTPS certificate
  POST /api/system/tls               new certificate + key (PEM) or {"selfsigned": true}
  GET  /api/system/network           HTTPS / HTTP port, server name
  PUT  /api/system/network
  GET  /api/system/apply/{id}        result of a certificate / network change

Certificate and port changes need root: the app drops a request in <data>/requests and
the tool-table-apply.path unit applies it (scripts/tool-table.sh apply-request).
"""
import asyncio
import re
from dataclasses import replace
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import config as C
from .. import backup as bk
from .. import ldapauth, sysconfig
from ..auth import require_admin

router = APIRouter(prefix="/api/system", tags=["system"], dependencies=[Depends(require_admin)])

URL_RE = re.compile(r"^ldaps?://[A-Za-z0-9.\-\[\]:]+(:\d{1,5})?/?$")
ATTR_RE = re.compile(r"^[A-Za-z][A-Za-z0-9\-]{0,63}$")


class LdapIn(BaseModel):
    enabled: bool = False
    url: str = ""
    base_dn: str = ""
    bind_dn: str = ""
    bind_password: Optional[str] = None          # None = keep the stored one
    domain: str = ""
    user_filter: str = ""
    login_attr: str = "sAMAccountName"
    name_attr: str = "displayName"
    dept_attr: str = "department"
    mail_attr: str = "mail"
    manager_attr: str = "manager"
    sync_manager: bool = True
    starttls: bool = False
    tls_verify: bool = True
    ca_pem: str = ""
    timeout: int = 6


class LdapTest(LdapIn):
    username: str = ""
    password: str = ""
    search: str = ""


def _validate(body: LdapIn) -> dict:
    v = body.model_dump(exclude={"bind_password", "username", "password", "search"})
    v = {k: (x.strip() if isinstance(x, str) and k != "ca_pem" else x) for k, x in v.items()}
    if v["url"] and not URL_RE.match(v["url"]):
        raise HTTPException(status_code=400, detail="伺服器網址格式：ldaps://dc1.corp.local 或 ldap://10.0.0.5:389")
    if not v.get("manager_attr"):
        v["manager_attr"] = "manager"
    for k in ("login_attr", "name_attr", "dept_attr", "mail_attr", "manager_attr"):
        if not ATTR_RE.match(v[k] or ""):
            raise HTTPException(status_code=400, detail=f"屬性名稱無效：{v[k]}")
    if v["user_filter"] and not (v["user_filter"].startswith("(") and v["user_filter"].endswith(")")
                                and v["user_filter"].count("(") == v["user_filter"].count(")")):
        raise HTTPException(status_code=400, detail="篩選條件需要是完整的 LDAP 篩選，例如 (memberOf=CN=…)")
    if v["ca_pem"].strip():
        try:
            from cryptography import x509
            x509.load_pem_x509_certificates(v["ca_pem"].encode())
        except Exception:
            raise HTTPException(status_code=400, detail="CA 憑證不是有效的 PEM（-----BEGIN CERTIFICATE----- …）")
    v["timeout"] = max(2, min(30, int(v["timeout"] or 6)))
    if v["enabled"] and not (v["url"] and v["base_dn"] and (v["bind_dn"] or v["domain"])):
        raise HTTPException(status_code=400, detail="啟用 AD 前請填寫伺服器、Base DN，以及服務帳號或網域其中之一")
    return v


def _ca_subjects(pem: str):
    if not (pem or "").strip():
        return []
    try:
        from cryptography import x509
        return [c.subject.rfc4514_string() for c in x509.load_pem_x509_certificates(pem.encode())]
    except Exception:
        return []


@router.get("/ldap")
async def get_ldap():
    c = sysconfig.ldap()
    return {**c.public(), "ca_subjects": _ca_subjects(c.ca_pem)}


@router.put("/ldap")
async def put_ldap(body: LdapIn):
    values = _validate(body)
    sysconfig.save_ldap(values, body.bind_password)
    return await get_ldap()


@router.post("/ldap/test")
async def test_ldap(body: LdapTest):
    """Try the form's settings without saving them."""
    values = _validate(LdapIn(**{**body.model_dump(), "enabled": True}) if body.url else body)
    cfg = replace(sysconfig.ldap(), **values)
    if body.bind_password is not None:
        cfg.bind_password_enc = sysconfig.encrypt(body.bind_password, "ldap-bind") if body.bind_password else ""
    cfg.enabled = True
    loop = asyncio.get_running_loop()
    steps = []

    def run():
        if cfg.bind_dn:
            ldapauth._connect(cfg.bind_dn, cfg.bind_password, cfg).unbind()
            steps.append(("ok", f"服務帳號登入成功（{cfg.bind_dn}）"))
            found = ldapauth.search_directory(body.search or "a", limit=8, cfg=cfg, raise_errors=True)
            steps.append(("ok", f"目錄搜尋「{body.search or 'a'}」：{len(found)} 筆" + (
                "（" + "、".join(f"{a['display_name']}／{a['department'] or '無部門'}" for a in found[:5]) + "）" if found else "")))
        elif not body.username:
            steps.append(("info", "沒有服務帳號：請輸入一組帳號密碼測試登入"))
        if body.username:
            info = ldapauth.authenticate(body.username, body.password, cfg)
            if info:
                steps.append(("ok", f"測試登入成功：{info['username']}　{info['display_name']}　部門：{info['department'] or '（AD 沒有填）'}"))
            else:
                steps.append(("fail", "測試登入失敗：帳號或密碼錯誤，或帳號不在篩選範圍內"))

    try:
        await loop.run_in_executor(None, run)
    except PermissionError as e:
        steps.append(("fail", f"服務帳號登入失敗：DN 或密碼不正確（{e}）"))
    except Exception as e:
        steps.append(("fail", str(e)))
    return {"ok": all(s != "fail" for s, _ in steps), "steps": [{"status": s, "text": t} for s, t in steps]}


# ------------------------------------------------------------- Microsoft Entra ID
class EntraIn(BaseModel):
    enabled: bool = False
    tenant_id: str = ""
    client_id: str = ""
    client_secret: Optional[str] = None          # None = keep, "" = clear
    redirect_uri: str = ""
    allowed_groups: str = ""
    sync_profile: bool = True
    directory: bool = False
    button_label: str = ""


GUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _entra_values(body: EntraIn) -> dict:
    v = body.model_dump(exclude={"client_secret"})
    v = {k: (x.strip() if isinstance(x, str) else x) for k, x in v.items()}
    if v["tenant_id"] and not (GUID_RE.match(v["tenant_id"]) or re.match(r"^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$", v["tenant_id"])):
        raise HTTPException(status_code=400, detail="租用戶 ID 應為 GUID 或網域（例如 contoso.onmicrosoft.com）")
    if v["client_id"] and not GUID_RE.match(v["client_id"]):
        raise HTTPException(status_code=400, detail="應用程式（Client）ID 應為 GUID")
    if v["redirect_uri"] and not v["redirect_uri"].startswith("https://"):
        raise HTTPException(status_code=400, detail="重新導向 URI 必須是 https://")
    bad = [g for g in v["allowed_groups"].replace("\n", ",").split(",") if g.strip() and not GUID_RE.match(g.strip())]
    if bad:
        raise HTTPException(status_code=400, detail=f"群組要填物件 ID（GUID）：{bad[0].strip()}")
    if v["enabled"] and not (v["tenant_id"] and v["client_id"]):
        raise HTTPException(status_code=400, detail="啟用前請填寫租用戶 ID 與應用程式 ID")
    v["button_label"] = v["button_label"][:40]
    return v


@router.get("/entra")
async def get_entra(request: Request):
    from ..routes.auth import entra_redirect_uri
    c = sysconfig.entra()
    return {**c.public(), "default_redirect_uri": entra_redirect_uri(request, default_only=True)}


@router.put("/entra")
async def put_entra(body: EntraIn, request: Request):
    values = _entra_values(body)
    if values["enabled"] and not (body.client_secret or sysconfig.entra().client_secret_enc):
        raise HTTPException(status_code=400, detail="啟用前請填寫用戶端密碼（Client secret）")
    sysconfig.save_entra(values, body.client_secret)
    from .. import entra
    entra._app_token.update(value="", until=0)
    return await get_entra(request)


@router.post("/entra/test")
async def test_entra(body: EntraIn):
    """Try the form's settings without saving them: tenant, client ID + secret, directory permission."""
    from .. import entra
    values = _entra_values(EntraIn(**{**body.model_dump(), "enabled": False}))
    try:
        steps = await asyncio.get_running_loop().run_in_executor(None, entra.test, values, body.client_secret)
        return {"ok": True, "steps": [{"status": "fail" if s.startswith("不能") else "ok", "text": s} for s in steps]}
    except entra.EntraError as e:
        return {"ok": False, "steps": [{"status": "fail", "text": str(e)}]}


# ------------------------------------------------------------- Microsoft Teams
class TeamsChannelIn(BaseModel):
    id: str = ""
    name: str = ""
    url: Optional[str] = None                    # None = keep the stored address
    enabled: bool = True
    events: list = []
    scope: str = "projects"
    projects: list = []


class TeamsIn(BaseModel):
    channels: List[TeamsChannelIn] = []
    lang: str = "site"
    site_url: str = ""
    quiet_seconds: int = 60
    health_times: str = "08:30,17:30"
    health_only_abnormal: bool = False
    repeat_hours: float = 6
    disk_warn: int = 80
    disk_fail: int = 90
    mem_warn: int = 15
    mem_fail: int = 5
    load_warn: float = 1.5
    load_fail: float = 3.0
    temp_warn: int = 80
    temp_fail: int = 90
    cert_warn: int = 30
    cert_fail: int = 7
    backup_hours: int = 30


TEAMS_URL_RE = re.compile(r"^(https://[A-Za-z0-9.-]+|http://(127\.0\.0\.1|localhost))(:\d+)?/\S+$")   # http: local tests only


@router.get("/teams")
async def get_teams():
    from .. import teams
    return teams.public()


@router.put("/teams")
async def put_teams(body: TeamsIn):
    from .. import teams
    for ch in body.channels:
        if ch.url and not TEAMS_URL_RE.match(ch.url.strip()):
            raise HTTPException(status_code=400, detail=f"「{ch.name or '頻道'}」的網址要是 https:// 開頭的 Workflow 網址")
    if body.lang not in ("site", "zh-TW", "en"):
        raise HTTPException(status_code=400, detail="語言只能是 zh-TW 或 en")
    if body.site_url and not body.site_url.startswith(("https://", "http://")):
        raise HTTPException(status_code=400, detail="網站網址要以 https:// 開頭")
    for t in body.health_times.replace("，", ",").split(","):
        if t.strip() and not re.match(r"^\d{1,2}:\d{2}$", t.strip()):
            raise HTTPException(status_code=400, detail="報告時間格式為 HH:MM，多個用逗號分開，例如 08:30,17:30")
    if not (0 < body.disk_warn < body.disk_fail <= 100 and 0 <= body.mem_fail < body.mem_warn < 100
            and 0 < body.load_warn < body.load_fail and 0 < body.temp_warn < body.temp_fail and 0 <= body.cert_fail < body.cert_warn):
        raise HTTPException(status_code=400, detail="告警門檻不合理：注意的門檻要比告警寬鬆")
    teams.save_channels([{**ch.model_dump(), "url": ch.url.strip() if ch.url else ch.url} for ch in body.channels])
    v = body.model_dump(exclude={"channels"})
    v["quiet_seconds"] = max(10, min(3600, v["quiet_seconds"]))
    v["repeat_hours"] = max(0, min(168, v["repeat_hours"]))
    sysconfig.save_teams(v)
    return teams.public()


class TeamsTestIn(BaseModel):
    id: str = ""
    url: Optional[str] = None


@router.post("/teams/test")
async def test_teams(body: TeamsTestIn):
    """Send a test message now (to a stored channel, or an address typed in the form)."""
    from .. import teams
    url = (body.url or "").strip()
    if not url:
        ch = next((c for c in sysconfig.teams().channels if c["id"] == body.id), None)
        url = teams.channel_url(ch) if ch else ""
    if not url:
        raise HTTPException(status_code=400, detail="請先填寫 Workflow 網址")
    L = teams.lang()
    payload = teams.card("[Test] IPMS → Teams" if L == "en" else "【測試】IPMS → Teams",
                         ["If you can see this, the channel works." if L == "en" else "看到這則訊息，表示這個頻道設定正確。",
                          datetime.now().strftime("%Y-%m-%d %H:%M:%S")], f"{teams.site_url()}/", "ok", "Open" if L == "en" else "開啟")
    try:
        await asyncio.get_running_loop().run_in_executor(None, teams.post, url, payload)
    except Exception as e:
        return {"ok": False, "steps": [{"status": "fail", "text": str(e)}]}
    return {"ok": True, "steps": [{"status": "ok", "text": "已送出測試訊息，請到 Teams 頻道確認"}]}


@router.get("/monitor")
async def monitor_now():
    """The system checks right now (for the settings page)."""
    from .. import monitor, i18n
    items = await asyncio.get_running_loop().run_in_executor(None, lambda: monitor.checks(sysconfig.teams(), True, True, i18n.lang()))
    return {"items": items}


@router.post("/teams/report")
async def teams_report_now():
    """Send the system status report to the channels that want it, now."""
    from .. import monitor, teams, i18n
    c = sysconfig.teams()
    chans = teams.active_channels("health", c) or teams.active_channels("system", c)
    if not chans:
        raise HTTPException(status_code=400, detail="沒有頻道訂閱「系統狀態報告」或「系統告警」")
    L = teams.lang(c)
    items = await asyncio.get_running_loop().run_in_executor(None, lambda: monitor.checks(c, True, True, L))
    from dataclasses import replace as _replace
    payload = monitor.report(items, _replace(c, health_only_abnormal=False), L)   # always a full report when asked
    from ..database import get_db
    db = await get_db()
    try:
        for ch in chans:
            await teams.enqueue(db, ch["id"], "health", payload)
        await db.commit()
    finally:
        await db.close()
    return {"queued": len(chans)}


class SecurityIn(BaseModel):
    session_hours: float
    session_max_days: float
    lock_attempts: int
    lock_minutes: int
    ip_attempts: int


@router.get("/security")
async def get_security():
    from dataclasses import asdict
    return asdict(sysconfig.security())


@router.put("/security")
async def put_security(body: SecurityIn):
    if not (0.25 <= body.session_hours <= 24 * 30):
        raise HTTPException(status_code=400, detail="閒置登出時間需在 0.25–720 小時之間")
    if not (0.1 <= body.session_max_days <= 90):
        raise HTTPException(status_code=400, detail="最長登入天數需在 0.1–90 天之間")
    if not (3 <= body.lock_attempts <= 50 and 1 <= body.lock_minutes <= 1440 and 5 <= body.ip_attempts <= 500):
        raise HTTPException(status_code=400, detail="鎖定設定超出範圍（次數 3–50、分鐘 1–1440、每個來源 5–500）")
    sysconfig.save_security(body.model_dump())
    return await get_security()


@router.get("/info")
async def info():
    from ..main import VERSION
    from ..database import DB_PATH
    return {
        "version": VERSION,
        "auth": C.AUTH,
        "data_dir": str(DB_PATH.parent),
        "icon_dir": str(C.ICON_DIR),
    }


# ------------------------------------------------------------------ backups
class BackupIn(BaseModel):
    enabled: bool
    time: str
    keep_days: int
    full_days: Optional[List[int]] = None
    inc_enabled: Optional[bool] = None
    inc_every_hours: Optional[int] = None


class BackupNow(BaseModel):
    kind: str = "full"


@router.get("/backup")
async def get_backup():
    from dataclasses import asdict
    return {**asdict(sysconfig.backup()), "backups": bk.list_backups(), "dir": str(bk.BACKUP_DIR)}


@router.put("/backup")
async def put_backup(body: BackupIn):
    if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", body.time):
        raise HTTPException(status_code=400, detail="備份時間格式為 HH:MM")
    if not 1 <= body.keep_days <= 3650:
        raise HTTPException(status_code=400, detail="保留天數需在 1–3650 之間")
    values = body.model_dump(exclude_none=True)
    if "full_days" in values:
        values["full_days"] = sorted({d for d in values["full_days"] if isinstance(d, int) and 0 <= d <= 6})
        if body.enabled and not values["full_days"]:
            raise HTTPException(status_code=400, detail="完整備份至少要選一天")
    if "inc_every_hours" in values and not 1 <= values["inc_every_hours"] <= 168:
        raise HTTPException(status_code=400, detail="增量備份間隔需在 1–168 小時之間")
    sysconfig.save_backup(values)
    return await get_backup()


@router.post("/backups")
async def backup_now(request: Request, body: Optional[BackupNow] = None):
    loop = asyncio.get_running_loop()
    inc = bool(body and body.kind == "inc")
    try:
        b = await loop.run_in_executor(None, lambda: bk.make_backup("manual", incremental=inc))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"備份失敗：{e}")
    request.state.audit_target = b.get("name", "")
    request.state.audit_detail = ("增量備份" if inc else "完整備份") + (f"；{b['check']}" if b.get("check") else "")
    return b


def _existing(name: str):
    try:
        p = bk.safe_path(name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not p.exists():
        raise HTTPException(status_code=404, detail="找不到這份備份")
    return p


@router.get("/backups/{name}")
async def download_backup(name: str):
    p = _existing(name)
    if bk.kind_of(name) != "inc":
        return FileResponse(p, media_type="application/gzip", filename=name)
    from starlette.background import BackgroundTask
    loop = asyncio.get_running_loop()
    try:                                            # one complete archive: this state, gathered from its chain
        out = await loop.run_in_executor(None, bk.consolidate, p)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return FileResponse(out, media_type="application/gzip", filename=name.replace("-inc", "-full"),
                        background=BackgroundTask(lambda: out.unlink(missing_ok=True)))


@router.delete("/backups/{name}")
async def delete_backup(name: str, force: bool = False):
    p = _existing(name)
    deps = bk.dependents(name)
    if deps and not force:
        raise HTTPException(status_code=409, detail=f"有 {len(deps)} 份增量備份需要這份備份的檔案，刪掉後它們就無法還原")
    p.unlink()
    return {"success": True}


@router.post("/backups/{name}/restore")
async def restore_backup(name: str):
    p = _existing(name)
    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(None, bk.restore, p)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/backups/upload")
async def upload_backup(file: UploadFile = File(...)):
    target = bk.new_name("upload")
    target.touch(mode=0o600)                       # reserve the name
    size = 0
    try:
        with open(target, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > bk.MAX_UPLOAD:
                    raise HTTPException(status_code=413, detail="檔案太大（上限 2 GB）")
                out.write(chunk)
        import tarfile
        with tarfile.open(target, "r:gz") as tar:
            bk._check_members(tar)
        m = bk.read_manifest(target)
        if m and any(v.get("in") != m.get("name") for v in m.get("files", {}).values()):
            raise ValueError("這是增量備份，只有它本身不完整；請上傳完整備份（增量備份在後台按「下載」會得到完整的檔案）")
    except HTTPException:
        target.unlink(missing_ok=True)
        raise
    except Exception as e:
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"不是有效的 IPMS 備份檔：{e}")
    return bk.describe(target)


# ------------------------------------------- HTTPS certificate / ports (root helper)
import json as _json
import os as _os
import uuid as _uuid
from pathlib import Path as _Path

from ..database import DB_DIR as _DB_DIR

REQ_DIR = _DB_DIR / "requests"
TLS_CERT = _Path(_os.environ.get("TOOL_TABLE_TLS_CERT") or "/etc/tool-table/tls/server.crt")


def _helper() -> bool:
    return (REQ_DIR / ".helper").exists()


def _require_helper():
    if not _helper():
        raise HTTPException(status_code=409, detail="這個環境沒有 nginx 伺服器設定（單機版或開發模式），不適用")
    if (REQ_DIR / "request.json").exists():
        raise HTTPException(status_code=409, detail="上一個變更還在套用中，請稍候")


def _submit(payload: dict, files: Optional[dict] = None) -> dict:
    _require_helper()
    rid = _uuid.uuid4().hex[:16]
    for name, text in (files or {}).items():
        target = REQ_DIR / name
        fd = _os.open(target, _os.O_WRONLY | _os.O_CREAT | _os.O_TRUNC, 0o600)
        with _os.fdopen(fd, "w") as f:
            f.write(text)
    tmp = REQ_DIR / "request.json.tmp"
    tmp.write_text(_json.dumps({**payload, "id": rid}))
    _os.replace(tmp, REQ_DIR / "request.json")       # the path unit fires on this
    return {"id": rid, "pending": True}


def _cert_info(pem: bytes) -> dict:
    from cryptography import x509
    from cryptography.x509.oid import ExtensionOID
    c = x509.load_pem_x509_certificate(pem)
    try:
        san = c.extensions.get_extension_for_oid(ExtensionOID.SUBJECT_ALTERNATIVE_NAME).value
        names = [str(v) for v in san.get_values_for_type(x509.DNSName)] + [str(v) for v in san.get_values_for_type(x509.IPAddress)]
    except Exception:
        names = []
    not_after = c.not_valid_after_utc
    from datetime import datetime, timezone
    return {
        "subject": c.subject.rfc4514_string(), "issuer": c.issuer.rfc4514_string(),
        "self_signed": c.issuer == c.subject, "names": names,
        "not_before": c.not_valid_before_utc.isoformat(), "not_after": not_after.isoformat(),
        "days_left": (not_after - datetime.now(timezone.utc)).days,
    }


@router.get("/tls")
async def get_tls():
    out = {"helper": _helper(), "pending": (REQ_DIR / "request.json").exists()}
    try:
        out["cert"] = _cert_info(TLS_CERT.read_bytes())
    except Exception:
        out["cert"] = None
    return out


class TlsIn(BaseModel):
    cert_pem: str = ""
    key_pem: str = ""
    selfsigned: bool = False


@router.post("/tls")
async def post_tls(body: TlsIn):
    if body.selfsigned:
        return _submit({"type": "tls_selfsigned"})
    if len(body.cert_pem) > 256 * 1024 or len(body.key_pem) > 64 * 1024:
        raise HTTPException(status_code=400, detail="檔案太大")
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    try:
        certs = x509.load_pem_x509_certificates(body.cert_pem.encode())
    except Exception:
        raise HTTPException(status_code=400, detail="憑證不是有效的 PEM（請貼上含中繼憑證的 fullchain）")
    try:
        key = serialization.load_pem_private_key(body.key_pem.encode(), password=None)
    except TypeError:
        raise HTTPException(status_code=400, detail="私鑰有密碼保護，請先解除密碼再上傳")
    except Exception:
        raise HTTPException(status_code=400, detail="私鑰不是有效的 PEM")
    pub = lambda k: k.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    if pub(certs[0].public_key()) != pub(key.public_key()):
        raise HTTPException(status_code=400, detail="私鑰與憑證不成對（第一張憑證必須是伺服器憑證）")
    info = _cert_info(certs[0].public_bytes(serialization.Encoding.PEM))
    if info["days_left"] < 0:
        raise HTTPException(status_code=400, detail="這張憑證已過期")
    return {**_submit({"type": "tls_upload"}, {"cert.pem": body.cert_pem.strip() + "\n", "key.pem": body.key_pem.strip() + "\n"}),
            "cert": info}


class NetworkIn(BaseModel):
    https_port: int
    http_port: int
    fqdn: str = ""


def _network_state() -> dict:
    try:
        return _json.loads((REQ_DIR / "state.json").read_text())
    except Exception:
        return {"https_port": int(_os.environ.get("TOOL_TABLE_HTTPS_PORT") or 0) or None,
                "http_port": int(_os.environ.get("TOOL_TABLE_HTTP_PORT") or 0),
                "fqdn": _os.environ.get("TOOL_TABLE_FQDN") or ""}


@router.get("/network")
async def get_network():
    return {**_network_state(), "helper": _helper(), "app_port": int(_os.environ.get("TOOL_TABLE_APP_PORT") or 8080)}


@router.put("/network")
async def put_network(body: NetworkIn):
    fqdn = body.fqdn.strip().lower()
    if not (1 <= body.https_port <= 65535 and 0 <= body.http_port <= 65535 and body.https_port != body.http_port):
        raise HTTPException(status_code=400, detail="埠號無效（HTTPS 1–65535，HTTP 0 表示不開）")
    if fqdn and not re.fullmatch(r"[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*", fqdn):
        raise HTTPException(status_code=400, detail="名稱格式不正確，例如 portal.corp.local（留空 = 接受任何名稱）")
    return _submit({"type": "network", "https_port": body.https_port, "http_port": body.http_port, "fqdn": fqdn})


@router.get("/apply/{rid}")
async def apply_status(rid: str):
    if (REQ_DIR / "request.json").exists():
        return {"id": rid, "pending": True}
    try:
        res = _json.loads((REQ_DIR / "result.json").read_text())
    except Exception:
        return {"id": rid, "pending": True}
    if res.get("id") != rid:
        return {"id": rid, "pending": True}
    return {**res, "pending": False}


# ---------------------------------------------------------------- demo data (app/demo.py)
@router.get("/demo")
async def demo_status():
    from .. import demo
    from ..database import get_db
    db = await get_db()
    try:
        return await demo.status(db)
    finally:
        await db.close()


@router.post("/demo")
async def demo_load(request: Request):
    """Demo staff in 7 departments, a one-year data-centre rebuild project and everyday cards (this database only)."""
    from .. import demo
    from ..auth import current_user
    from ..database import CAPTURE, get_db
    was = CAPTURE["on"]
    CAPTURE["on"] = False                     # no Teams change digest for a few hundred demo rows
    try:
        db = await get_db()
    finally:
        CAPTURE["on"] = was
    try:
        try:
            out = await demo.load(db, current_user(request).get("id"))
        except ValueError as e:
            await db.rollback()
            raise HTTPException(status_code=400, detail=str(e))
        await db.commit()
        return out
    finally:
        await db.close()


@router.delete("/demo")
async def demo_remove():
    from .. import demo
    from ..database import CAPTURE, get_db
    was = CAPTURE["on"]
    CAPTURE["on"] = False
    try:
        db = await get_db()
    finally:
        CAPTURE["on"] = was
    try:
        out = await demo.remove(db)
        await db.commit()
        return out
    finally:
        await db.close()


# ---------------------------------------------------------------- 系統狀態 (app/health.py)
@router.get("/status")
async def status_page():
    """The last health check, what the installation decided (read only) and the recent maintenance work."""
    from .. import health, upgrade
    from ..database import DB_PATH
    res = await health.last()
    env = {}
    try:
        state = _json.loads((REQ_DIR / "state.json").read_text())
    except Exception:
        state = {}
    loop = asyncio.get_running_loop()
    cur = await loop.run_in_executor(None, upgrade.current)
    install = [
        ["版本", f"v{cur['version']}" + (f"（{cur['commit']}）" if cur["commit"] else "")],
        ["版本型態", "伺服器版（需要登入）" if C.AUTH else "單機版／開發模式（不需登入）"],
        ["程式位置", str(upgrade.APP_DIR)],
        ["資料位置", str(DB_PATH.parent)],
        ["圖示位置", str(C.ICON_DIR)],
        ["備份位置", str(bk.BACKUP_DIR)],
    ]
    if state:
        install.append(["HTTPS 埠", str(state.get("https_port") or "—")])
        install.append(["HTTP 埠", str(state.get("http_port") or "不開（只用 HTTPS）")])
        install.append(["伺服器名稱", state.get("fqdn") or "（任何名稱）"])
    install.append(["服務內部埠", f"127.0.0.1:{_os.environ.get('TOOL_TABLE_APP_PORT') or '—'}"])
    jobs = []
    for b in bk.list_backups()[:6]:
        jobs.append({"at": (b.get("created") or "")[:16].replace("T", " "), "what": "增量備份" if b.get("type") == "inc" else "完整備份",
                     "ok": b.get("check_ok", True) is not False, "detail": f"{b.get('name')}　{b.get('check') or ''}".strip()})
    try:
        r = _json.loads((REQ_DIR / "result.json").read_text())
        jobs.append({"at": (r.get("at") or "")[:16].replace("T", " "), "what": "憑證／連線埠套用", "ok": r.get("ok"), "detail": r.get("message")})
    except Exception:
        pass
    up = upgrade.status()
    if up.get("state"):
        jobs.append({"at": (up.get("at") or "")[:16], "what": "升級", "ok": up.get("state") != "error",
                     "detail": f"{up.get('msg')}：v{up.get('from')} → v{up.get('to')}"})
    jobs.sort(key=lambda j: j["at"], reverse=True)
    return {**res, "install": install, "jobs": jobs[:10], "env": env}


@router.post("/status/check")
async def status_check():
    from .. import health
    return await health.run(manual=True)


# ---------------------------------------------------------------- 稽核紀錄 (app/audit.py)
class RetentionIn(BaseModel):
    days: int


@router.get("/audit")
async def audit_list(date_from: str = "", date_to: str = "", action: str = "", actor: str = "", target: str = "", q: str = "",
                     failed: bool = False, page: int = 1):
    from .. import audit, i18n
    from ..database import get_db
    f = audit.filters(date_from, date_to, action, actor, target, q, failed)
    sql, args = audit.where(f)
    per = 100
    db = await get_db()
    try:
        cur = await db.execute(f"SELECT COUNT(*) FROM audit_log WHERE {sql}", args)
        total = (await cur.fetchone())[0]
        pages = max(1, (total + per - 1) // per)
        page = max(1, min(page, pages))
        cur = await db.execute(f"SELECT * FROM audit_log WHERE {sql} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?", (*args, per, (page - 1) * per))
        rows = [dict(r) for r in await cur.fetchall()]
        cur = await db.execute(f"SELECT substr(at, 1, 10) AS d, COUNT(*) AS n FROM audit_log WHERE {sql} GROUP BY d ORDER BY d DESC", args)
        per_day = [[r["d"], r["n"]] for r in await cur.fetchall()]
        cur = await db.execute("SELECT actor_id, MAX(actor) AS actor FROM audit_log WHERE actor_id IS NOT NULL GROUP BY actor_id ORDER BY actor")
        actors = [{"id": r["actor_id"], "name": r["actor"]} for r in await cur.fetchall()]
        cur = await db.execute("SELECT MIN(at) FROM audit_log")
        earliest = (await cur.fetchone())[0]
    finally:
        await db.close()
    L = i18n.lang()
    for r in rows:
        r["label"] = audit.label(r["action"], L)
    return {"filters": f, "rows": rows, "total": total, "page": page, "pages": pages, "per_day": per_day, "actors": actors,
            "actions": [{"code": k, "label": audit.label(k, L)} for k in audit.LABELS], "keep": audit.keep_days(),
            "keep_min": audit.KEEP_MIN, "keep_max": audit.KEEP_MAX, "earliest": (earliest or "")[:10]}


@router.get("/audit.csv")
async def audit_csv(date_from: str = "", date_to: str = "", action: str = "", actor: str = "", target: str = "", q: str = "", failed: bool = False):
    import csv
    import io
    from fastapi.responses import Response
    from .. import audit
    from ..database import get_db
    f = audit.filters(date_from, date_to, action, actor, target, q, failed)
    sql, args = audit.where(f)
    db = await get_db()
    try:
        cur = await db.execute(f"SELECT * FROM audit_log WHERE {sql} ORDER BY at, id", args)
        rows = await cur.fetchall()
    finally:
        await db.close()
    buf = io.StringIO()
    buf.write("﻿")
    w = csv.writer(buf)
    w.writerow(["時間", "動作", "動作代碼", "操作者", "對象", "內容", "來源 IP", "結果"])
    for r in rows:
        w.writerow([r["at"], audit.label(r["action"]), r["action"], r["actor"] or "", r["target"] or "", r["detail"] or "", r["ip"] or "",
                    "成功" if r["ok"] else "失敗"])
    name = f"audit_{f['date_from'].replace('-', '')}-{f['date_to'].replace('-', '')}.csv"
    return Response(buf.getvalue(), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.put("/audit/retention")
async def audit_retention(body: RetentionIn, request: Request):
    from .. import audit
    if not audit.KEEP_MIN <= body.days <= audit.KEEP_MAX:
        raise HTTPException(status_code=400, detail=f"保存天數必須在 {audit.KEEP_MIN}–{audit.KEEP_MAX} 天之間")
    old = audit.keep_days()
    audit.set_keep_days(body.days)
    request.state.audit_target = f"{body.days} 天"
    request.state.audit_detail = f"保存天數 {old} → {body.days} 天"
    return {"keep": body.days}


# ---------------------------------------------------------------- 系統資訊 (app/sysinfo.py)
@router.get("/sysinfo")
async def sysinfo_page():
    from .. import sysinfo
    return await asyncio.get_running_loop().run_in_executor(None, sysinfo.collect)


@router.get("/sysinfo.json")
async def sysinfo_download():
    from fastapi.responses import Response
    from .. import sysinfo
    loop = asyncio.get_running_loop()
    info = await loop.run_in_executor(None, sysinfo.collect)
    info["all_system_packages"] = [{"name": n, "version": v} for n, v in await loop.run_in_executor(None, sysinfo.all_system_packages)]
    name = f"ipms-sysinfo-{datetime.now():%Y%m%d-%H%M}.json"
    return Response(_json.dumps(info, ensure_ascii=False, indent=2, default=str), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


# ---------------------------------------------------------------- 版本紀錄與升級 (app/upgrade.py)
@router.get("/versions")
async def versions_page(refresh: bool = False):
    from .. import upgrade
    return await asyncio.get_running_loop().run_in_executor(None, upgrade.overview, refresh)


@router.get("/upgrade/status")
async def upgrade_status():
    from .. import upgrade
    from ..main import VERSION
    return {"running_version": VERSION, **upgrade.status()}


@router.post("/upgrade")
async def upgrade_now(request: Request):
    from .. import upgrade
    loop = asyncio.get_running_loop()
    if not await loop.run_in_executor(None, upgrade.available):
        raise HTTPException(status_code=400, detail="主機尚未安裝升級服務：請先在主機用指令升級一次，之後就能用這個按鈕")
    if upgrade.busy():
        raise HTTPException(status_code=409, detail="已經在升級中，請稍候")
    upgrade.request(request.state.user)
    cur = upgrade.current()
    request.state.audit_target = "系統"
    request.state.audit_detail = f"從 v{cur['version']}（{cur['commit'] or '—'}）升級到最新版"
    return {"pending": True}
