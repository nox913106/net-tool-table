"""
Active Directory / LDAP sign-in and account directory.

authenticate(username, password) → dict(username, display_name, email, department) or None
search_directory(text)          → accounts matching a name (needs the read-only service account)
lookup(username)                → one account by login name (service account)

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

from . import config as C

log = logging.getLogger("tool_table.ldap")
USERNAME_RE = re.compile(r"^[A-Za-z0-9._\-]{1,64}$")


def enabled() -> bool:
    return bool(C.LDAP_URL and C.LDAP_BASE_DN and (C.LDAP_BIND_DN or C.LDAP_DOMAIN))


def directory_enabled() -> bool:
    return bool(C.LDAP_URL and C.LDAP_BASE_DN and C.LDAP_BIND_DN)


def normalize(username: str) -> str:
    """'CORP\\alice', 'alice@corp.local', ' Alice ' → 'alice'"""
    u = (username or "").strip()
    if "\\" in u:
        u = u.split("\\", 1)[1]
    if "@" in u:
        u = u.split("@", 1)[0]
    return u.lower()


def _server():
    from ldap3 import Server, Tls
    tls = None
    if C.LDAP_URL.lower().startswith("ldaps://") or C.LDAP_STARTTLS:
        tls = Tls(validate=ssl.CERT_REQUIRED if C.LDAP_TLS_VERIFY else ssl.CERT_NONE,
                  ca_certs_file=C.LDAP_CA_FILE or None)
    return Server(C.LDAP_URL, tls=tls, connect_timeout=int(C.LDAP_TIMEOUT), get_info=None)


def _connect(user: Optional[str], password: Optional[str]):
    """Bound connection, or raises."""
    from ldap3 import Connection, SIMPLE
    conn = Connection(_server(), user=user, password=password, authentication=SIMPLE,
                      receive_timeout=int(C.LDAP_TIMEOUT), raise_exceptions=False, read_only=True)
    from ldap3.core.exceptions import LDAPException
    try:
        conn.open()
        if C.LDAP_STARTTLS and not conn.start_tls():
            raise ConnectionError("StartTLS failed")
        ok = conn.bind()
    except LDAPException as e:
        raise ConnectionError(f"cannot reach {C.LDAP_URL}: {e}") from e
    if not ok:
        conn.unbind()
        raise PermissionError(conn.result.get("description") or "bind failed")
    return conn


def _attrs():
    return [C.LDAP_LOGIN_ATTR, C.LDAP_NAME_ATTR, C.LDAP_DEPT_ATTR, C.LDAP_MAIL_ATTR, "cn"]


def _first(entry, attr) -> str:
    try:
        v = entry[attr].value
    except Exception:
        return ""
    if isinstance(v, list):
        v = v[0] if v else ""
    return str(v or "").strip()


def _account(entry) -> dict:
    login = _first(entry, C.LDAP_LOGIN_ATTR).lower()
    return {
        "username": login,
        "display_name": _first(entry, C.LDAP_NAME_ATTR) or _first(entry, "cn") or login,
        "email": _first(entry, C.LDAP_MAIL_ATTR),
        "department": _first(entry, C.LDAP_DEPT_ATTR),
        "dn": entry.entry_dn,
    }


def _user_filter(extra: str) -> str:
    base = f"(&(objectClass=person){extra}{C.LDAP_USER_FILTER})"
    return base


def _find(conn, username: str):
    from ldap3.utils.conv import escape_filter_chars
    flt = _user_filter(f"({C.LDAP_LOGIN_ATTR}={escape_filter_chars(username)})")
    conn.search(C.LDAP_BASE_DN, flt, attributes=_attrs(), size_limit=2)
    return conn.entries[0] if len(conn.entries) == 1 else None


def authenticate(username: str, password: str) -> Optional[dict]:
    """Verify an AD / LDAP password. None = wrong user / password / not allowed."""
    user = normalize(username)
    if not enabled() or not USERNAME_RE.match(user) or not password:
        return None
    try:
        if C.LDAP_BIND_DN:
            svc = _connect(C.LDAP_BIND_DN, C.LDAP_BIND_PASSWORD)
            try:
                entry = _find(svc, user)
            finally:
                svc.unbind()
            if entry is None:
                return None
            info = _account(entry)
            try:
                _connect(info["dn"], password).unbind()
            except PermissionError:
                return None
            return info
        # Active Directory: bind with the user principal name, then read our own entry
        try:
            conn = _connect(f"{user}@{C.LDAP_DOMAIN}", password)
        except PermissionError:
            return None
        try:
            entry = _find(conn, user)
            return _account(entry) if entry is not None else None   # outside the allowed filter
        finally:
            conn.unbind()
    except PermissionError as e:                 # service account rejected
        log.error("LDAP service account bind failed: %s", e)
        raise ConnectionError("AD 服務帳號登入失敗，請檢查設定") from e
    except ConnectionError:
        raise
    except Exception as e:                       # network / TLS / server errors
        log.error("LDAP error: %s", e)
        raise ConnectionError(f"無法連線到 AD：{e}") from e


def search_directory(text: str, limit: int = 15) -> List[dict]:
    """Accounts whose login, name or mail contains `text` (service account required)."""
    if not directory_enabled():
        return []
    from ldap3.utils.conv import escape_filter_chars
    t = escape_filter_chars((text or "").strip())
    if len(t) < 1:
        return []
    flt = _user_filter(f"(|({C.LDAP_LOGIN_ATTR}=*{t}*)({C.LDAP_NAME_ATTR}=*{t}*)({C.LDAP_MAIL_ATTR}=*{t}*))")
    try:
        conn = _connect(C.LDAP_BIND_DN, C.LDAP_BIND_PASSWORD)
        try:
            conn.search(C.LDAP_BASE_DN, flt, attributes=_attrs(), size_limit=limit)
            return [_account(e) for e in conn.entries if _first(e, C.LDAP_LOGIN_ATTR)]
        finally:
            conn.unbind()
    except Exception as e:
        log.warning("LDAP directory search failed: %s", e)
        return []


def lookup(username: str) -> Optional[dict]:
    if not directory_enabled() or not USERNAME_RE.match(normalize(username)):
        return None
    try:
        conn = _connect(C.LDAP_BIND_DN, C.LDAP_BIND_PASSWORD)
        try:
            entry = _find(conn, normalize(username))
            return _account(entry) if entry is not None else None
        finally:
            conn.unbind()
    except Exception as e:
        log.warning("LDAP lookup failed: %s", e)
        return None
