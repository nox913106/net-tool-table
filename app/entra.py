"""
Microsoft Entra ID (Azure AD): sign-in with a Microsoft account, alongside AD and local accounts.

Sign-in is OpenID Connect, authorization code flow with PKCE, from the browser:
  /api/auth/entra/start → login.microsoftonline.com → /api/auth/entra/callback → a session like any other.
The ID token comes straight from Microsoft's token endpoint over TLS, so its claims are trusted as the
OpenID Connect specification allows; we still check the issuer, audience, tenant, nonce and expiry.

Accounts: someone whose on-premises sAMAccountName matches an existing AD account signs in as that same
account (hybrid directories); otherwise the account name is the part of the user principal name before
@ (as AD account names are), created on first sign-in.
Name, department, e-mail and 上級 are read from Microsoft Graph with the signed-in person's own token
(User.Read). Nothing is ever written to Entra ID or AD.

Optional: the people pickers can search Entra (Graph /users, application permission User.Read.All).
"""
import base64
import hashlib
import json
import logging
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Dict, List, Optional

from . import sysconfig

log = logging.getLogger("tool_table.entra")
import os
# Microsoft's endpoints (overridable only for tests against a local stand-in)
LOGIN = os.environ.get("TOOL_TABLE_ENTRA_LOGIN_URL", "https://login.microsoftonline.com").rstrip("/")
GRAPH = os.environ.get("TOOL_TABLE_ENTRA_GRAPH_URL", "https://graph.microsoft.com/v1.0").rstrip("/")
SCOPES = "openid profile email offline_access User.Read"
PENDING: Dict[str, dict] = {}             # state → {nonce, verifier, next, redirect, at}; ten minutes
PENDING_TTL = 600


class EntraError(RuntimeError):
    pass


def cfg() -> sysconfig.Entra:
    return sysconfig.entra()


def enabled(c=None) -> bool:
    c = c or cfg()
    return bool(c.enabled and c.tenant_id and c.client_id and c.client_secret_enc)


def groups(c) -> List[str]:
    return [g.strip().lower() for g in c.allowed_groups.replace("\n", ",").split(",") if g.strip()]


def _http(method: str, url: str, data=None, headers=None, timeout: float = 15):
    body = None
    headers = dict(headers or {})
    if isinstance(data, dict) and headers.get("Content-Type") == "application/json":
        body = json.dumps(data).encode()
    elif isinstance(data, dict):
        body = urllib.parse.urlencode(data).encode()
        headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read() or b"{}")
        except ValueError:
            err = {}
        inner = err.get("error")
        msg = err.get("error_description") or (inner.get("message") if isinstance(inner, dict) else inner) or ""
        raise EntraError(f"HTTP {e.code}：{str(msg)[:300]}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise EntraError(f"連不到 Microsoft（{getattr(e, 'reason', e)}）") from None


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _claims(jwt: str) -> dict:
    try:
        part = jwt.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    except (IndexError, ValueError):
        raise EntraError("Microsoft 回傳的身分權杖格式不正確") from None


def start(redirect_uri: str, next_url: str) -> str:
    """The URL that sends the browser to Microsoft's sign-in page."""
    c = cfg()
    if not enabled(c):
        raise EntraError("尚未設定 Microsoft Entra ID 登入")
    now = time.time()
    for k in [k for k, v in PENDING.items() if now - v["at"] > PENDING_TTL]:
        PENDING.pop(k, None)
    state, nonce, verifier = secrets.token_urlsafe(24), secrets.token_urlsafe(24), secrets.token_urlsafe(48)
    PENDING[state] = {"nonce": nonce, "verifier": verifier, "next": next_url, "redirect": redirect_uri, "at": now}
    q = {"client_id": c.client_id, "response_type": "code", "redirect_uri": redirect_uri, "response_mode": "query",
         "scope": SCOPES, "state": state, "nonce": nonce, "prompt": "select_account",
         "code_challenge": _b64url(hashlib.sha256(verifier.encode()).digest()), "code_challenge_method": "S256"}
    return f"{LOGIN}/{urllib.parse.quote(c.tenant_id)}/oauth2/v2.0/authorize?{urllib.parse.urlencode(q)}"


def finish(code: str, state: str) -> dict:
    """Exchange the code; check the ID token; read the person's profile. → {username, display_name, email,
    department, oid, upn, sam, manager: {sam, upn} | None, next}. Raises EntraError."""
    c = cfg()
    p = PENDING.pop(state or "", None)
    if not p or time.time() - p["at"] > PENDING_TTL:
        raise EntraError("登入逾時或來源不明，請重新登入")
    tok = _http("POST", f"{LOGIN}/{urllib.parse.quote(c.tenant_id)}/oauth2/v2.0/token", {
        "client_id": c.client_id, "client_secret": c.client_secret, "grant_type": "authorization_code", "code": code,
        "redirect_uri": p["redirect"], "code_verifier": p["verifier"], "scope": SCOPES})
    claims = _claims(tok.get("id_token") or "")
    now = time.time()
    if claims.get("aud") != c.client_id:
        raise EntraError("身分權杖不是發給這個應用程式的")
    if claims.get("nonce") != p["nonce"]:
        raise EntraError("身分權杖的 nonce 不符，請重新登入")
    if float(claims.get("exp") or 0) < now - 300:
        raise EntraError("身分權杖已過期，請重新登入")
    tid = claims.get("tid") or ""
    if not str(claims.get("iss") or "").startswith(f"{LOGIN}/{tid}/"):
        raise EntraError("身分權杖的簽發者不正確")
    if _looks_like_guid(c.tenant_id) and tid.lower() != c.tenant_id.lower():
        raise EntraError("這個 Microsoft 帳號不屬於設定的租用戶")
    at = tok.get("access_token") or ""
    auth = {"Authorization": f"Bearer {at}"}
    me = _http("GET", f"{GRAPH}/me?$select=id,userPrincipalName,displayName,mail,department,onPremisesSamAccountName,accountEnabled", headers=auth)
    allowed = groups(c)
    if allowed:
        got = {g.lower() for g in claims.get("groups") or []}
        if not got or "_claim_names" in claims:     # no groups claim, or too many groups for the token
            try:
                res = _http("POST", f"{GRAPH}/me/checkMemberGroups", {"groupIds": allowed},
                            headers={**auth, "Content-Type": "application/json"})
                got = {g.lower() for g in res.get("value") or []}
            except EntraError as e:
                raise EntraError(f"無法確認群組成員（請在應用程式註冊加上 groups 宣告，或授與 GroupMember.Read.All）：{e}") from None
        if not got & set(allowed):
            raise EntraError("你的 Microsoft 帳號不在允許登入的群組裡，請洽管理員")
    manager = None
    if c.sync_profile:
        try:
            m = _http("GET", f"{GRAPH}/me/manager?$select=userPrincipalName,onPremisesSamAccountName,displayName,mail,department", headers=auth)
            manager = _account(m)
        except EntraError:
            manager = None                       # none set, or not readable: keep what we had
    info = _account(me)
    info.update({"oid": me.get("id") or claims.get("oid"), "next": p["next"], "manager": manager})
    return info


def _looks_like_guid(s: str) -> bool:
    return len(s) == 36 and s.count("-") == 4


def _account(u: dict) -> dict:
    upn = (u.get("userPrincipalName") or "").lower()
    sam = (u.get("onPremisesSamAccountName") or "").lower()
    # the account name, as with AD: the on-premises account name, else the part of the UPN before @
    return {"username": sam or upn.split("@")[0], "upn": upn, "sam": sam, "display_name": u.get("displayName") or sam or upn,
            "email": u.get("mail") or (upn if "@" in upn else ""), "department": u.get("department") or ""}


# ------------------------------------------------------------- app-only (directory search, settings test)
_app_token = {"value": "", "until": 0.0}


def app_token(c=None) -> str:
    c = c or cfg()
    if _app_token["value"] and time.time() < _app_token["until"] - 60:
        return _app_token["value"]
    tok = _http("POST", f"{LOGIN}/{urllib.parse.quote(c.tenant_id)}/oauth2/v2.0/token", {
        "client_id": c.client_id, "client_secret": c.client_secret, "grant_type": "client_credentials",
        "scope": "https://graph.microsoft.com/.default"})
    _app_token.update(value=tok.get("access_token") or "", until=time.time() + float(tok.get("expires_in") or 600))
    return _app_token["value"]


def directory_enabled(c=None) -> bool:
    c = c or cfg()
    return enabled(c) and c.directory


def search_directory(text: str, limit: int = 15) -> List[dict]:
    """People in Entra whose name, account or e-mail starts with text (User.Read.All, application)."""
    t = text.replace('"', "").strip()
    if not t:
        return []
    q = urllib.parse.quote(f'"displayName:{t}" OR "userPrincipalName:{t}" OR "mail:{t}"')
    res = _http("GET", f"{GRAPH}/users?$search={q}&$top={limit}&$select=userPrincipalName,displayName,mail,department,onPremisesSamAccountName,accountEnabled",
                headers={"Authorization": f"Bearer {app_token()}", "ConsistencyLevel": "eventual"})
    return [_account(u) for u in res.get("value") or [] if u.get("accountEnabled", True)]


def test(values: dict, secret: Optional[str]) -> List[str]:
    """Check settings from the form without saving: tenant found, client ID and secret accepted, Graph reachable."""
    c = cfg()
    for k, v in values.items():
        if hasattr(c, k) and k != "client_secret_enc":
            setattr(c, k, v)
    if secret:
        c.client_secret_enc = sysconfig.encrypt(secret, "entra-secret")
    out = []
    if not c.tenant_id or not c.client_id:
        raise EntraError("請填寫租用戶（Tenant）ID 與應用程式（Client）ID")
    meta = _http("GET", f"{LOGIN}/{urllib.parse.quote(c.tenant_id)}/v2.0/.well-known/openid-configuration")
    out.append(f"租用戶：{meta.get('issuer', '')}")
    if not c.client_secret_enc:
        raise EntraError("請填寫用戶端密碼（Client secret）")
    _app_token.update(value="", until=0)
    app_token(c)
    out.append("應用程式 ID 與用戶端密碼正確")
    if c.directory:
        try:
            _http("GET", f"{GRAPH}/users?$top=1&$select=id", headers={"Authorization": f"Bearer {app_token(c)}"})
            out.append("可以搜尋目錄（User.Read.All）")
        except EntraError as e:
            out.append(f"不能搜尋目錄：{e}（請授與應用程式權限 User.Read.All 並由系統管理員同意）")
    return out
