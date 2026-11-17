"""
System settings managed in the admin UI (server edition).

Stored in the settings table under private keys (never returned by /api/settings and never
exported): AD / LDAP, sign-in security, backups. Environment variables from older
installations still work as defaults; a value saved in the UI wins.

Secrets (the AD service-account password) are encrypted with AES-256-GCM. The key is
generated on first use in <data dir>/.secret.key (mode 0600, owned by the service user) —
nobody has to create or copy it by hand.
"""
import base64
import json
import os
import secrets
import sqlite3
import threading
from dataclasses import asdict, dataclass, field, fields
from typing import Optional

from . import config as C
from .database import DB_PATH, DB_DIR

KEY_FILE = DB_DIR / ".secret.key"
_lock = threading.Lock()
_cache: dict = {}


# ------------------------------------------------------------------ secrets
def _key() -> bytes:
    with _lock:
        if not KEY_FILE.exists():
            DB_DIR.mkdir(parents=True, exist_ok=True)
            fd = os.open(KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as f:
                f.write(secrets.token_bytes(32))
        return KEY_FILE.read_bytes()[:32]


def encrypt(plain: str, purpose: str) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce = secrets.token_bytes(12)
    blob = AESGCM(_key()).encrypt(nonce, plain.encode(), purpose.encode())
    return "v1:" + base64.b64encode(nonce + blob).decode()


def decrypt(token: Optional[str], purpose: str) -> str:
    if not token:
        return ""
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        raw = base64.b64decode(token.split(":", 1)[1])
        return AESGCM(_key()).decrypt(raw[:12], raw[12:], purpose.encode()).decode()
    except Exception:
        return ""                      # wrong key (e.g. database copied without the key) → treat as unset


# ------------------------------------------------------------------ storage
def _read(key: str) -> dict:
    if key in _cache:
        return _cache[key]
    value = {}
    try:
        con = sqlite3.connect(DB_PATH)
        try:
            row = con.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        finally:
            con.close()
        if row and row[0]:
            value = json.loads(row[0])
    except (sqlite3.Error, ValueError):
        value = {}
    _cache[key] = value if isinstance(value, dict) else {}
    return _cache[key]


def _write(key: str, value: dict):
    con = sqlite3.connect(DB_PATH)
    try:
        con.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, json.dumps(value, ensure_ascii=False)))
        con.commit()
    finally:
        con.close()
    _cache[key] = value


def invalidate():
    _cache.clear()


def _merge(cls, stored: dict, env_defaults: dict):
    out = {}
    for f in fields(cls):
        if f.name in stored:
            out[f.name] = stored[f.name]
        elif f.name in env_defaults and env_defaults[f.name] not in (None, ""):
            out[f.name] = env_defaults[f.name]
    obj = cls(**{k: v for k, v in out.items() if k in {x.name for x in fields(cls)}})
    return obj


# ---------------------------------------------------------------- AD / LDAP
@dataclass
class Ldap:
    enabled: bool = False
    url: str = ""                       # ldaps://dc1.corp.local  (or ldap://…:389)
    base_dn: str = ""
    bind_dn: str = ""                   # read-only service account (recommended)
    bind_password_enc: str = ""         # AES-GCM, never sent to the browser
    domain: str = ""                    # UPN suffix when there is no service account
    user_filter: str = ""
    login_attr: str = "sAMAccountName"
    name_attr: str = "displayName"
    dept_attr: str = "department"
    mail_attr: str = "mail"
    manager_attr: str = "manager"       # AD: DN of the person's 上級
    sync_manager: bool = True           # set 上級 from AD at sign-in (unless an admin set it by hand)
    starttls: bool = False
    tls_verify: bool = True
    ca_pem: str = ""                    # internal CA chain, pasted in the UI
    timeout: int = 6

    @property
    def bind_password(self) -> str:
        return decrypt(self.bind_password_enc, "ldap-bind")

    def public(self) -> dict:
        d = asdict(self)
        d.pop("bind_password_enc")
        d["bind_password_set"] = bool(self.bind_password_enc)
        return d


def ldap() -> Ldap:
    env = {
        "url": C.LDAP_URL, "base_dn": C.LDAP_BASE_DN, "bind_dn": C.LDAP_BIND_DN, "domain": C.LDAP_DOMAIN,
        "user_filter": C.LDAP_USER_FILTER, "login_attr": C.LDAP_LOGIN_ATTR, "name_attr": C.LDAP_NAME_ATTR,
        "dept_attr": C.LDAP_DEPT_ATTR, "mail_attr": C.LDAP_MAIL_ATTR, "starttls": C.LDAP_STARTTLS,
        "tls_verify": C.LDAP_TLS_VERIFY, "timeout": int(C.LDAP_TIMEOUT),
    }
    stored = _read("_sys_ldap")
    cfg = _merge(Ldap, stored, env)
    if "enabled" not in stored:                     # older installs configured through the env file
        cfg.enabled = bool(C.LDAP_URL)
    if not cfg.bind_password_enc and C.LDAP_BIND_PASSWORD and "bind_password_enc" not in stored:
        cfg.bind_password_enc = encrypt(C.LDAP_BIND_PASSWORD, "ldap-bind")
    if not cfg.ca_pem and C.LDAP_CA_FILE and "ca_pem" not in stored:
        try:
            cfg.ca_pem = open(C.LDAP_CA_FILE, encoding="utf-8").read()
        except OSError:
            pass
    return cfg


def save_ldap(values: dict, password: Optional[str]):
    cur = ldap()
    data = asdict(cur)
    for k, v in values.items():
        if k in data and k != "bind_password_enc":
            data[k] = v
    if password is not None:                         # None = keep, "" = clear
        data["bind_password_enc"] = encrypt(password, "ldap-bind") if password else ""
    _write("_sys_ldap", data)


# ---------------------------------------------------------- sign-in security
@dataclass
class Security:
    session_hours: float = 12            # idle timeout
    session_max_days: float = 7          # hard limit
    lock_attempts: int = 8               # wrong passwords per account …
    lock_minutes: int = 15               # … within / locked for this long
    ip_attempts: int = 20                # per source address


def security() -> Security:
    return _merge(Security, _read("_sys_security"), {"session_hours": C.SESSION_HOURS, "session_max_days": C.SESSION_MAX_DAYS})


def save_security(values: dict):
    data = asdict(security())
    data.update({k: v for k, v in values.items() if k in data})
    _write("_sys_security", data)


# ------------------------------------------------------------------ backups
@dataclass
class Backup:
    enabled: bool = True
    time: str = "03:30"                  # daily, server local time
    keep_days: int = 14
    last_run: str = ""
    last_result: str = ""


def backup() -> Backup:
    return _merge(Backup, _read("_sys_backup"), {})


def save_backup(values: dict):
    data = asdict(backup())
    data.update({k: v for k, v in values.items() if k in data})
    _write("_sys_backup", data)


# ---------------------------------------------------------------- OpenProject
@dataclass
class OpenProject:
    """One-way sync of board cards (and their subtasks, comments, time, attachments) to OpenProject."""
    enabled: bool = False
    url: str = ""                       # https://openproject.corp.local
    api_key_enc: str = ""               # AES-GCM; an OpenProject API key (My account → Access tokens)
    tls_verify: bool = True
    ca_pem: str = ""
    timeout: int = 15
    default_project: str = ""           # project id pre-selected when a card is linked
    card_type: str = ""                 # type id for cards (summary work packages); "" = project default
    subtask_type: str = ""              # type id for subtasks
    status_map: dict = field(default_factory=dict)      # Tool Table status → OpenProject status id
    priority_map: dict = field(default_factory=dict)    # low / normal / high → priority id
    time_activity: str = ""             # time entry activity id ("" = OpenProject default)
    sync_comments: bool = True
    sync_time: bool = True
    sync_attachments: bool = True
    notify: bool = False                # let OpenProject send its own e-mail notifications

    @property
    def api_key(self) -> str:
        return decrypt(self.api_key_enc, "openproject")

    def public(self) -> dict:
        d = asdict(self)
        d.pop("api_key_enc")
        d["api_key_set"] = bool(self.api_key_enc)
        return d


def openproject() -> OpenProject:
    return _merge(OpenProject, _read("_sys_openproject"), {})


def save_openproject(values: dict, api_key: Optional[str]):
    data = asdict(openproject())
    for k, v in values.items():
        if k in data and k != "api_key_enc":
            data[k] = v
    if api_key is not None:                          # None = keep, "" = clear
        data["api_key_enc"] = encrypt(api_key, "openproject") if api_key else ""
    _write("_sys_openproject", data)
