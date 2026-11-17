"""
System settings API (admins only) — everything an operator needs, without a shell.

  GET  /api/system/ldap              AD settings (the service password is never returned)
  PUT  /api/system/ldap              save (bind_password: omitted = keep, "" = clear)
  POST /api/system/ldap/test         try the settings in the form (connection / sign-in / search)
  GET  /api/system/security          session lifetime, lockout
  PUT  /api/system/security
  GET  /api/system/info              version, edition, paths, ports (read only)
  GET  /api/system/backup            schedule + list of backups
  PUT  /api/system/backup            schedule (enabled, time, keep_days)
  POST /api/system/backups           back up now
  GET  /api/system/backups/{name}    download
  DELETE /api/system/backups/{name}
  POST /api/system/backups/{name}/restore
  POST /api/system/backups/upload    upload a backup file (then restore it)
  GET  /api/system/tls               current HTTPS certificate
  POST /api/system/tls               new certificate + key (PEM) or {"selfsigned": true}
  GET  /api/system/network           HTTPS / HTTP port, server name
  PUT  /api/system/network
  GET  /api/system/apply/{id}        result of a certificate / network change
  GET  /api/system/openproject       OpenProject sync settings + status (the API key is never returned)
  PUT  /api/system/openproject       save (api_key: omitted = keep, "" = clear)
  POST /api/system/openproject/test  try the form's URL / key: user, projects, types, statuses, priorities
  POST /api/system/openproject/requeue   push every linked card again

Certificate and port changes need root: the app drops a request in <data>/requests and
the tool-table-apply.path unit applies it (scripts/tool-table.sh apply-request).
"""
import asyncio
import re
from dataclasses import replace
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import config as C
from .. import backup as bk
from .. import ldapauth, sysconfig
from .. import openproject as op
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
    sysconfig.save_backup(body.model_dump())
    return await get_backup()


@router.post("/backups")
async def backup_now():
    loop = asyncio.get_running_loop()
    try:
        b = await loop.run_in_executor(None, bk.make_backup, "manual")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"備份失敗：{e}")
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
    return FileResponse(_existing(name), media_type="application/gzip", filename=name)


@router.delete("/backups/{name}")
async def delete_backup(name: str):
    _existing(name).unlink()
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
                    raise HTTPException(status_code=413, detail="檔案太大（上限 500 MB）")
                out.write(chunk)
        import tarfile
        with tarfile.open(target, "r:gz") as tar:
            bk._check_members(tar)
    except HTTPException:
        target.unlink(missing_ok=True)
        raise
    except Exception as e:
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"不是有效的 Tool Table 備份檔：{e}")
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


# -------------------------------------------------------------- OpenProject
class OpenProjectIn(BaseModel):
    enabled: bool = False
    url: str = ""
    api_key: Optional[str] = None                 # None = keep the stored one
    tls_verify: bool = True
    ca_pem: str = ""
    timeout: int = 15
    default_project: str = ""
    card_type: str = ""
    subtask_type: str = ""
    status_map: dict = {}
    priority_map: dict = {}
    time_activity: str = ""
    sync_comments: bool = True
    sync_time: bool = True
    sync_attachments: bool = True
    notify: bool = False


OP_URL_RE = re.compile(r"^https?://[A-Za-z0-9.\-\[\]:]+(:\d{1,5})?(/[^\s?#]*)?$")
ID_RE = re.compile(r"^[0-9]{0,12}$")


def _op_values(body: OpenProjectIn) -> dict:
    url = body.url.strip().rstrip("/")
    if url.endswith("/api/v3"):
        url = url[: -len("/api/v3")]
    if body.enabled and not url:
        raise HTTPException(status_code=400, detail="請填 OpenProject 網址")
    if url and not OP_URL_RE.match(url):
        raise HTTPException(status_code=400, detail="網址格式不正確（例如 https://openproject.corp.local）")
    if body.ca_pem.strip() and "BEGIN CERTIFICATE" not in body.ca_pem:
        raise HTTPException(status_code=400, detail="CA 憑證要是 PEM 格式")
    ids = [body.default_project, body.card_type, body.subtask_type, body.time_activity,
           *map(str, body.status_map.values()), *map(str, body.priority_map.values())]
    if any(not ID_RE.match(str(i or "")) for i in ids):
        raise HTTPException(status_code=400, detail="對應設定的 id 不正確")
    status_map = {k: str(v or "") for k, v in body.status_map.items() if k in op.TT_STATUSES}
    priority_map = {k: str(v or "") for k, v in body.priority_map.items() if k in ("low", "normal", "high")}
    return {"enabled": body.enabled, "url": url, "tls_verify": body.tls_verify, "ca_pem": body.ca_pem.strip(),
            "timeout": max(3, min(120, body.timeout)), "default_project": body.default_project, "card_type": body.card_type,
            "subtask_type": body.subtask_type, "status_map": status_map, "priority_map": priority_map,
            "time_activity": body.time_activity, "sync_comments": body.sync_comments, "sync_time": body.sync_time,
            "sync_attachments": body.sync_attachments, "notify": body.notify}


@router.get("/openproject")
async def get_openproject():
    c = sysconfig.openproject()
    return {**c.public(), "statuses_local": op.TT_STATUS_ZH,
            "overview": await asyncio.get_running_loop().run_in_executor(None, op.overview)}


@router.put("/openproject")
async def put_openproject(body: OpenProjectIn):
    values = _op_values(body)
    if body.enabled and not (body.api_key or sysconfig.openproject().api_key_enc):
        raise HTTPException(status_code=400, detail="請填 API 金鑰")
    sysconfig.save_openproject(values, body.api_key)
    return await get_openproject()


@router.post("/openproject/test")
async def test_openproject(body: OpenProjectIn):
    """Try the form's URL and key (without saving); returns what the mapping dropdowns need."""
    values = _op_values(OpenProjectIn(**{**body.model_dump(), "enabled": True}))
    cfg = replace(sysconfig.openproject(), **values)
    key = body.api_key if body.api_key else cfg.api_key
    if not key:
        return {"ok": False, "steps": [{"status": "fail", "text": "請填 API 金鑰（OpenProject → 我的帳戶 → 存取權杖 → API）"}]}
    steps = []
    try:
        m = await asyncio.get_running_loop().run_in_executor(None, op.meta, op.Client(cfg, key), cfg.default_project or None)
    except op.OPError as e:
        hint = "：API 金鑰不正確或已撤銷" if e.status == 401 else ""
        return {"ok": False, "steps": [{"status": "fail", "text": str(e) + hint}]}
    except ValueError as e:
        return {"ok": False, "steps": [{"status": "fail", "text": f"CA 憑證無法讀取：{e}"}]}
    me = m["me"] or {}
    steps.append(("ok", f"已連線，API 使用者：{me.get('name')}（{me.get('login') or '—'}）" + ("，管理員" if me.get("admin") else "")))
    steps.append(("ok", f"看得到 {len(m['projects'])} 個專案、{len(m['types'])} 種類型、{len(m['statuses'])} 種狀態"))
    if not me.get("admin"):
        steps.append(("info", "API 使用者不是管理員：負責人會用「專案可指派的人」比對姓名；記錄他人工時需要「代他人記錄工時」權限"))
    if not m["activities"]:
        steps.append(("info", "讀不到工時活動清單：工時會用 OpenProject 的預設活動"))
    return {"ok": True, "steps": [{"status": s, "text": t} for s, t in steps], "meta": m, "guess": op.guess_maps(m)}


@router.post("/openproject/requeue")
async def requeue_openproject():
    if not op.configured():
        raise HTTPException(status_code=400, detail="請先啟用並儲存 OpenProject 設定")
    n = await asyncio.get_running_loop().run_in_executor(None, op.requeue_all)
    return {"queued": n}
