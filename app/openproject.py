"""
OpenProject sync — one way, Tool Table → OpenProject (API v3).

A card linked to an OpenProject project (tasks.op_project) is pushed as a work package; its
subtasks become child work packages; comments and replies become work package comments; logged
time becomes time entries; attachments are uploaded. Changes made in OpenProject are not read
back — Tool Table is where people write, OpenProject is where it is reported.

Triggers (app/database.py) put a card in op_queue whenever anything on a linked card changes;
worker() pushes queued cards a few seconds later (so a burst of edits is one sync), retrying
with back-off. op_links remembers what each local item became remotely and a hash of what was
last sent, so unchanged items cost no request. op_state keeps the last success / error per card.
"""
import base64
import hashlib
import json
import logging
import re
import sqlite3
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Optional

from . import images as img
from . import sysconfig
from .database import DB_PATH

log = logging.getLogger("tool_table.openproject")
UA = "ToolTable-OpenProject-Sync"
DEBOUNCE_SECONDS = 4
BACKOFF = (30, 60, 120, 300, 600, 1800)
TT_STATUSES = ("recurring", "overdue", "new", "ongoing", "pending", "onhold", "complete", "canceled")
TT_STATUS_ZH = {"recurring": "週期工作", "overdue": "過期未結案", "new": "New（新建）", "ongoing": "On going（進行中）",
                "pending": "Pending（待確認）", "onhold": "On hold（暫緩）", "complete": "Complete（完成）", "canceled": "Canceled（取消）"}
# used when the admin has not mapped a status: match OpenProject's (English or Chinese) default names
STATUS_GUESS = {
    "new": ["new", "新建", "新增", "新"], "recurring": ["new", "新建", "新增", "新"],
    "ongoing": ["in progress", "進行中", "处理中", "進行"], "overdue": ["in progress", "進行中", "进行中"],
    "pending": ["on hold", "in specification", "待確認", "暫停"], "onhold": ["on hold", "暫停", "暫緩", "搁置"],
    "complete": ["closed", "done", "完成", "已關閉", "關閉", "已完成"], "canceled": ["rejected", "cancelled", "canceled", "拒絕", "取消", "已拒絕"],
}
_sync_lock = threading.Lock()          # one sync at a time (worker + "立即同步" button never interleave)
PRIORITY_GUESS = {"low": ["low", "低"], "normal": ["normal", "一般", "普通", "中"], "high": ["high", "高"]}


class OPError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


# --------------------------------------------------------------------- client
class Client:
    def __init__(self, cfg: sysconfig.OpenProject, api_key: Optional[str] = None):
        self.cfg = cfg
        self.base = cfg.url.rstrip("/")
        key = api_key if api_key is not None else cfg.api_key
        self.auth = "Basic " + base64.b64encode(f"apikey:{key}".encode()).decode()
        if not cfg.tls_verify:
            self.ctx = ssl._create_unverified_context()
        else:
            self.ctx = ssl.create_default_context()
            if cfg.ca_pem.strip():
                self.ctx.load_verify_locations(cadata=cfg.ca_pem)

    def href(self, kind: str, rid) -> str:
        return f"/api/v3/{kind}/{rid}"

    def web_url(self, wp_id) -> str:
        return f"{self.base}/work_packages/{wp_id}"

    def request(self, method: str, path: str, body=None, raw: Optional[bytes] = None, content_type: Optional[str] = None,
                query: Optional[dict] = None):
        url = self.base + path
        if query:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(query)
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", self.auth)
        req.add_header("Accept", "application/hal+json")
        req.add_header("User-Agent", UA)
        if data is not None:
            req.add_header("Content-Type", content_type or "application/json")
        try:
            with urllib.request.urlopen(req, timeout=self.cfg.timeout, context=self.ctx) as res:
                text = res.read()
                return json.loads(text) if text else {}
        except urllib.error.HTTPError as e:
            msg = ""
            try:
                err = json.loads(e.read() or b"{}")
                msg = err.get("message") or ""
                details = err.get("_embedded", {}).get("errors") or []
                if details:
                    msg = "；".join(d.get("message", "") for d in details if d.get("message")) or msg
            except (ValueError, AttributeError):
                pass
            raise OPError(e.code, f"OpenProject {method} {path} → HTTP {e.code}" + (f"：{msg}" if msg else ""))
        except urllib.error.URLError as e:
            reason = getattr(e, "reason", e)
            raise OPError(0, f"連不到 OpenProject（{self.base}）：{reason}")
        except (TimeoutError, OSError) as e:
            raise OPError(0, f"連不到 OpenProject（{self.base}）：{e}")

    def elements(self, path: str, query: Optional[dict] = None) -> list:
        q = {"pageSize": 500, **(query or {})}
        return (self.request("GET", path, query=q).get("_embedded") or {}).get("elements") or []

    def upload(self, wp_id, filename: str, data: bytes, mime: str) -> dict:
        boundary = uuid.uuid4().hex
        meta = json.dumps({"fileName": filename}).encode()
        safe = filename.replace('"', "_")
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n").encode() \
            + meta + (f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{safe}\"\r\n"
                      f"Content-Type: {mime.split(';')[0]}\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
        return self.request("POST", f"/api/v3/work_packages/{wp_id}/attachments", raw=body,
                            content_type=f"multipart/form-data; boundary={boundary}")


def link_id(obj: dict, rel: str) -> Optional[str]:
    href = ((obj.get("_links") or {}).get(rel) or {}).get("href") or ""
    m = re.search(r"/(\d+)$", href)
    return m.group(1) if m else None


def duration(minutes: int) -> str:
    h, m = divmod(int(minutes), 60)
    return "PT" + (f"{h}H" if h else "") + (f"{m}M" if m or not h else "")


# ---------------------------------------------------------- metadata (admin UI)
def meta(client: Client, project: Optional[str] = None) -> dict:
    """What the admin UI needs to map: projects, types, statuses, priorities, time activities."""
    out = {"me": None, "projects": [], "types": [], "statuses": [], "priorities": [], "activities": []}
    me = client.request("GET", "/api/v3/users/me")
    out["me"] = {"id": me.get("id"), "name": me.get("name"), "login": me.get("login"), "admin": me.get("admin")}
    out["projects"] = [{"id": str(p["id"]), "name": p.get("name"), "identifier": p.get("identifier")}
                       for p in client.elements("/api/v3/projects") if p.get("active", True)]
    try:
        types = client.elements(f"/api/v3/projects/{project}/types") if project else client.elements("/api/v3/types")
    except OPError:
        types = client.elements("/api/v3/types")
    out["types"] = [{"id": str(t["id"]), "name": t.get("name")} for t in types]
    out["statuses"] = [{"id": str(s["id"]), "name": s.get("name"), "closed": s.get("isClosed")} for s in client.elements("/api/v3/statuses")]
    out["priorities"] = [{"id": str(p["id"]), "name": p.get("name"), "default": p.get("isDefault")} for p in client.elements("/api/v3/priorities")]
    try:                                    # activities are only listed in the time entry form schema
        form = client.request("POST", "/api/v3/time_entries/form", body={})
        allowed = (((form.get("_embedded") or {}).get("schema") or {}).get("activity") or {})
        allowed = (allowed.get("_embedded") or {}).get("allowedValues") or []
        out["activities"] = [{"id": str(a["id"]), "name": a.get("name")} for a in allowed]
    except OPError:
        pass
    return out


def guess_maps(m: dict) -> dict:
    """Default status / priority mapping by name, for whatever the admin has not chosen."""
    def find(options, names):
        low = {o["name"].lower(): o["id"] for o in options if o.get("name")}
        for n in names:
            if n.lower() in low:
                return low[n.lower()]
        return ""
    return {"status_map": {k: find(m["statuses"], STATUS_GUESS[k]) for k in TT_STATUSES},
            "priority_map": {k: find(m["priorities"], v) for k, v in PRIORITY_GUESS.items()}}


# ------------------------------------------------------------------- sync
def _db():
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def _hash(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:24]


class Sync:
    def __init__(self, con, client: Client, cfg: sysconfig.OpenProject):
        self.con, self.c, self.cfg = con, client, cfg
        self.status_map = {**guess_maps({"statuses": [], "priorities": []})["status_map"], **{k: v for k, v in (cfg.status_map or {}).items() if v}}
        self.priority_map = {k: v for k, v in (cfg.priority_map or {}).items() if v}
        self.notify = {"notify": "true" if cfg.notify else "false"}
        self._project_for_users = None
        self.warnings = []

    # links -------------------------------------------------------------
    def link(self, kind, local_id):
        return self.con.execute("SELECT * FROM op_links WHERE kind = ? AND local_id = ?", (kind, local_id)).fetchone()

    def save_link(self, kind, local_id, remote_id, card_id, h=None):
        self.con.execute("""INSERT INTO op_links (kind, local_id, remote_id, card_id, hash, synced_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                            ON CONFLICT(kind, local_id) DO UPDATE SET remote_id = excluded.remote_id, card_id = excluded.card_id,
                            hash = excluded.hash, synced_at = CURRENT_TIMESTAMP""", (kind, local_id, str(remote_id), card_id, h))
        self.con.commit()

    def drop_link(self, kind, local_id):
        self.con.execute("DELETE FROM op_links WHERE kind = ? AND local_id = ?", (kind, local_id))
        self.con.commit()

    # people ------------------------------------------------------------
    def user(self, uid) -> Optional[str]:
        """OpenProject user id for a Tool Table account (same login; else same name among assignable users)."""
        if not uid:
            return None
        u = self.con.execute("SELECT username, display_name FROM users WHERE id = ?", (uid,)).fetchone()
        if not u:
            return None
        cached = self.con.execute("SELECT remote_id, checked_at FROM op_users WHERE username = ? AND checked_at > datetime('now', '-1 day')",
                                  (u["username"],)).fetchone()
        if cached:
            return cached["remote_id"]
        rid = None
        try:
            found = self.c.elements("/api/v3/users", {"filters": json.dumps([{"login": {"operator": "=", "values": [u["username"]]}}])})
            if found:
                rid = str(found[0]["id"])
        except OPError:
            found = []
        if not rid and self._project_for_users:
            try:
                for p in self.c.elements(f"/api/v3/projects/{self._project_for_users}/available_assignees"):
                    if (p.get("login") or "").lower() == u["username"].lower() or (u["display_name"] and p.get("name") == u["display_name"]):
                        rid = str(p["id"])
                        break
            except OPError:
                pass
        self.con.execute("INSERT OR REPLACE INTO op_users (username, remote_id, checked_at) VALUES (?, ?, CURRENT_TIMESTAMP)", (u["username"], rid))
        self.con.commit()
        return rid

    def name(self, uid) -> str:
        if not uid:
            return "本機"
        u = self.con.execute("SELECT username, display_name FROM users WHERE id = ?", (uid,)).fetchone()
        return (u["display_name"] or u["username"]) if u else "（已刪除的帳號）"

    # work packages -----------------------------------------------------
    def wp_payload(self, *, subject, description, start, due, status, priority, type_id, assignee, responsible, parent, estimate, project):
        links = {}
        if status and self.status_map.get(status):
            links["status"] = {"href": self.c.href("statuses", self.status_map[status])}
        if priority and self.priority_map.get(priority):
            links["priority"] = {"href": self.c.href("priorities", self.priority_map[priority])}
        if type_id:
            links["type"] = {"href": self.c.href("types", type_id)}
        links["assignee"] = {"href": self.c.href("users", assignee) if assignee else None}
        if responsible is not False:
            links["responsible"] = {"href": self.c.href("users", responsible) if responsible else None}
        if parent is not None:
            links["parent"] = {"href": self.c.href("work_packages", parent) if parent else None}
        body = {"subject": subject[:255], "description": {"format": "markdown", "raw": description},
                "startDate": (start or "")[:10] or None, "dueDate": (due or "")[:10] or None, "_links": links}
        if estimate is not None:
            body["estimatedTime"] = duration(estimate) if estimate else None
        return body, project

    def push_wp(self, kind, local_id, card_id, body, project) -> str:
        """Create or update one work package; returns its id. Skips the request when nothing changed."""
        h = _hash({"b": body, "p": project})
        ln = self.link(kind, local_id)
        if ln and ln["hash"] == h:
            return ln["remote_id"]
        if ln:
            try:
                cur = self.c.request("GET", f"/api/v3/work_packages/{ln['remote_id']}")
                patch = dict(body, lockVersion=cur.get("lockVersion"))
                if link_id(cur, "project") != str(project):
                    patch["_links"] = dict(patch["_links"], project={"href": self.c.href("projects", project)})
                try:
                    self.c.request("PATCH", f"/api/v3/work_packages/{ln['remote_id']}", body=patch, query=self.notify)
                except OPError as e:
                    if e.status != 422 or "status" not in patch["_links"]:
                        raise
                    # e.g. a workflow that does not allow this status change for the API user: push the rest
                    patch["_links"] = {k: v for k, v in patch["_links"].items() if k != "status"}
                    cur = self.c.request("GET", f"/api/v3/work_packages/{ln['remote_id']}")
                    patch["lockVersion"] = cur.get("lockVersion")
                    self.c.request("PATCH", f"/api/v3/work_packages/{ln['remote_id']}", body=patch, query=self.notify)
                    self.warnings.append(f"狀態沒有同步（OpenProject 不允許）：{e}")
                self.save_link(kind, local_id, ln["remote_id"], card_id, h)
                return ln["remote_id"]
            except OPError as e:
                if e.status != 404:
                    raise
                self.drop_link(kind, local_id)              # deleted in OpenProject: create it again
        try:
            wp = self.c.request("POST", f"/api/v3/projects/{project}/work_packages", body=body, query=self.notify)
        except OPError as e:
            if e.status != 422 or "status" not in body["_links"]:
                raise
            # many workflows only allow the initial status on create: create, then move it
            first = dict(body, _links={k: v for k, v in body["_links"].items() if k != "status"})
            wp = self.c.request("POST", f"/api/v3/projects/{project}/work_packages", body=first, query=self.notify)
            try:
                self.c.request("PATCH", f"/api/v3/work_packages/{wp['id']}",
                               body={"lockVersion": wp.get("lockVersion"), "_links": {"status": body["_links"]["status"]}}, query=self.notify)
            except OPError as e2:
                self.warnings.append(f"狀態沒有同步（OpenProject 不允許）：{e2}")
        self.save_link(kind, local_id, wp["id"], card_id, h)
        return str(wp["id"])

    def retire_wp(self, kind, local_id, note):
        """A synced card / subtask is gone here: mark it canceled over there (never delete remote data)."""
        ln = self.link(kind, local_id)
        if not ln:
            return
        try:
            cur = self.c.request("GET", f"/api/v3/work_packages/{ln['remote_id']}")
            links = {}
            if self.status_map.get("canceled"):
                links["status"] = {"href": self.c.href("statuses", self.status_map["canceled"])}
            if links:
                try:
                    self.c.request("PATCH", f"/api/v3/work_packages/{ln['remote_id']}", body={"lockVersion": cur.get("lockVersion"), "_links": links}, query=self.notify)
                except OPError:
                    pass
            self.c.request("POST", f"/api/v3/work_packages/{ln['remote_id']}/activities", body={"comment": {"raw": note}}, query=self.notify)
        except OPError as e:
            if e.status != 404:
                raise
        self.drop_link(kind, local_id)

    # the whole card ----------------------------------------------------
    def sync_card(self, card_id: int) -> dict:
        self.warnings = []
        con = self.con
        t = con.execute("SELECT * FROM tasks WHERE id = ?", (card_id,)).fetchone()
        if not t:                                            # deleted here
            for ln in con.execute("SELECT kind, local_id FROM op_links WHERE card_id = ? AND kind = 'subtask'", (card_id,)).fetchall():
                self.drop_link("subtask", ln["local_id"])
            self.retire_wp("card", card_id, "此卡片已在 Tool Table 刪除。")
            con.execute("DELETE FROM op_links WHERE card_id = ?", (card_id,))
            con.commit()
            return {"deleted": True}
        project = t["op_project"]
        if not project:
            return {"skipped": "not linked"}
        self._project_for_users = project

        members = con.execute("SELECT user_id, role FROM task_members WHERE task_id = ? ORDER BY created_at", (card_id,)).fetchall()
        assignees = [m["user_id"] for m in members if m["role"] == "assignee"]
        names = [self.name(u) for u in assignees]
        desc = (t["description"] or "").strip()
        footer = [f"Tool Table 卡片 #{card_id}"]
        if names:
            footer.append("負責：" + "、".join(names))
        if t["repeat"]:
            footer.append(f"週期：{t['repeat']}")
        description = (desc + "\n\n" if desc else "") + "---\n_" + " · ".join(footer) + "（由 Tool Table 同步；在 OpenProject 的修改不會回寫）_"
        body, proj = self.wp_payload(
            subject=t["title"], description=description, start=t["start_at"], due=t["due_at"], status=t["status"], priority=t["priority"],
            type_id=self.cfg.card_type or None, assignee=self.user(assignees[0]) if assignees else self.user(t["owner_id"]),
            responsible=self.user(t["owner_id"]), parent=None, estimate=None, project=project)
        wp_card = self.push_wp("card", card_id, card_id, body, proj)

        # subtasks
        subs = con.execute("""SELECT * FROM task_comments WHERE task_id = ? AND is_task = 1 AND parent_id IS NULL
                              ORDER BY COALESCE(sort_order, id), id""", (card_id,)).fetchall()
        sub_wp = {}
        for n, s in enumerate(subs, 1):
            body_text = (s["body"] or "").strip()
            sdesc = (body_text + "\n\n" if body_text and body_text != (s["title"] or "") else "") + \
                f"---\n_Tool Table 子任務 {n}（卡片 #{card_id}，{self.name(s['user_id'])} 建立；由 Tool Table 同步）_"
            body, proj = self.wp_payload(
                subject=s["title"] or "子任務", description=sdesc, start=s["start_at"], due=s["due_at"], status=s["status"] or "new",
                priority=None, type_id=self.cfg.subtask_type or None, assignee=self.user(s["assignee_id"]), responsible=False,
                parent=wp_card, estimate=s["estimate_minutes"] or 0, project=project)
            sub_wp[s["id"]] = self.push_wp("subtask", s["id"], card_id, body, proj)
        for ln in con.execute("SELECT local_id FROM op_links WHERE card_id = ? AND kind = 'subtask'", (card_id,)).fetchall():
            if ln["local_id"] not in sub_wp:
                self.retire_wp("subtask", ln["local_id"], "此子任務已在 Tool Table 刪除或改回一般留言。")

        def target(comment) -> str:
            root = comment["parent_id"] or comment["id"]
            return sub_wp.get(root, wp_card)

        comments = con.execute("SELECT * FROM task_comments WHERE task_id = ? ORDER BY id", (card_id,)).fetchall()
        by_id = {c["id"]: c for c in comments}

        # attachments (before comments, so a comment can name its files)
        files_of = {}
        if self.cfg.sync_attachments:
            rows = con.execute("SELECT * FROM task_images WHERE task_id = ? AND pending = 0 ORDER BY id", (card_id,)).fetchall()
            alive = set()
            for im in rows:
                alive.add(im["id"])
                files_of.setdefault(im["comment_id"], []).append(im["name"] or im["stored"])
                if self.link("attachment", im["id"]):
                    continue
                p = img.path(im["stored"])
                if not p or not p.is_file():
                    continue
                wp = target(by_id[im["comment_id"]]) if im["comment_id"] in by_id else wp_card
                a = self.c.upload(wp, im["name"] or im["stored"], p.read_bytes(), im["mime"])
                self.save_link("attachment", im["id"], a.get("id"), card_id)
            for ln in con.execute("SELECT local_id, remote_id FROM op_links WHERE card_id = ? AND kind = 'attachment'", (card_id,)).fetchall():
                if ln["local_id"] not in alive:
                    try:
                        self.c.request("DELETE", f"/api/v3/attachments/{ln['remote_id']}")
                    except OPError as e:
                        if e.status not in (403, 404):
                            raise
                    self.drop_link("attachment", ln["local_id"])

        # comments + replies (a subtask's own text is its description, not a comment)
        if self.cfg.sync_comments:
            for c in comments:
                if c["parent_id"] is None and c["id"] in sub_wp:
                    continue
                if self.link("comment", c["id"]):
                    continue
                who = self.name(c["user_id"])
                parent = by_id.get(c["parent_id"]) if c["parent_id"] else None
                head = f"**{who}**" + (f" 回覆 {self.name(parent['user_id'])}" if parent else "") + f"（Tool Table，{(c['created_at'] or '')[:16]}）："
                files = files_of.get(c["id"]) or []
                text = head + "\n\n" + (c["body"] or "") + (("\n\n附件：" + "、".join(files)) if files else "")
                act = self.c.request("POST", f"/api/v3/work_packages/{target(c)}/activities", body={"comment": {"raw": text}}, query=self.notify)
                self.save_link("comment", c["id"], act.get("id") or "0", card_id)

        # time entries (finished ones only)
        if self.cfg.sync_time:
            entries = con.execute("""SELECT * FROM task_time WHERE task_id = ? AND minutes IS NOT NULL
                                     AND (started_at IS NULL OR ended_at IS NOT NULL) ORDER BY id""", (card_id,)).fetchall()
            alive = set()
            for e in entries:
                alive.add(e["id"])
                if self.link("time", e["id"]) or e["comment_id"] not in sub_wp:
                    continue
                self.push_time(e, sub_wp[e["comment_id"]], card_id)
            for ln in con.execute("SELECT local_id, remote_id FROM op_links WHERE card_id = ? AND kind = 'time'", (card_id,)).fetchall():
                if ln["local_id"] not in alive:
                    try:
                        self.c.request("DELETE", f"/api/v3/time_entries/{ln['remote_id']}")
                    except OPError as e:
                        if e.status not in (403, 404):
                            raise
                    self.drop_link("time", ln["local_id"])
        return {"work_package": wp_card, "url": self.c.web_url(wp_card), "warnings": self.warnings}

    def push_time(self, e, wp_id, card_id):
        who = self.name(e["user_id"])
        note = (e["note"] or "").strip()
        links = {"workPackage": {"href": self.c.href("work_packages", wp_id)}}
        if self.cfg.time_activity:
            links["activity"] = {"href": f"/api/v3/time_entries/activities/{self.cfg.time_activity}"}
        op_user = self.user(e["user_id"])
        body = {"hours": duration(e["minutes"]), "spentOn": e["work_date"] or time.strftime("%Y-%m-%d"),
                "comment": {"raw": note}, "_links": dict(links)}
        if op_user:
            body["_links"]["user"] = {"href": self.c.href("users", op_user)}
        attempts = [body]
        # without "log time for other users" permission: log as the API user and name the person
        attempts.append(dict(body, comment={"raw": f"{who}：{note}" if note else who}, _links=dict(links)))
        # OpenProject 14+: the work package is the time entry's "entity"
        for b in list(attempts):
            ent = dict(b["_links"]); ent["entity"] = ent.pop("workPackage")
            attempts.append(dict(b, _links=ent))
        last = None
        for b in attempts:
            try:
                res = self.c.request("POST", "/api/v3/time_entries", body=b)
                self.save_link("time", e["id"], res.get("id"), card_id)
                return
            except OPError as err:
                if err.status not in (403, 422):
                    raise
                last = err
        raise last


def configured() -> Optional[sysconfig.OpenProject]:
    cfg = sysconfig.openproject()
    return cfg if cfg.enabled and cfg.url and cfg.api_key_enc else None


def state_set(con, card_id, error: Optional[str]):
    if error:
        con.execute("""INSERT INTO op_state (card_id, error, error_at) VALUES (?, ?, CURRENT_TIMESTAMP)
                       ON CONFLICT(card_id) DO UPDATE SET error = excluded.error, error_at = CURRENT_TIMESTAMP""", (card_id, error[:500]))
    else:
        con.execute("""INSERT INTO op_state (card_id, ok_at, error) VALUES (?, CURRENT_TIMESTAMP, NULL)
                       ON CONFLICT(card_id) DO UPDATE SET ok_at = CURRENT_TIMESTAMP, error = NULL""", (card_id,))
    con.commit()


def sync_now(card_id: int) -> dict:
    """Push one card right away (used by the worker and the "立即同步" button)."""
    cfg = configured()
    if not cfg:
        raise OPError(0, "OpenProject 同步沒有啟用（系統設定 → OpenProject）")
    with _sync_lock:
        return _sync_locked(cfg, card_id)


def _sync_locked(cfg, card_id: int) -> dict:
    con = _db()
    try:
        try:
            res = Sync(con, Client(cfg), cfg).sync_card(card_id)
        except OPError as e:
            state_set(con, card_id, str(e))
            raise
        except Exception as e:                            # never leave a card silently unsynced
            log.exception("OpenProject sync of card %s failed", card_id)
            state_set(con, card_id, f"同步失敗：{e}")
            raise OPError(0, f"同步失敗：{e}")
        state_set(con, card_id, "；".join(res.get("warnings") or []) or None)
        con.execute("DELETE FROM op_queue WHERE card_id = ?", (card_id,))
        con.commit()
        return res
    finally:
        con.close()


def run_queue(limit: int = 20) -> int:
    """Push due cards from the queue (called every few seconds)."""
    if not configured():
        return 0
    con = _db()
    try:
        due = con.execute(f"""SELECT card_id, attempts FROM op_queue
                              WHERE next_try <= CURRENT_TIMESTAMP AND queued_at <= datetime('now', '-{DEBOUNCE_SECONDS} seconds')
                              ORDER BY queued_at LIMIT ?""", (limit,)).fetchall()
    finally:
        con.close()
    done = 0
    for row in due:
        try:
            sync_now(row["card_id"])
            done += 1
        except OPError as e:
            wait = BACKOFF[min(row["attempts"], len(BACKOFF) - 1)]
            con = _db()
            try:
                con.execute(f"""UPDATE op_queue SET attempts = attempts + 1, next_try = datetime('now', '+{wait} seconds')
                                WHERE card_id = ?""", (row["card_id"],))
                con.commit()
            finally:
                con.close()
            log.warning("OpenProject sync of card %s failed (retry in %ss): %s", row["card_id"], wait, e)
            if e.status == 0 or e.status == 401:
                break                                       # server down / key wrong: stop this round
    return done


def requeue_all() -> int:
    con = _db()
    try:
        cur = con.execute("""INSERT INTO op_queue (card_id) SELECT id FROM tasks WHERE op_project IS NOT NULL
                             ON CONFLICT(card_id) DO UPDATE SET attempts = 0, next_try = CURRENT_TIMESTAMP""")
        con.commit()
        return cur.rowcount
    finally:
        con.close()


def overview() -> dict:
    con = _db()
    try:
        linked = con.execute("SELECT COUNT(*) FROM tasks WHERE op_project IS NOT NULL").fetchone()[0]
        queued = con.execute("SELECT COUNT(*) FROM op_queue").fetchone()[0]
        errors = [dict(r) for r in con.execute("""SELECT s.card_id, t.title, s.error, s.error_at FROM op_state s
                                                  LEFT JOIN tasks t ON t.id = s.card_id WHERE s.error IS NOT NULL
                                                  ORDER BY s.error_at DESC LIMIT 20""").fetchall()]
        last_ok = con.execute("SELECT MAX(ok_at) FROM op_state").fetchone()[0]
        return {"linked": linked, "queued": queued, "errors": errors, "last_ok": last_ok}
    finally:
        con.close()
