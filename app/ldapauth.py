"""
Active Directory / LDAP sign-in and account directory.

authenticate(username, password) → dict(username, display_name, email, department) or None
search_directory(text)          → accounts matching a name (needs the read-only service account)
lookup(username)                → one account by login name (service account)

Settings come from the admin UI (sysconfig.ldap()); every function also takes an explicit
config so "test connection" can try settings that are not saved yet.

Two ways to verify a password:
  * search + bind  (TOOL_TABLE_LDAP_BIND_DN set): the service account finds the user's DN,
    then a second connection binds as that DN with the typed password
  * UPN bind       (TOOL_TABLE_LDAP_DOMAIN set): bind as user@domain, then read our own entry
Empty passwords are refused before LDAP is touched (an empty simple bind is an anonymous
bind and would "succeed").
"""
import logging
import re
import ssl
from typing import List, Optional

from . import sysconfig

log = logging.getLogger("tool_table.ldap")
USERNAME_RE = re.compile(r"^[A-Za-z0-9._\-]{1,64}$")


def _cfg(cfg=None):
    return cfg or sysconfig.ldap()


def enabled(cfg=None) -> bool:
    c = _cfg(cfg)
    return bool(c.enabled and c.url and c.base_dn and (c.bind_dn or c.domain))


def directory_enabled(cfg=None) -> bool:
    c = _cfg(cfg)
    return bool(c.enabled and c.url and c.base_dn and c.bind_dn)


def normalize(username: str) -> str:
    """'CORP\\alice', 'alice@corp.local', ' Alice ' → 'alice'"""
    u = (username or "").strip()
    if "\\" in u:
        u = u.split("\\", 1)[1]
    if "@" in u:
        u = u.split("@", 1)[0]
    return u.lower()


def _server(c):
    from ldap3 import Server, Tls
    tls = None
    if c.url.lower().startswith("ldaps://") or c.starttls:
        tls = Tls(validate=ssl.CERT_REQUIRED if c.tls_verify else ssl.CERT_NONE,
                  ca_certs_data=c.ca_pem.strip() or None)
    return Server(c.url, tls=tls, connect_timeout=int(c.timeout or 6), get_info=None)


def _connect(user: Optional[str], password: Optional[str], cfg=None):
    """Bound connection, or raises."""
    from ldap3 import Connection, SIMPLE
    c = _cfg(cfg)
    conn = Connection(_server(c), user=user, password=password, authentication=SIMPLE,
                      receive_timeout=int(c.timeout or 6), raise_exceptions=False, read_only=True)
    from ldap3.core.exceptions import LDAPException
    try:
        conn.open()
        if c.starttls and not conn.start_tls():
            raise ConnectionError("StartTLS failed")
        ok = conn.bind()
    except LDAPException as e:
        raise ConnectionError(f"無法連線到 {c.url}：{e}") from e
    if not ok:
        conn.unbind()
        raise PermissionError(conn.result.get("description") or "bind failed")
    return conn


def _attrs(c):
    attrs = [c.login_attr, c.name_attr, c.dept_attr, c.mail_attr, "cn"]
    if getattr(c, "sync_manager", False) and getattr(c, "manager_attr", ""):
        attrs.append(c.manager_attr)
    return attrs


def _first(entry, attr) -> str:
    try:
        v = entry[attr].value
    except Exception:
        return ""
    if isinstance(v, list):
        v = v[0] if v else ""
    return str(v or "").strip()


def _account(entry, c) -> dict:
    login = _first(entry, c.login_attr).lower()
    return {
        "username": login,
        "display_name": _first(entry, c.name_attr) or _first(entry, "cn") or login,
        "email": _first(entry, c.mail_attr),
        "department": _first(entry, c.dept_attr),
        "dn": entry.entry_dn,
        "manager_dn": _first(entry, c.manager_attr) if getattr(c, "sync_manager", False) and getattr(c, "manager_attr", "") else "",
    }


def _user_filter(extra: str, c) -> str:
    return f"(&(objectClass=person){extra}{c.user_filter or ''})"


def _find(conn, username: str, c):
    from ldap3.utils.conv import escape_filter_chars
    flt = _user_filter(f"({c.login_attr}={escape_filter_chars(username)})", c)
    conn.search(c.base_dn, flt, attributes=_attrs(c), size_limit=2)
    return conn.entries[0] if len(conn.entries) == 1 else None


def authenticate(username: str, password: str, cfg=None) -> Optional[dict]:
    """Verify an AD / LDAP password. None = wrong user / password / not allowed."""
    c = _cfg(cfg)
    user = normalize(username)
    if not enabled(c) or not USERNAME_RE.match(user) or not password:
        return None
    try:
        if c.bind_dn:
            svc = _connect(c.bind_dn, c.bind_password, c)
            try:
                entry = _find(svc, user, c)
            finally:
                svc.unbind()
            if entry is None:
                return None
            info = _account(entry, c)
            try:
                _connect(info["dn"], password, c).unbind()
            except PermissionError:
                return None
            return info
        # Active Directory: bind with the user principal name, then read our own entry
        # (a full name@suffix typed in is used as it is: an account in another UPN suffix of the forest)
        raw = (username or "").strip()
        upn = raw if "@" in raw and USERNAME_RE.match(raw.split("@", 1)[0].lower()) else f"{user}@{c.domain}"
        try:
            conn = _connect(upn, password, c)
        except PermissionError:
            return None
        try:
            entry = _find(conn, user, c)
            return _account(entry, c) if entry is not None else None   # outside the allowed filter
        finally:
            conn.unbind()
    except PermissionError as e:                 # service account rejected
        log.error("LDAP service account bind failed: %s", e)
        raise ConnectionError("AD 服務帳號登入失敗：請檢查服務帳號 DN 與密碼") from e
    except ConnectionError:
        raise
    except Exception as e:                       # network / TLS / server errors
        log.error("LDAP error: %s", e)
        raise ConnectionError(f"無法連線到 AD：{e}") from e


def search_directory(text: str, limit: int = 15, cfg=None, raise_errors: bool = False) -> List[dict]:
    """Accounts whose login, name or mail contains `text` (service account required)."""
    c = _cfg(cfg)
    if not directory_enabled(c):
        return []
    from ldap3.utils.conv import escape_filter_chars
    t = escape_filter_chars((text or "").strip())
    if len(t) < 1:
        return []
    flt = _user_filter(f"(|({c.login_attr}=*{t}*)({c.name_attr}=*{t}*)({c.mail_attr}=*{t}*))", c)
    try:
        conn = _connect(c.bind_dn, c.bind_password, c)
        try:
            conn.search(c.base_dn, flt, attributes=_attrs(c), size_limit=limit)
            return [_account(e, c) for e in conn.entries if _first(e, c.login_attr)]
        finally:
            conn.unbind()
    except Exception as e:
        log.warning("LDAP directory search failed: %s", e)
        if raise_errors:
            raise ConnectionError(str(e)) from e
        return []


def lookup(username: str, cfg=None) -> Optional[dict]:
    c = _cfg(cfg)
    if not directory_enabled(c) or not USERNAME_RE.match(normalize(username)):
        return None
    try:
        conn = _connect(c.bind_dn, c.bind_password, c)
        try:
            entry = _find(conn, normalize(username), c)
            return _account(entry, c) if entry is not None else None
        finally:
            conn.unbind()
    except Exception as e:
        log.warning("LDAP lookup failed: %s", e)
        return None


def login_of_dn(dn: str, cfg=None) -> Optional[str]:
    """Login name of the account at `dn` (used for AD's manager attribute; needs the service account)."""
    c = _cfg(cfg)
    if not dn or not directory_enabled(c):
        return None
    from ldap3 import BASE
    try:
        conn = _connect(c.bind_dn, c.bind_password, c)
        try:
            conn.search(dn, "(objectClass=*)", search_scope=BASE, attributes=[c.login_attr])
            return _first(conn.entries[0], c.login_attr).lower() if conn.entries else None
        finally:
            conn.unbind()
    except Exception as e:
        log.warning("LDAP manager lookup failed for %s: %s", dn, e)
        return None
