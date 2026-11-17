"""
Two-way sync between standalone copies (portable edition) and the server.

Both editions run the same schema, so the same code captures and merges changes on either side:

  uid          every synced row gets a global id (random; a card member's id is derived from
               card + account + role, so the same membership made on two sides is one row)
  sync_clock   per row and field: when it was last written (UTC, millisecond, shifted by the
               measured difference to the server clock) and by which device; `dirty` marks local
               edits not yet sent, `seq` orders changes for the server's change feed
  sync_tomb    deleted rows, so a deletion travels too
  sync_ctx     a row exists only while remote changes are being applied: the capture triggers
               skip those writes (the merge records the remote clocks itself)

Triggers capture every write — routes, background jobs, the Excel import — without touching them.

Merging is last-writer-wins per field: of two edits to the same field, the later timestamp
stays (ties: the device id decides, so both sides agree). Edits to different fields never
conflict. A deletion wins over edits made before it; an edit made after a deletion brings the
row back. When both sides changed the same field since the last sync, the later edit applies
and both versions are kept in sync_log (kind 'conflict') until someone picks one (base_ts in
sync_clock remembers the version last seen from the other side, which tells a real conflict
from a field the other side never touched).
"""
import asyncio
import json
import secrets
from typing import Awaitable, Callable, Dict, List, Optional

NOW = "strftime('%Y-%m-%dT%H:%M:%f', 'now', (SELECT v FROM sync_state WHERE k = 'offset'))"
DEV = "(SELECT v FROM sync_state WHERE k = 'device')"
SEQ = "(SELECT CAST(v AS INTEGER) FROM sync_state WHERE k = 'seq')"
BUMP = "UPDATE sync_state SET v = CAST(v AS INTEGER) + 1 WHERE k = 'seq'"
SKIP = "NOT EXISTS (SELECT 1 FROM sync_ctx)"

# table → synced fields, references to other synced rows, references to accounts
TABLES: Dict[str, dict] = {
    "tasks": {
        "fields": ("title", "description", "status", "priority", "start_at", "due_at", "remind", "repeat", "repeat_every",
                   "next_id", "overdue_from", "overdue_ack", "owner_id", "sort_order", "created_at", "updated_at",
                   "completed_at", "blocked_at", "blocked_reason", "blocked_by"),
        "refs": {"next_id": "tasks"}, "people": ("owner_id", "blocked_by"), "card": "id",
    },
    "task_comments": {
        "fields": ("task_id", "parent_id", "user_id", "body", "created_at", "is_task", "title", "status", "start_at",
                   "due_at", "assignee_id", "estimate_minutes", "completed_at", "sort_order", "priority", "remind",
                   "edited_at"),
        "refs": {"task_id": "tasks", "parent_id": "task_comments"}, "people": ("user_id", "assignee_id"),
        "card": "task_id", "required": ("task_id",),
    },
    "task_members": {
        "fields": ("task_id", "user_id", "role", "created_at", "done_at"),
        "refs": {"task_id": "tasks"}, "people": ("user_id",), "card": "task_id", "required": ("task_id", "user_id"),
    },
    "task_time": {
        "fields": ("task_id", "comment_id", "user_id", "minutes", "note", "work_date", "started_at", "ended_at", "created_at"),
        "refs": {"task_id": "tasks", "comment_id": "task_comments"}, "people": ("user_id",), "card": "task_id",
        "required": ("task_id", "comment_id"),
    },
    "task_images": {
        "fields": ("task_id", "comment_id", "user_id", "mime", "name", "size", "pending", "kind", "created_at"),
        "refs": {"task_id": "tasks", "comment_id": "task_comments"}, "people": ("user_id",), "card": "task_id",
        "required": ("task_id",),
    },
    # portal links: the public area flows server → copies; each account's personal area both ways
    # (local programs — file: links — and their launch settings stay on their own computer)
    "nodes": {
        "fields": ("parent_id", "name", "node_type", "icon", "url", "description", "color", "new_tab", "sort_order",
                   "is_active", "owner_id", "created_at", "updated_at"),
        "refs": {"parent_id": "nodes"}, "people": ("owner_id",), "card": None,
    },
}
ORDER = tuple(TABLES)
BOARD = ("tasks", "task_comments", "task_members", "task_time", "task_images")
MEMBER_UID = ("(SELECT t.uid FROM tasks t WHERE t.id = {r}.task_id) || '|' || "
              "(SELECT u.username FROM users u WHERE u.id = {r}.user_id) || '|' || {r}.role")

# ------------------------------------------------------------------ live change signal
_event: Optional[asyncio.Event] = None


def poke():
    """Something changed: wake long-polling viewers (GET /api/sync/wait)."""
    global _event
    if _event is not None:
        _event.set()
        _event = None


async def changed(timeout: float):
    global _event
    if _event is None:
        _event = asyncio.Event()
    try:
        await asyncio.wait_for(_event.wait(), timeout)
    except asyncio.TimeoutError:
        pass


# ------------------------------------------------------------------ schema
async def _cols(db, table: str) -> set:
    cur = await db.execute(f"PRAGMA table_info({table})")
    return {r[1] for r in await cur.fetchall()}


async def install(db):
    """Create sync tables, give every row a uid and (re)create the capture triggers."""
    await db.execute("""CREATE TABLE IF NOT EXISTS sync_state (k TEXT PRIMARY KEY, v TEXT)""")
    await db.execute("""CREATE TABLE IF NOT EXISTS sync_ctx (k INTEGER)""")
    await db.execute("""CREATE TABLE IF NOT EXISTS sync_clock (
                            tbl TEXT NOT NULL, uid TEXT NOT NULL, field TEXT NOT NULL,
                            ts TEXT NOT NULL, dev TEXT NOT NULL DEFAULT '', seq INTEGER NOT NULL DEFAULT 0,
                            dirty INTEGER NOT NULL DEFAULT 0, base_ts TEXT NOT NULL DEFAULT '', base_dev TEXT NOT NULL DEFAULT '',
                            PRIMARY KEY (tbl, uid, field))""")
    await db.execute("CREATE INDEX IF NOT EXISTS idx_sync_clock_seq ON sync_clock(seq)")
    await db.execute("CREATE INDEX IF NOT EXISTS idx_sync_clock_dirty ON sync_clock(dirty) WHERE dirty = 1")
    await db.execute("""CREATE TABLE IF NOT EXISTS sync_tomb (
                            tbl TEXT NOT NULL, uid TEXT NOT NULL, ts TEXT NOT NULL, dev TEXT NOT NULL DEFAULT '',
                            seq INTEGER NOT NULL DEFAULT 0, dirty INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tbl, uid))""")
    await db.execute("CREATE INDEX IF NOT EXISTS idx_sync_tomb_seq ON sync_tomb(seq)")
    # server: long-lived tokens of linked standalone copies; files uploaded ahead of their rows
    await db.execute("""CREATE TABLE IF NOT EXISTS sync_devices (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                            token_hash TEXT NOT NULL UNIQUE, name TEXT, device TEXT,
                            created TIMESTAMP DEFAULT CURRENT_TIMESTAMP, last_seen TIMESTAMP, ip TEXT)""")
    await db.execute("""CREATE TABLE IF NOT EXISTS sync_blobs (
                            uid TEXT PRIMARY KEY, stored TEXT NOT NULL, mime TEXT, kind TEXT, size INTEGER,
                            created TIMESTAMP DEFAULT CURRENT_TIMESTAMP)""")
    # standalone copy: what happened (overwritten edits, refused changes)
    await db.execute("""CREATE TABLE IF NOT EXISTS sync_log (
                            id INTEGER PRIMARY KEY AUTOINCREMENT, at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            kind TEXT NOT NULL, tbl TEXT, uid TEXT, card TEXT, field TEXT, mine TEXT, theirs TEXT, note TEXT,
                            winner TEXT, status TEXT, resolved_at TIMESTAMP)""")
    await db.execute("CREATE TABLE IF NOT EXISTS sync_sent_blobs (uid TEXT PRIMARY KEY)")
    await db.execute("INSERT OR IGNORE INTO sync_state (k, v) VALUES ('device', ?)", (secrets.token_hex(6),))
    await db.execute("INSERT OR IGNORE INTO sync_state (k, v) VALUES ('offset', '+0.000 seconds')")
    await db.execute("INSERT OR IGNORE INTO sync_state (k, v) VALUES ('seq', '0')")

    for table in ORDER:
        if "uid" not in await _cols(db, table):
            await db.execute(f"ALTER TABLE {table} ADD COLUMN uid TEXT")
    for table in ORDER:
        if table == "task_members":
            await db.execute(f"UPDATE task_members SET uid = {MEMBER_UID.format(r='task_members')} "
                             "WHERE uid IS NULL AND role != 'subtask'")
        else:
            await db.execute(f"UPDATE {table} SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL")
        await db.execute(f"CREATE UNIQUE INDEX IF NOT EXISTS ux_{table}_uid ON {table}(uid)")
    for table, spec in TABLES.items():
        for sql in _trigger_sql(table, spec):
            await db.execute(sql)


def _trigger_sql(table: str, spec: dict) -> List[str]:
    fields = spec["fields"]
    upsert = ("ON CONFLICT(tbl, uid, field) DO UPDATE SET ts = excluded.ts, dev = excluded.dev, "
              "seq = excluded.seq, dirty = 1")
    if table == "task_members":
        set_uid = f"UPDATE task_members SET uid = {MEMBER_UID.format(r='NEW')} WHERE rowid = NEW.rowid AND uid IS NULL AND NEW.role != 'subtask';"
    else:
        set_uid = f"UPDATE {table} SET uid = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid AND uid IS NULL;"
    all_fields = " UNION ALL ".join(f"SELECT '{f}' AS f" for f in fields)
    changed_fields = " UNION ALL ".join(f"SELECT '{f}' AS f WHERE NEW.{f} IS NOT OLD.{f}" for f in fields)
    row_uid = f"(SELECT uid FROM {table} WHERE rowid = NEW.rowid)"
    out = [f"DROP TRIGGER IF EXISTS sy_{table}_{ev}" for ev in ("i", "u", "d")]
    out.append(f"""CREATE TRIGGER sy_{table}_i AFTER INSERT ON {table} WHEN {SKIP} BEGIN
        {set_uid}
        {BUMP};
        INSERT INTO sync_clock (tbl, uid, field, ts, dev, seq, dirty)
            SELECT '{table}', {row_uid}, x.f, {NOW}, {DEV}, {SEQ}, 1 FROM ({all_fields}) x WHERE {row_uid} IS NOT NULL
            {upsert};
    END""")
    out.append(f"""CREATE TRIGGER sy_{table}_u AFTER UPDATE ON {table}
        WHEN {SKIP} AND NEW.uid IS NOT NULL AND OLD.uid IS NOT NULL BEGIN
        {BUMP};
        INSERT INTO sync_clock (tbl, uid, field, ts, dev, seq, dirty)
            SELECT '{table}', NEW.uid, x.f, {NOW}, {DEV}, {SEQ}, 1 FROM ({changed_fields}) x WHERE true
            {upsert};
    END""")
    out.append(f"""CREATE TRIGGER sy_{table}_d AFTER DELETE ON {table} WHEN {SKIP} AND OLD.uid IS NOT NULL BEGIN
        {BUMP};
        INSERT INTO sync_tomb (tbl, uid, ts, dev, seq, dirty) VALUES ('{table}', OLD.uid, {NOW}, {DEV}, {SEQ}, 1)
            ON CONFLICT(tbl, uid) DO UPDATE SET ts = excluded.ts, dev = excluded.dev, seq = excluded.seq, dirty = 1;
        DELETE FROM sync_clock WHERE tbl = '{table}' AND uid = OLD.uid;
    END""")
    return out


async def state(db, key: str, default=None):
    cur = await db.execute("SELECT v FROM sync_state WHERE k = ?", (key,))
    row = await cur.fetchone()
    return row[0] if row else default


async def set_state(db, key: str, value):
    if value is None:
        await db.execute("DELETE FROM sync_state WHERE k = ?", (key,))
    else:
        await db.execute("INSERT INTO sync_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                         (key, str(value)))


async def current_seq(db) -> int:
    return int(await state(db, "seq", "0") or 0)


async def next_seq(db) -> int:
    await db.execute(BUMP)
    return await current_seq(db)


# ------------------------------------------------------------------ id ↔ uid ↔ account
class Ids:
    """Translates local integer ids to global uids / usernames and back (cached per batch)."""

    def __init__(self, db, server: bool, people: Optional[dict] = None):
        self.db, self.server, self.people = db, server, people or {}
        self._uid: Dict[tuple, Optional[str]] = {}
        self._id: Dict[tuple, Optional[int]] = {}
        self._uname: Dict[int, Optional[str]] = {}
        self._uidn: Dict[str, Optional[int]] = {}

    async def uid_of(self, table: str, rowid) -> Optional[str]:
        if rowid is None:
            return None
        key = (table, rowid)
        if key not in self._uid:
            cur = await self.db.execute(f"SELECT uid FROM {table} WHERE rowid = ?", (rowid,))
            r = await cur.fetchone()
            self._uid[key] = r[0] if r else None
        return self._uid[key]

    async def id_of(self, table: str, uid) -> Optional[int]:
        if not uid:
            return None
        key = (table, uid)
        if self._id.get(key) is None:
            cur = await self.db.execute(f"SELECT rowid FROM {table} WHERE uid = ?", (uid,))
            r = await cur.fetchone()
            self._id[key] = r[0] if r else None
        return self._id[key]

    def remember(self, table: str, uid: str, rowid: int):
        self._id[(table, uid)] = rowid
        self._uid[(table, rowid)] = uid

    async def username(self, user_id) -> Optional[str]:
        if user_id is None:
            return None
        if user_id not in self._uname:
            cur = await self.db.execute("SELECT username FROM users WHERE id = ?", (user_id,))
            r = await cur.fetchone()
            self._uname[user_id] = r[0] if r else None
        return self._uname[user_id]

    async def user_id(self, username) -> Optional[int]:
        if not username:
            return None
        if username not in self._uidn:
            cur = await self.db.execute("SELECT id FROM users WHERE username = ?", (username,))
            r = await cur.fetchone()
            if r:
                self._uidn[username] = r[0]
            elif self.server:
                self._uidn[username] = None              # the server only knows real accounts
            else:                                         # standalone copy: mirror the account
                p = self.people.get(username) or {}
                cur = await self.db.execute(
                    "INSERT INTO users (username, source, display_name, email, department, role, active) "
                    "VALUES (?, 'ldap', ?, ?, ?, 'user', 1)",
                    (username, p.get("display_name"), p.get("email"), p.get("department")))
                self._uidn[username] = cur.lastrowid
        return self._uidn[username]


# ------------------------------------------------------------------ export
def _ts_key(c) -> tuple:
    return (c[0] or "", c[1] or "") if c else ("", "")


async def clocks(db, table: str, uids: List[str]) -> Dict[str, dict]:
    out: Dict[str, dict] = {}
    for i in range(0, len(uids), 400):
        part = uids[i:i + 400]
        cur = await db.execute(f"SELECT uid, field, ts, dev, dirty, base_ts, base_dev FROM sync_clock "
                               f"WHERE tbl = ? AND uid IN ({','.join('?' * len(part))})", (table, *part))
        for r in await cur.fetchall():
            out.setdefault(r[0], {})[r[1]] = (r[2], r[3], r[4], r[5], r[6])
    return out


async def export_rows(db, table: str, where: str = "1 = 1", args=(), ids: Optional[Ids] = None) -> List[dict]:
    """Rows of a table in wire form: {t, uid, v: {field: value}, c: {field: [ts, dev]}}."""
    spec = TABLES[table]
    ids = ids or Ids(db, server=True)
    extra = " AND pending = 0" if table == "task_images" else ""
    extra += " AND role != 'subtask'" if table == "task_members" else ""
    extra += " AND (url IS NULL OR lower(url) NOT LIKE 'file:%')" if table == "nodes" else ""
    cur = await db.execute(f"SELECT rowid AS _rid, * FROM {table} x WHERE uid IS NOT NULL AND {where}{extra}", tuple(args))
    rows = await cur.fetchall()
    clk = await clocks(db, table, [r["uid"] for r in rows])
    out = []
    for r in rows:
        ids.remember(table, r["uid"], r["_rid"])
        v = {}
        for f in spec["fields"]:
            val = r[f]
            if f in spec["refs"]:
                val = await ids.uid_of(spec["refs"][f], val)
            elif f in spec["people"]:
                val = await ids.username(val)
            v[f] = val
        c = {f: [x[0], x[1]] for f, x in clk.get(r["uid"], {}).items()}
        out.append({"t": table, "uid": r["uid"], "v": v, "c": c})
    return out


async def export_by_uid(db, table: str, uids: List[str], ids: Optional[Ids] = None) -> List[dict]:
    out = []
    for i in range(0, len(uids), 400):
        part = list(uids[i:i + 400])
        out += await export_rows(db, table, f"uid IN ({','.join('?' * len(part))})", part, ids)
    return out


async def export_cards(db, card_ids: List[int], ids: Optional[Ids] = None) -> List[dict]:
    """Every synced row of these cards (the card, comments/subtasks, members, time, attachments)."""
    ids = ids or Ids(db, server=True)
    out = []
    for i in range(0, len(card_ids), 400):
        part = list(card_ids[i:i + 400])
        marks = ",".join("?" * len(part))
        for table in BOARD:
            col = TABLES[table]["card"]
            out += await export_rows(db, table, f"x.{col} IN ({marks})", part, ids)
    return out


async def people_of(db, rows: List[dict]) -> dict:
    """Account details for the usernames referenced by rows (so the other side can show names)."""
    names = set()
    for r in rows:
        for f in TABLES[r["t"]]["people"]:
            if r["v"].get(f):
                names.add(r["v"][f])
    out = {}
    names = list(names)
    for i in range(0, len(names), 400):
        part = names[i:i + 400]
        cur = await db.execute(f"SELECT username, display_name, email, department FROM users WHERE username IN ({','.join('?' * len(part))})", part)
        for r in await cur.fetchall():
            out[r[0]] = {"display_name": r[1], "email": r[2], "department": r[3]}
    return out


# ------------------------------------------------------------------ merge
Guard = Callable[[str, str, Optional[dict], dict, str], Awaitable[Optional[str]]]


class Report:
    def __init__(self):
        self.applied = 0
        self.cards: set = set()                  # local card ids touched
        self.rejected: List[tuple] = []          # (table, uid, reason)
        self.stale: set = set()                  # (table, uid): we hold a newer value than the sender
        self.deferred: set = set()               # (table, uid): try again later (attachment not uploaded yet)
        self.dropped: set = set()                # (table, uid): sender's row was deleted here later
        self.kept: set = set()                   # (table, uid): deletion refused, our edits are newer
        self.inserted: List[tuple] = []          # (table, uid, local id)
        self.need_blobs: List[str] = []          # attachment uids whose file must be fetched
        self.files_removed: List[str] = []
        self.reasons: Dict[str, str] = {}        # uid → why the server refused it (forced rows)
        self.nodes = False                       # portal links changed


async def _log(db, kind, table, uid, field=None, mine=None, theirs=None, note=None, card=None, winner=None):
    """kind: conflict (both sides changed one field: kept for a manual choice) | deleted | refused.
    mine / theirs of a conflict are JSON of the local column values, so either can be put back exactly."""
    def s(v):
        return json.dumps(v, ensure_ascii=False)[:20000]
    if kind == "conflict":                  # one open conflict per field: a newer one replaces it
        await db.execute("DELETE FROM sync_log WHERE kind = 'conflict' AND status = 'open' AND tbl = ? AND uid = ? AND field = ?",
                         (table, uid, field))
    await db.execute("INSERT INTO sync_log (kind, tbl, uid, card, field, mine, theirs, note, winner, status) "
                     "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                     (kind, table, uid, card, field, s(mine), s(theirs), note, winner, "open" if kind == "conflict" else None))
    await db.execute("DELETE FROM sync_log WHERE id < (SELECT MAX(id) - 2000 FROM sync_log)")


async def _write_clocks(db, table: str, uid: str, items: List[tuple], seq: int):
    for f, ts, dev in items:
        await db.execute("""INSERT INTO sync_clock (tbl, uid, field, ts, dev, seq, dirty, base_ts, base_dev)
                            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
                            ON CONFLICT(tbl, uid, field) DO UPDATE SET ts = excluded.ts, dev = excluded.dev,
                            seq = excluded.seq, dirty = 0, base_ts = excluded.ts, base_dev = excluded.dev""",
                         (table, uid, f, ts or "", dev or "", seq, ts or "", dev or ""))


async def _card_title(db, table: str, rowid) -> Optional[str]:
    if table == "nodes":
        cur = await db.execute("SELECT name FROM nodes WHERE id = ?", (rowid,))
    elif table == "tasks":
        cur = await db.execute("SELECT title FROM tasks WHERE id = ?", (rowid,))
    else:
        cur = await db.execute(f"SELECT t.title FROM {table} x JOIN tasks t ON t.id = x.{TABLES[table]['card']} WHERE x.rowid = ?", (rowid,))
    r = await cur.fetchone()
    return r[0] if r else None


async def merge(db, payload: dict, *, server: bool, guard: Optional[Guard] = None, force: frozenset = frozenset(),
                log: bool = False, blob_for: Optional[Callable[[str], Awaitable[Optional[tuple]]]] = None,
                reasons: Optional[Dict[str, str]] = None) -> Report:
    """Apply rows and deletions from the other side. The caller commits.

    server  True on the server: unknown accounts become NULL, attachments need an uploaded file
    guard   (table, uid, local row or None, changed fields, 'insert'|'update'|'delete') → reason to refuse
    force   uids whose values are taken as they are (the server's verdict after a refusal)
    log     standalone copy: keep both versions of a field changed on both sides (sync_log)"""
    rep = Report()
    rep.reasons = dict(reasons or {})
    ids = Ids(db, server=server, people=payload.get("users") or {})
    pending_refs: List[tuple] = []
    await db.execute("INSERT INTO sync_ctx (k) VALUES (1)")
    try:
        by_table: Dict[str, List[dict]] = {}
        for r in payload.get("rows") or []:
            if isinstance(r, dict) and r.get("t") in TABLES and isinstance(r.get("uid"), str) and isinstance(r.get("v"), dict):
                by_table.setdefault(r["t"], []).append(r)
        for table in ORDER:
            for r in by_table.get(table, []):
                await _merge_row(db, table, r, ids, rep, pending_refs, server, guard, r["uid"] in force, log, blob_for)
        for table, rowid, field, ref_table, ref_uid in pending_refs:     # rows that arrived after the row pointing at them
            target = await ids.id_of(ref_table, ref_uid)
            if target is not None:
                await db.execute(f"UPDATE {table} SET {field} = ? WHERE rowid = ?", (target, rowid))
        for tomb in payload.get("tombs") or []:
            if isinstance(tomb, dict) and tomb.get("t") in TABLES and isinstance(tomb.get("uid"), str):
                await _merge_tomb(db, tomb, ids, rep, server, guard, tomb["uid"] in force, log)
        if rep.files_removed or any(t.get("t") in ("tasks", "task_comments", "nodes") for t in payload.get("tombs") or []):
            for table in ORDER:                         # clocks of rows removed by a cascade
                await db.execute(f"DELETE FROM sync_clock WHERE tbl = ? AND uid NOT IN (SELECT uid FROM {table} WHERE uid IS NOT NULL)", (table,))
    finally:
        await db.execute("DELETE FROM sync_ctx")
    return rep


async def _merge_row(db, table, r, ids: Ids, rep: Report, pending_refs, server, guard, force, log, blob_for):
    spec = TABLES[table]
    uid, vals, rc = r["uid"], r["v"], r.get("c") or {}
    rc = {f: (c[0] or "", c[1] or "") for f, c in rc.items() if f in spec["fields"] and isinstance(c, (list, tuple)) and len(c) == 2}
    cur = await db.execute(f"SELECT rowid AS _rid, * FROM {table} WHERE uid = ?", (uid,))
    local = await cur.fetchone()

    async def to_local(f, v):
        if f in spec["refs"]:
            if v is None:
                return None, None
            target = await ids.id_of(spec["refs"][f], v)
            return target, (None if target is not None else v)
        if f in spec["people"]:
            return await ids.user_id(v), None
        return v, None

    if local is None:
        cur = await db.execute("SELECT ts, dev FROM sync_tomb WHERE tbl = ? AND uid = ?", (table, uid))
        tomb = await cur.fetchone()
        newest = max(rc.values(), default=("", ""))
        if tomb and not force and newest <= (tomb[0], tomb[1]):
            rep.dropped.add((table, uid))                 # deleted here after the sender's last edit
            return
        values, later = {}, []
        for f in spec["fields"]:
            if f not in vals:
                continue
            v, missing = await to_local(f, vals[f])
            values[f] = v
            if missing:
                later.append((f, spec["refs"][f], missing))
        if any(values.get(f) is None for f in spec.get("required", ())):
            if not server:
                return                                    # e.g. a comment of a card we do not have
            rep.rejected.append((table, uid, "找不到所屬的卡片或人員"))
            return
        if table == "task_members" and values.get("role") == "subtask":
            return
        if guard:
            why = await guard(table, uid, None, values, "insert")
            if why:
                rep.rejected.append((table, uid, why))
                return
        cols = dict(values)
        if table == "task_images":
            got = await blob_for(uid) if blob_for else None
            if got:
                cols["stored"], cols["mime"], cols["kind"] = got[0], got[1] or cols.get("mime"), got[2] or cols.get("kind")
                if server:
                    cols["size"] = got[3] if len(got) > 3 and got[3] is not None else cols.get("size")
            elif server:
                rep.deferred.add((table, uid))
                return
            else:
                cols["stored"] = ""
                rep.need_blobs.append(uid)
            cols["pending"] = 0
        if table == "task_members":
            await db.execute("DELETE FROM task_members WHERE task_id = ? AND user_id = ? AND role = ?",
                             (cols.get("task_id"), cols.get("user_id"), cols.get("role")))
        if table == "nodes":
            cols["code"] = "s-" + uid[:16]                 # codes are local (they encode the local tree)
        names = ["uid", *cols]
        cur = await db.execute(f"INSERT INTO {table} ({', '.join(names)}) VALUES ({', '.join('?' * len(names))})",
                               (uid, *cols.values()))
        rowid = cur.lastrowid
        ids.remember(table, uid, rowid)
        for f, ref_table, ref_uid in later:
            pending_refs.append((table, rowid, f, ref_table, ref_uid))
        if tomb:
            await db.execute("DELETE FROM sync_tomb WHERE tbl = ? AND uid = ?", (table, uid))
        await _write_clocks(db, table, uid, [(f, *c) for f, c in rc.items()], await next_seq(db))
        rep.applied += 1
        rep.inserted.append((table, uid, rowid))
        if force and log and table == "tasks" and uid in rep.reasons:
            await _log(db, "refused", table, uid, note=rep.reasons[uid] + "：已還原這張卡片", card=cols.get("title"))
        if table == "tasks" or spec["card"]:
            rep.cards.add(rowid if table == "tasks" else cols.get(spec["card"]))
        if table == "nodes":
            rep.nodes = True
        return

    mine = (await clocks(db, table, [uid])).get(uid, {})
    changes, take, conflicts, saw = {}, [], [], []
    for f in spec["fields"]:
        if f not in vals:
            continue
        theirs = rc.get(f, ("", ""))
        here = mine.get(f, ("", "", 0, "", ""))
        if theirs == (here[0], here[1]):
            continue
        v, missing = await to_local(f, vals[f])
        if missing:
            pending_refs.append((table, local["_rid"], f, spec["refs"][f], missing))
            v = local[f]
        differs = v != local[f]
        # both sides changed this field since the last sync: the later edit applies, both are kept
        both = (log and not force and here[2] and theirs != (here[3], here[4]) and differs
                and f not in QUIET_FIELDS)
        if not force and theirs < (here[0], here[1]):
            if differs:
                rep.stale.add((table, uid))               # we hold the newer value: tell the sender
            if both:
                conflicts.append((f, local[f], v, "mine"))
            saw.append((f, *theirs))
            continue
        if differs:
            changes[f] = v
            if both:
                conflicts.append((f, local[f], v, "theirs"))
            elif force and log and here[2] and f not in QUIET_FIELDS:
                await _log(db, "refused", table, uid, f, local[f], v, rep_reason(rep, table, uid))
        take.append((f, *theirs))
    if changes and guard and not force:
        why = await guard(table, uid, dict(local), changes, "update")
        if why:
            rep.rejected.append((table, uid, why))
            return
    if changes:
        await db.execute(f"UPDATE {table} SET {', '.join(f + ' = ?' for f in changes)} WHERE rowid = ?",
                         (*changes.values(), local["_rid"]))
        rep.applied += 1
        if table == "tasks" or spec["card"]:
            rep.cards.add(local["_rid"] if table == "tasks" else (changes.get(spec["card"]) or local[spec["card"]]))
        if table == "nodes":
            rep.nodes = True
    if take:
        await _write_clocks(db, table, uid, take, await next_seq(db))
    for f, ts, dev in saw:                                # seen their version: do not flag it again
        await db.execute("UPDATE sync_clock SET base_ts = ?, base_dev = ? WHERE tbl = ? AND uid = ? AND field = ?",
                         (ts, dev, table, uid, f))
    if conflicts:
        title = await _card_title(db, table, local["_rid"])
        for f, mine_v, theirs_v, winner in conflicts:
            await _log(db, "conflict", table, uid, f, mine_v, theirs_v,
                       "兩邊都改了這個欄位，目前套用時間較晚的修改", title, winner)


QUIET_FIELDS = ("updated_at", "edited_at", "sort_order", "completed_at", "overdue_from", "overdue_ack")


def rep_reason(rep: "Report", table: str, uid: str) -> str:
    return rep.reasons.get(uid) or "伺服器拒絕了這項修改（權限不足）"


async def _merge_tomb(db, tomb, ids: Ids, rep: Report, server, guard, force, log):
    table, uid = tomb["t"], tomb["uid"]
    ts = (tomb.get("ts") or "", tomb.get("dev") or "")
    cur = await db.execute(f"SELECT rowid AS _rid, * FROM {table} WHERE uid = ?", (uid,))
    local = await cur.fetchone()
    if local is not None:
        mine = (await clocks(db, table, [uid])).get(uid, {})
        newest = max(((x[0], x[1]) for x in mine.values()), default=("", ""))
        if not force and newest > ts:
            rep.kept.add((table, uid))                     # edited after it was deleted: the row stays
            if not server and table == "tasks":            # send the whole card back up so it reappears there
                for t in BOARD:
                    col = TABLES[t]["card"]
                    await db.execute(f"UPDATE sync_clock SET dirty = 1 WHERE tbl = ? AND uid IN (SELECT uid FROM {t} WHERE {col} = ?)",
                                     (t, local["_rid"]))
            return
        if guard and not force:
            why = await guard(table, uid, dict(local), {}, "delete")
            if why:
                rep.rejected.append((table, uid, why))
                return
        if log:
            title = await _card_title(db, table, local["_rid"])
            if force:
                await _log(db, "refused", table, uid, note=rep.reasons.get(uid) or "伺服器不接受這筆資料，已從本機移除", card=title)
            elif table == "tasks" or any(x[2] for x in mine.values()):
                await _log(db, "deleted", table, uid, note="另一端刪除了這筆資料", card=title)
        files = []
        if table in ("tasks", "task_comments", "task_images"):
            col = {"tasks": "task_id", "task_comments": "comment_id", "task_images": "rowid"}[table]
            cur = await db.execute(f"SELECT stored FROM task_images WHERE {col} = ?", (local["_rid"],))
            files = [x[0] for x in await cur.fetchall() if x[0]]
        if table == "tasks" or TABLES[table]["card"]:
            rep.cards.add(local["_rid"] if table == "tasks" else local[TABLES[table]["card"]])
        if table == "nodes":
            rep.nodes = True
        await db.execute(f"DELETE FROM {table} WHERE rowid = ?", (local["_rid"],))
        await db.execute("DELETE FROM sync_clock WHERE tbl = ? AND uid = ?", (table, uid))
        rep.files_removed += files
        rep.applied += 1
    await db.execute("""INSERT INTO sync_tomb (tbl, uid, ts, dev, seq, dirty) VALUES (?, ?, ?, ?, ?, 0)
                        ON CONFLICT(tbl, uid) DO UPDATE SET ts = excluded.ts, dev = excluded.dev, seq = excluded.seq, dirty = 0""",
                     (table, uid, ts[0], ts[1], await next_seq(db)))


# ------------------------------------------------------------------ standalone copy helpers
async def dirty_payload(db) -> dict:
    """Everything edited here that the server has not acknowledged yet."""
    cur = await db.execute("SELECT DISTINCT tbl, uid FROM sync_clock WHERE dirty = 1")
    want: Dict[str, List[str]] = {}
    for t, u in await cur.fetchall():
        if t in TABLES:
            want.setdefault(t, []).append(u)
    ids = Ids(db, server=False)
    rows = []
    for table in ORDER:
        if want.get(table):
            rows += await export_by_uid(db, table, want[table], ids)
    cur = await db.execute("SELECT tbl, uid, ts, dev FROM sync_tomb WHERE dirty = 1")
    tombs = [{"t": r[0], "uid": r[1], "ts": r[2], "dev": r[3]} for r in await cur.fetchall()]
    return {"rows": rows, "tombs": tombs, "users": await people_of(db, rows)}


async def clear_sent(db, payload: dict, keep: set):
    """The server has these edits: unmark them (unless edited again meanwhile, or the server wants them again)."""
    for r in payload.get("rows") or []:
        if (r["t"], r["uid"]) in keep:
            continue
        for f, c in (r.get("c") or {}).items():
            await db.execute("UPDATE sync_clock SET dirty = 0, base_ts = ts, base_dev = dev "
                             "WHERE tbl = ? AND uid = ? AND field = ? AND ts = ? AND dev = ?", (r["t"], r["uid"], f, c[0], c[1]))
    for t in payload.get("tombs") or []:
        if (t["t"], t["uid"]) in keep:
            continue
        await db.execute("UPDATE sync_tomb SET dirty = 0 WHERE tbl = ? AND uid = ? AND ts = ?", (t["t"], t["uid"], t["ts"]))


async def pending_count(db) -> int:
    cur = await db.execute("SELECT (SELECT COUNT(*) FROM (SELECT DISTINCT tbl, uid FROM sync_clock WHERE dirty = 1)) "
                           "+ (SELECT COUNT(*) FROM sync_tomb WHERE dirty = 1)")
    return (await cur.fetchone())[0]


async def seed_dirty(db):
    """Mark everything here as not yet sent (first link): rows made before sync existed get clocks
    from their own timestamps, so older local data never overwrites newer server edits."""
    for table, spec in TABLES.items():
        stamp = ("COALESCE(updated_at, created_at)" if table in ("tasks", "nodes")
                 else "COALESCE(edited_at, created_at)" if table == "task_comments" else "created_at")
        ts = f"replace(COALESCE({stamp}, '2000-01-01 00:00:00'), ' ', 'T') || '.000'"
        for f in spec["fields"]:
            await db.execute(f"""INSERT OR IGNORE INTO sync_clock (tbl, uid, field, ts, dev, seq, dirty)
                                 SELECT '{table}', uid, '{f}', substr({ts}, 1, 23), {DEV}, 0, 1 FROM {table}
                                 WHERE uid IS NOT NULL""")
        await db.execute("UPDATE sync_clock SET dirty = 1 WHERE tbl = ?", (table,))
