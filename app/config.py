"""
Runtime configuration (environment variables)

Development: nothing to set — data lives in ./data and icons in ./resource/icon.
Production:  scripts/tool-table.sh writes /etc/tool-table/tool-table.env, e.g.
    TOOL_TABLE_DATA_DIR=/var/lib/tool-table
    TOOL_TABLE_ICON_DIR=/var/lib/tool-table/icons
    TOOL_TABLE_API_DOCS=admin
"""
import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


# SQLite database directory
DATA_DIR = Path(os.environ.get("TOOL_TABLE_DATA_DIR") or PROJECT_ROOT / "data")

# Icon directory (uploads go here; served at /resource/icon/)
ICON_DIR = Path(os.environ.get("TOOL_TABLE_ICON_DIR") or PROJECT_ROOT / "resource" / "icon")

# API documentation: Swagger UI at /docs and the OpenAPI document at /openapi.json
#   admin (default) — on the server, administrators only (signed in); a standalone copy: open
#   on              — anyone signed in
#   off             — not served at all
API_DOCS = (os.environ.get("TOOL_TABLE_API_DOCS") or "admin").strip().lower()
if API_DOCS not in ("admin", "on", "off"):
    API_DOCS = "on" if API_DOCS in ("1", "true", "yes") else "off" if API_DOCS in ("0", "false", "no") else "admin"
ENABLE_DOCS = API_DOCS != "off"

# Launch local programs / read shortcuts (Windows portable edition only;
# portable/launcher.py sets it). Never enable this on a shared server.
LOCAL_APPS = _bool("TOOL_TABLE_LOCAL_APPS", False)
# Standalone copy: replace its own program files with the version its server runs (portable/launcher.py
# sets the folder when the copy is an installed / unzipped one; unset = only report a different version).
SELF_UPDATE_DIR = os.environ.get("TOOL_TABLE_SELF_UPDATE_DIR") or ""
# Server: where a standalone copy gets the full installer when an update needs new Python packages
CLIENT_INSTALLER_URL = os.environ.get("TOOL_TABLE_CLIENT_INSTALLER_URL") or ""

# ---- Accounts (server edition) -------------------------------------------------
# Login for the whole site except the public task dashboard. The installer turns this on
# and creates the local break-glass account; the portable edition leaves it off.
AUTH = _bool("TOOL_TABLE_AUTH", False)
SESSION_HOURS = float(os.environ.get("TOOL_TABLE_SESSION_HOURS") or 12)     # idle timeout (sliding)
SESSION_MAX_DAYS = float(os.environ.get("TOOL_TABLE_SESSION_MAX_DAYS") or 7)
LOCAL_ADMIN = (os.environ.get("TOOL_TABLE_LOCAL_ADMIN") or "localadmin").strip().lower()

# Active Directory / LDAP. Two ways to log in:
#  * search + bind: TOOL_TABLE_LDAP_BIND_DN / _BIND_PASSWORD (read-only service account) — also
#    enables the account directory for @mentions and assigning people who never logged in
#  * direct bind as user@TOOL_TABLE_LDAP_DOMAIN (Active Directory UPN) — no service account needed
LDAP_URL = (os.environ.get("TOOL_TABLE_LDAP_URL") or "").strip()            # ldaps://dc1.corp.local
LDAP_DOMAIN = (os.environ.get("TOOL_TABLE_LDAP_DOMAIN") or "").strip()      # corp.local
LDAP_BASE_DN = (os.environ.get("TOOL_TABLE_LDAP_BASE_DN") or "").strip()    # DC=corp,DC=local
LDAP_BIND_DN = (os.environ.get("TOOL_TABLE_LDAP_BIND_DN") or "").strip()
LDAP_BIND_PASSWORD = os.environ.get("TOOL_TABLE_LDAP_BIND_PASSWORD") or ""
LDAP_USER_FILTER = (os.environ.get("TOOL_TABLE_LDAP_USER_FILTER") or "").strip()  # e.g. (memberOf=CN=IT,OU=Groups,DC=corp,DC=local)
LDAP_LOGIN_ATTR = os.environ.get("TOOL_TABLE_LDAP_LOGIN_ATTR") or "sAMAccountName"
LDAP_NAME_ATTR = os.environ.get("TOOL_TABLE_LDAP_NAME_ATTR") or "displayName"
LDAP_DEPT_ATTR = os.environ.get("TOOL_TABLE_LDAP_DEPT_ATTR") or "department"
LDAP_MAIL_ATTR = os.environ.get("TOOL_TABLE_LDAP_MAIL_ATTR") or "mail"
LDAP_STARTTLS = _bool("TOOL_TABLE_LDAP_STARTTLS", False)
LDAP_TLS_VERIFY = _bool("TOOL_TABLE_LDAP_TLS_VERIFY", True)
LDAP_CA_FILE = (os.environ.get("TOOL_TABLE_LDAP_CA_FILE") or "").strip()
LDAP_TIMEOUT = float(os.environ.get("TOOL_TABLE_LDAP_TIMEOUT") or 6)

ALLOWED_ICON_EXTENSIONS = {".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif"}
MAX_ICON_BYTES = 5 * 1024 * 1024
