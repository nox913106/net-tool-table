"""
Microsoft Teams notifications (server edition).

How it reaches Teams: in a Teams channel, add the Workflow “Post to a channel when a webhook request is
received”, and paste the URL it gives into 系統設定 → 發送與通知. Messages are Adaptive Cards. No Entra ID
application is needed, so notifications keep working even when sign-in or e-mail settings have problems.
Each channel picks what it receives:
  changes   what changed on cards and subtasks (title, status, dates, owners, new subtasks, comments …):
            one message per card, sent once nobody has touched the card for a minute, field: old → new
  project   the daily project events (behind baseline, late cross-project predecessor, window clash,
            milestone due within 3 days) — the same as the in-app project notifications
  system    alerts: disk, memory, CPU load, temperature, RAID, reboot, backups, HTTPS certificate, AD /
            Entra reachability, database, nginx — when something goes wrong, while it stays wrong
            (every few hours) and when it recovers (app/monitor.py)
  health    the scheduled system status report
… and which cards (changes): projects only (a project and everything that belongs to it), all cards,
or chosen projects. Channel addresses are secrets: stored encrypted, never shown again.

Messages are queued (teams_queue) and sent in the background with retries, so a slow or failing Teams
never slows anyone down. Who changed what is captured by the database itself (app/database.py), so edits
from every path count: the editor, drag and drop, closing, standalone copies syncing up, roll-ups.
"""
import json
import logging
import secrets
import time
import urllib.error
import urllib.request
from datetime import datetime
from typing import Dict, List, Optional

from . import sysconfig
from .database import CAPTURE, get_db

log = logging.getLogger("tool_table.teams")
EVENTS = ("changes", "project", "system", "health")


# ------------------------------------------------------------------ settings
def cfg() -> sysconfig.Teams:
    return sysconfig.teams()


def channel_url(ch: dict) -> str:
    return sysconfig.decrypt(ch.get("url_enc") or "", "teams-url")


def active_channels(event: str, c=None) -> List[dict]:
    c = c or cfg()
    return [ch for ch in c.channels if ch.get("enabled", True) and event in (ch.get("events") or []) and ch.get("url_enc")]


def refresh_capture():
    """Changes are captured only while some channel wants them."""
    CAPTURE["on"] = bool(active_channels("changes"))


def lang(c=None) -> str:
    c = c or cfg()
    if c.lang in ("zh-TW", "en"):
        return c.lang
    try:
        import sqlite3
        from .database import DB_PATH
        with sqlite3.connect(DB_PATH) as db:
            r = db.execute("SELECT value FROM settings WHERE key = 'language'").fetchone()
        v = json.loads(r[0]) if r else "zh-TW"
        return v if v in ("zh-TW", "en") else "zh-TW"
    except Exception:
        return "zh-TW"


def site_url(c=None) -> str:
    c = c or cfg()
    if c.site_url:
        return c.site_url.rstrip("/")
    import os
    fqdn = os.environ.get("TOOL_TABLE_FQDN") or ""
    port = os.environ.get("TOOL_TABLE_HTTPS_PORT") or ""
    if not fqdn:
        import socket
        fqdn = socket.getfqdn()
    return f"https://{fqdn}" + (f":{port}" if port and port != "443" else "")


# ------------------------------------------------------------------ the message
def card(title: str, lines: List[str], link: Optional[str] = None, level: str = "", link_text: str = "") -> dict:
    """A Teams Adaptive Card: a bold title, one text block per line, an optional button."""
    color = {"fail": "Attention", "warn": "Warning", "ok": "Good"}.get(level, "Default")
    body = [{"type": "TextBlock", "text": title, "weight": "Bolder", "size": "Medium", "wrap": True, "color": color}]
    body += [{"type": "TextBlock", "text": ln, "wrap": True, "spacing": "Small"} for ln in lines if ln]
    content = {"$schema": "http://adaptivecards.io/schemas/adaptive-card.json", "type": "AdaptiveCard", "version": "1.4",
               "body": body, "msteams": {"width": "Full"}}
    if link:
        content["actions"] = [{"type": "Action.OpenUrl", "title": link_text or "Open", "url": link}]
    return {"type": "message", "attachments": [{"contentType": "application/vnd.microsoft.card.adaptive", "content": content}]}


def post(url: str, payload: dict, timeout: float = 20):
    req = urllib.request.Request(url, data=json.dumps(payload, ensure_ascii=False).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            r.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}：{(e.read() or b'')[:200].decode('utf-8', 'replace')}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise RuntimeError(f"連不到 Teams（{getattr(e, 'reason', e)}）") from None


async def enqueue(db, channel_id: str, kind: str, payload: dict):
    await db.execute("INSERT INTO teams_queue (channel, kind, payload) VALUES (?, ?, ?)",
                     (channel_id, kind, json.dumps(payload, ensure_ascii=False)))


async def send_to(event: str, payload_for, db=None, project: Optional[int] = None):
    """Queue a message for every channel that wants this event (and, for project events, this project)."""
    own = db is None
    db = db or await get_db()
    try:
        for ch in active_channels(event):
            if project is not None and not await _in_scope(db, ch, project):
                continue
            await enqueue(db, ch["id"], event, payload_for(ch))
        if own:
            await db.commit()
    finally:
        if own:
            await db.close()


async def flush(limit: int = 20) -> int:
    """Send what is queued; each message is tried up to 3 times. Runs in the background every few seconds."""
    import asyncio
    c = cfg()
    by_id = {ch["id"]: ch for ch in c.channels}
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM teams_queue WHERE sent_at IS NULL AND attempts < 3 ORDER BY id LIMIT ?", (limit,))
        rows = [dict(r) for r in await cur.fetchall()]
        n = 0
        for r in rows:
            ch = by_id.get(r["channel"])
            if not ch:
                await db.execute("UPDATE teams_queue SET attempts = 3, result = 'channel removed' WHERE id = ?", (r["id"],))
                continue
            try:
                await asyncio.get_running_loop().run_in_executor(None, post, channel_url(ch), json.loads(r["payload"]))
                await db.execute("UPDATE teams_queue SET sent_at = CURRENT_TIMESTAMP, attempts = attempts + 1, result = 'ok' WHERE id = ?", (r["id"],))
                result = f"{datetime.now():%Y-%m-%d %H:%M} {ch.get('name') or ''}：已送出"
            except Exception as e:
                await db.execute("UPDATE teams_queue SET attempts = attempts + 1, result = ? WHERE id = ?", (str(e)[:300], r["id"]))
                result = f"{datetime.now():%Y-%m-%d %H:%M} {ch.get('name') or ''}：{e}"
                log.warning("Teams send failed: %s", e)
            n += 1
            await db.commit()
            sysconfig.save_teams({"last_result": result[:300]})
        await db.execute("DELETE FROM teams_queue WHERE created_at < datetime('now', '-7 days')")
        await db.commit()
        return n
    finally:
        await db.close()


# ------------------------------------------------------------------ which cards a channel follows
async def _root_project(db, card_id: int) -> Optional[int]:
    cur = await db.execute("SELECT kind, project_id FROM tasks WHERE id = ?", (card_id,))
    r = await cur.fetchone()
    if not r:
        return None
    return card_id if (r[0] or "ops") == "project" else r[1]


async def _in_scope(db, ch: dict, project: Optional[int]) -> bool:
    scope = ch.get("scope") or "projects"
    if scope == "all":
        return True
    if scope == "projects":
        return project is not None
    return project is not None and project in [int(x) for x in ch.get("projects") or [] if str(x).isdigit()]


# ------------------------------------------------------------------ change digests
T = {   # (zh, en)
    "title": ("標題", "Title"), "status": ("狀態", "Status"), "priority": ("優先", "Priority"), "start_at": ("開始", "Start"),
    "due_at": ("到期", "Due"), "milestone": ("里程碑", "Milestone"), "blocked_reason": ("卡住", "Blocked"), "kind": ("類型", "Type"),
    "project_id": ("歸屬專案", "Project"), "description": ("說明", "Description"), "deps": ("前置任務", "Predecessors"),
    "win": ("時段", "Window"), "assignee_id": ("負責人", "Owner"), "assignee": ("負責人", "Owner"), "body": ("說明", "Description"),
}
STATUS = {"recurring": ("週期工作", "Recurring"), "overdue": ("過期未結案", "Overdue"), "new": ("新建", "New"), "ongoing": ("進行中", "On going"),
          "pending": ("待確認", "Pending"), "onhold": ("暫緩", "On hold"), "complete": ("完成", "Complete"), "canceled": ("取消", "Canceled")}
PRIORITY = {"low": ("低", "Low"), "normal": ("一般", "Normal"), "high": ("高", "High")}
WORDS = {
    "changed": ("{0}：{1} → {2}", "{0}: {1} → {2}"), "edited": ("{0}：已修改", "{0}: edited"),
    "new_card": ("新增卡片「{0}」", "New card “{0}”"), "del_card": ("刪除了卡片「{0}」", "Deleted card “{0}”"),
    "new_sub": ("新增子任務「{0}」", "New subtask “{0}”"), "del_sub": ("刪除子任務「{0}」", "Deleted subtask “{0}”"),
    "sub": ("子任務「{0}」", "Subtask “{0}”"), "comment": ("留言：{0}", "Comment: {0}"),
    "add_owner": ("加入負責人 {0}", "Owner added: {0}"), "del_owner": ("移除負責人 {0}", "Owner removed: {0}"),
    "by": ("（{0}）", " ({0})"), "system": ("系統", "system"), "empty": ("（空白）", "(empty)"),
    "unblock": ("解除卡住", "Unblocked"), "blocked": ("⛔ 卡住：{0}", "⛔ Blocked: {0}"),
    "head_card": ("【變更】{0}", "[Changed] {0}"), "head_proj": ("【專案】{0} › {1}", "[Project] {0} › {1}"),
    "head_proj_self": ("【專案】{0}", "[Project] {0}"), "open": ("開啟卡片", "Open card"), "yes": ("是", "yes"), "no": ("否", "no"),
    "project": ("專案", "Project"), "ops": ("一般", "Everyday"),
}


def w(key: str, L: str, *args) -> str:
    s = WORDS[key][1 if L == "en" else 0]
    for i, a in enumerate(args):
        s = s.replace("{%d}" % i, str(a))
    return s


async def _fmt(db, field: str, v, L: str) -> str:
    i = 1 if L == "en" else 0
    if v is None or v == "":
        return w("empty", L)
    if field == "status":
        return STATUS.get(v, (v, v))[i]
    if field == "priority":
        return PRIORITY.get(v, (v, v))[i]
    if field == "milestone":
        return w("yes" if str(v) in ("1", "True") else "no", L)
    if field == "kind":
        return w("project" if v == "project" else "ops", L)
    if field in ("assignee_id", "assignee"):
        cur = await db.execute("SELECT display_name, username FROM users WHERE id = ?", (v,))
        r = await cur.fetchone()
        return (r[0] or r[1]) if r else str(v)
    if field == "project_id":
        cur = await db.execute("SELECT title FROM tasks WHERE id = ?", (v,))
        r = await cur.fetchone()
        return r[0] if r else str(v)
    if field in ("start_at", "due_at"):
        s = str(v).replace("T", " ")
        return s[5:].replace("-", "/") if len(s) >= 10 else s
    s = str(v).replace("\n", " ")
    return s[:80] + ("…" if len(s) > 80 else "")


async def digest(now: Optional[float] = None) -> int:
    """Turn the changes of cards nobody has touched for a minute into one message per card and channel."""
    c = cfg()
    chans = active_channels("changes", c)
    db = await get_db()
    try:
        if not chans:
            await db.execute("DELETE FROM change_log")
            await db.commit()
            return 0
        quiet = max(10, int(c.quiet_seconds or 60))
        cur = await db.execute(f"""SELECT card_id FROM change_log GROUP BY card_id
                                   HAVING MAX(at) <= datetime('now', '-{quiet} seconds')""")
        cards = [r[0] for r in await cur.fetchall()]
        L = lang(c)
        base = site_url(c)
        sent = 0
        for card_id in cards:
            cur = await db.execute("SELECT * FROM change_log WHERE card_id = ? ORDER BY id", (card_id,))
            rows = [dict(r) for r in await cur.fetchall()]
            await db.execute("DELETE FROM change_log WHERE card_id = ? AND id <= ?", (card_id, rows[-1]["id"]))
            lines = await _lines(db, rows, L)
            if not lines:
                continue
            cur = await db.execute("SELECT title, kind, project_id FROM tasks WHERE id = ?", (card_id,))
            t = await cur.fetchone()
            title = t[0] if t else next((r["old"] for r in rows if r["field"] == "-" and r["tbl"] == "t"), "") or f"#{card_id}"
            project = (card_id if t and (t[1] or "ops") == "project" else t[2]) if t else None
            ptitle = None
            if project and project != card_id:
                cur = await db.execute("SELECT title FROM tasks WHERE id = ?", (project,))
                pr = await cur.fetchone()
                ptitle = pr[0] if pr else None
            head = w("head_proj", L, ptitle, title) if ptitle else w("head_proj_self", L, title) if project == card_id else w("head_card", L, title)
            payload = card(head, lines, f"{base}/#/card/{card_id}" if t else None, link_text=w("open", L))
            for ch in chans:
                if await _in_scope(db, ch, project):
                    await enqueue(db, ch["id"], "changes", payload)
                    sent += 1
        await db.execute("DELETE FROM change_log WHERE at < datetime('now', '-2 days')")
        await db.commit()
        return sent
    finally:
        await db.close()


async def _lines(db, rows: List[dict], L: str) -> List[str]:
    """One line per (item, field): the first old value → the last new value, by whom."""
    names: Dict[int, str] = {}

    async def who(uid):
        if uid is None:
            return w("system", L)
        if uid not in names:
            cur = await db.execute("SELECT display_name, username FROM users WHERE id = ?", (uid,))
            r = await cur.fetchone()
            names[uid] = (r[0] or r[1]) if r else str(uid)
        return names[uid]

    merged: Dict[tuple, dict] = {}
    order: List[tuple] = []
    created = {(r["tbl"], r["row_id"]) for r in rows if r["field"] == "+"}
    for r in rows:
        k = (r["tbl"], r["row_id"], r["field"]) if r["field"] not in ("+", "-") else (r["tbl"], r["row_id"], r["field"], r["id"])
        if r["field"] not in ("+", "-") and (r["tbl"], r["row_id"]) in created and r["tbl"] != "m":
            continue                                    # details of something created in the same batch
        if k in merged:
            merged[k]["new"] = r["new"]
            merged[k]["actor_id"] = r["actor_id"]
        else:
            merged[k] = dict(r)
            order.append(k)
    out = []
    sub_titles: Dict[int, str] = {}
    for k in order:
        r = merged[k]
        by = w("by", L, await who(r["actor_id"]))
        if r["tbl"] == "t" and r["field"] == "+":
            out.append(w("new_card", L, r["new"]) + by)
        elif r["tbl"] == "t" and r["field"] == "-":
            out.append(w("del_card", L, r["old"]) + by)
        elif r["tbl"] == "s" and r["field"] == "+":
            out.append(w("new_sub", L, r["new"]) + by)
        elif r["tbl"] == "s" and r["field"] == "-":
            out.append(w("del_sub", L, r["old"]) + by)
        elif r["tbl"] == "c":
            out.append(w("comment", L, (r["new"] or "")[:120]) + by)
        elif r["tbl"] == "m":
            name = await _fmt(db, "assignee", r["new"] or r["old"], L)
            out.append(w("add_owner" if r["new"] else "del_owner", L, name) + by)
        else:
            if r["old"] == r["new"]:
                continue
            label = T.get(r["field"], (r["field"], r["field"]))[1 if L == "en" else 0]
            if r["field"] in ("description", "body", "deps"):
                text = w("edited", L, label)
            elif r["field"] == "blocked_reason":
                text = w("blocked", L, await _fmt(db, "x", r["new"], L)) if r["new"] else w("unblock", L)
            else:
                text = w("changed", L, label, await _fmt(db, r["field"], r["old"], L), await _fmt(db, r["field"], r["new"], L))
            if r["tbl"] == "s":
                if r["row_id"] not in sub_titles:
                    cur = await db.execute("SELECT title FROM task_comments WHERE id = ?", (r["row_id"],))
                    x = await cur.fetchone()
                    sub_titles[r["row_id"]] = x[0] if x and x[0] else f"#{r['row_id']}"
                text = w("sub", L, sub_titles[r["row_id"]]) + " · " + text
            out.append(text + by)
    return out[:30]


# ------------------------------------------------------------------ channels (settings page)
def public(c=None) -> dict:
    c = c or cfg()
    from dataclasses import asdict
    d = asdict(c)
    d["channels"] = [{k: v for k, v in ch.items() if k != "url_enc"} | {"url_set": bool(ch.get("url_enc")),
                                                                       "url_host": _host(channel_url(ch))} for ch in c.channels]
    d["default_site_url"] = site_url(sysconfig.Teams())
    return d


def _host(url: str) -> str:
    from urllib.parse import urlsplit
    try:
        return urlsplit(url).hostname or ""
    except ValueError:
        return ""


def save_channels(channels: List[dict]):
    """[{id?, name, url? (None = keep), enabled, events, scope, projects}] → stored, URLs encrypted."""
    old = {ch["id"]: ch for ch in cfg().channels}
    out = []
    for ch in channels[:20]:
        cid = ch.get("id") if ch.get("id") in old else secrets.token_hex(4)
        url = ch.get("url")
        enc = old.get(cid, {}).get("url_enc", "") if url is None else (sysconfig.encrypt(url, "teams-url") if url else "")
        out.append({"id": cid, "name": (ch.get("name") or "").strip()[:60], "url_enc": enc, "enabled": bool(ch.get("enabled", True)),
                    "events": [e for e in ch.get("events") or [] if e in EVENTS],
                    "scope": ch.get("scope") if ch.get("scope") in ("projects", "all", "chosen") else "projects",
                    "projects": [int(x) for x in ch.get("projects") or [] if str(x).isdigit()][:100]})
    sysconfig.save_teams({"channels": out})
    refresh_capture()
