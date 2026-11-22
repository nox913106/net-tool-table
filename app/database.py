"""
SQLite Database Module for Tool Table
Handles database connection and table creation
"""
import aiosqlite
import os
from pathlib import Path

from .config import DATA_DIR

# Database path (TOOL_TABLE_DATA_DIR, default ./data)
DB_DIR = DATA_DIR
DB_PATH = DB_DIR / "tool-table.db"

def ensure_db_dir():
    """Ensure data directory exists"""
    DB_DIR.mkdir(parents=True, exist_ok=True)

async def get_db():
    """Get database connection"""
    ensure_db_dir()
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA foreign_keys = ON")
    return db

async def init_db():
    """Initialize database tables"""
    ensure_db_dir()
    async with aiosqlite.connect(DB_PATH) as db:
        # Nodes table - unified hierarchy
        await db.execute("""
            CREATE TABLE IF NOT EXISTS nodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                parent_id INTEGER,
                code TEXT UNIQUE,
                name TEXT NOT NULL,
                node_type TEXT NOT NULL CHECK(node_type IN ('folder', 'link')),
                icon TEXT,
                url TEXT,
                sort_order INTEGER DEFAULT 0,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (parent_id) REFERENCES nodes(id) ON DELETE CASCADE
            )
        """)
        
        # Auth links table
        await db.execute("""
            CREATE TABLE IF NOT EXISTS auth_links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                region TEXT NOT NULL,
                name TEXT NOT NULL,
                url TEXT NOT NULL,
                sort_order INTEGER DEFAULT 0,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        # Site settings (key/value, value stored as JSON)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        """)

        # Task board (kanban cards)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT,
                status TEXT NOT NULL DEFAULT 'new',
                priority TEXT NOT NULL DEFAULT 'normal',
                start_at TEXT,
                due_at TEXT,
                remind INTEGER,
                sort_order INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP
            )
        """)
        await db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, sort_order)")
        cursor = await db.execute("PRAGMA table_info(tasks)")
        task_cols = {row[1] for row in await cursor.fetchall()}
        for col, decl in (("repeat", "TEXT"), ("repeat_every", "INTEGER DEFAULT 1"), ("next_id", "INTEGER"),
                          ("overdue_from", "TEXT"), ("overdue_ack", "TEXT"),
                          ("owner_id", "INTEGER REFERENCES users(id) ON DELETE SET NULL"),
                          ("blocked_at", "TIMESTAMP"), ("blocked_reason", "TEXT"), ("blocked_by", "INTEGER"),
                          ("tags", "TEXT")):
            if col not in task_cols:                       # recurring cards, 卡住 flag (added later)
                await db.execute(f"ALTER TABLE tasks ADD COLUMN {col} {decl}")
        # a card that is finished or dropped is no longer stuck
        await db.execute("""CREATE TRIGGER IF NOT EXISTS tasks_unblock_closed AFTER UPDATE OF status ON tasks
                            WHEN NEW.status IN ('complete', 'canceled') AND NEW.blocked_at IS NOT NULL
                            BEGIN UPDATE tasks SET blocked_at = NULL, blocked_reason = NULL, blocked_by = NULL WHERE id = NEW.id; END""")

        # Accounts (server edition: local break-glass admin + Active Directory users)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                source TEXT NOT NULL DEFAULT 'ldap',          -- local | ldap
                display_name TEXT,
                email TEXT,
                department TEXT,
                role TEXT NOT NULL DEFAULT 'user',            -- superadmin | admin | user
                password_hash TEXT,                           -- local accounts only
                active INTEGER NOT NULL DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created REAL NOT NULL,
                last_seen REAL NOT NULL,
                ip TEXT,
                user_agent TEXT
            )
        """)
        # Card people: assignees (set by admins) and @mentioned collaborators
        await db.execute("""
            CREATE TABLE IF NOT EXISTS task_members (
                task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                role TEXT NOT NULL,                           -- assignee | mention | subtask (sees the card for a subtask)
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (task_id, user_id, role)
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS task_comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                body TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
                actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                kind TEXT NOT NULL,                           -- assigned | mention | comment
                text TEXT,
                read INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        cursor = await db.execute("PRAGMA table_info(users)")
        user_cols = {row[1] for row in await cursor.fetchall()}
        if "must_change_password" not in user_cols:
            await db.execute("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0")
        if "scope_departments" not in user_cols:          # departments a department manager manages (JSON list)
            await db.execute("ALTER TABLE users ADD COLUMN scope_departments TEXT")
        if "manager_id" not in user_cols:                 # 上級 (reporting line); from AD "manager" or set by an admin
            await db.execute("ALTER TABLE users ADD COLUMN manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL")
            await db.execute("ALTER TABLE users ADD COLUMN manager_source TEXT")   # ad | manual
        await db.execute("UPDATE users SET role = 'sysadmin' WHERE role = 'admin'")   # older two-role model
        await db.execute("CREATE INDEX IF NOT EXISTS idx_members_user ON task_members(user_id)")
        await db.execute("""
            CREATE TABLE IF NOT EXISTS task_images (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                comment_id INTEGER REFERENCES task_comments(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                stored TEXT NOT NULL,
                mime TEXT NOT NULL,
                name TEXT,
                size INTEGER,
                pending INTEGER NOT NULL DEFAULT 0,
                kind TEXT NOT NULL DEFAULT 'image',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.execute("CREATE INDEX IF NOT EXISTS idx_images_task ON task_images(task_id, comment_id)")
        cursor = await db.execute("PRAGMA table_info(task_images)")
        if "kind" not in {row[1] for row in await cursor.fetchall()}:          # images only → images + files
            await db.execute("ALTER TABLE task_images ADD COLUMN kind TEXT NOT NULL DEFAULT 'image'")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_comments_task ON task_comments(task_id)")
        # Comment threads and subtasks (a card is a summary task; a comment can become one of its subtasks)
        cursor = await db.execute("PRAGMA table_info(task_comments)")
        comment_cols = {row[1] for row in await cursor.fetchall()}
        for col, ddl in (("parent_id", "INTEGER REFERENCES task_comments(id) ON DELETE CASCADE"),
                         ("is_task", "INTEGER NOT NULL DEFAULT 0"), ("title", "TEXT"), ("status", "TEXT"),
                         ("start_at", "TEXT"), ("due_at", "TEXT"),
                         ("assignee_id", "INTEGER REFERENCES users(id) ON DELETE SET NULL"),
                         ("estimate_minutes", "INTEGER"), ("completed_at", "TIMESTAMP"), ("sort_order", "INTEGER"),
                         ("priority", "TEXT"), ("remind", "INTEGER"), ("edited_at", "TIMESTAMP"),
                         # a subtask of a subtask (card → subtask → … at most 4 levels including the card)
                         ("task_parent_id", "INTEGER REFERENCES task_comments(id) ON DELETE CASCADE")):
            if col not in comment_cols:
                await db.execute(f"ALTER TABLE task_comments ADD COLUMN {col} {ddl}")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_comments_parent ON task_comments(parent_id)")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_comments_task_parent ON task_comments(task_parent_id)")
        await db.execute("""
            CREATE TABLE IF NOT EXISTS task_time (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                comment_id INTEGER NOT NULL REFERENCES task_comments(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                minutes INTEGER,                              -- NULL while the timer runs
                note TEXT,
                work_date TEXT,                               -- YYYY-MM-DD (local day the work was done)
                started_at TIMESTAMP,                         -- timer entries
                ended_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.execute("CREATE INDEX IF NOT EXISTS idx_time_comment ON task_time(comment_id)")
        # OpenProject sync (app/openproject.py): which card goes to which project, what was pushed,
        # and a queue filled by triggers whenever anything on a linked card changes
        cursor = await db.execute("PRAGMA table_info(task_members)")
        if "done_at" not in {row[1] for row in await cursor.fetchall()}:     # a collaborator marked their part done
            await db.execute("ALTER TABLE task_members ADD COLUMN done_at TIMESTAMP")
        cursor = await db.execute("PRAGMA table_info(tasks)")
        if "op_project" not in {row[1] for row in await cursor.fetchall()}:
            await db.execute("ALTER TABLE tasks ADD COLUMN op_project TEXT")
        await db.execute("""
            CREATE TABLE IF NOT EXISTS op_links (
                kind TEXT NOT NULL,                           -- card | subtask | comment | time | attachment
                local_id INTEGER NOT NULL,
                remote_id TEXT NOT NULL,
                card_id INTEGER,
                hash TEXT,                                    -- what was last pushed (skip unchanged)
                synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (kind, local_id)
            )
        """)
        await db.execute("CREATE INDEX IF NOT EXISTS idx_op_links_card ON op_links(card_id)")
        await db.execute("""
            CREATE TABLE IF NOT EXISTS op_queue (
                card_id INTEGER PRIMARY KEY,
                queued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                attempts INTEGER NOT NULL DEFAULT 0,
                next_try TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS op_state (
                card_id INTEGER PRIMARY KEY,
                ok_at TIMESTAMP,
                error TEXT,
                error_at TIMESTAMP
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS op_users (
                username TEXT PRIMARY KEY,
                remote_id TEXT,                               -- NULL = not found in OpenProject
                checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        linked = ("(SELECT op_project FROM tasks WHERE id = {c}) IS NOT NULL "
                  "OR EXISTS (SELECT 1 FROM op_links WHERE kind = 'card' AND local_id = {c})")
        enqueue = ("INSERT INTO op_queue (card_id) VALUES ({c}) ON CONFLICT(card_id) DO UPDATE SET "
                   "queued_at = CURRENT_TIMESTAMP, attempts = 0, next_try = CURRENT_TIMESTAMP")
        for table, card in (("tasks", "id"), ("task_comments", "task_id"), ("task_time", "task_id"), ("task_images", "task_id")):
            for ev, row in (("INSERT", "NEW"), ("UPDATE", "NEW"), ("DELETE", "OLD")):
                c = f"{row}.{card}"
                await db.execute(f"DROP TRIGGER IF EXISTS op_q_{table}_{ev.lower()}")
                await db.execute(f"CREATE TRIGGER op_q_{table}_{ev.lower()} AFTER {ev} ON {table} "
                                 f"WHEN {linked.format(c=c)} BEGIN {enqueue.format(c=c)}; END")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_time_user_running ON task_time(user_id, ended_at)")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_notes_user ON notifications(user_id, read)")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)")

        # Lightweight schema migration for columns added later
        cursor = await db.execute("PRAGMA table_info(nodes)")
        node_cols = {row[1] for row in await cursor.fetchall()}
        if "description" not in node_cols:
            await db.execute("ALTER TABLE nodes ADD COLUMN description TEXT")
        if "new_tab" not in node_cols:
            await db.execute("ALTER TABLE nodes ADD COLUMN new_tab BOOLEAN DEFAULT TRUE")
        if "color" not in node_cols:
            await db.execute("ALTER TABLE nodes ADD COLUMN color TEXT")
        if "launch_args" not in node_cols:     # local programs (portable edition)
            await db.execute("ALTER TABLE nodes ADD COLUMN launch_args TEXT")
        if "launch_cwd" not in node_cols:
            await db.execute("ALTER TABLE nodes ADD COLUMN launch_cwd TEXT")
        if "owner_id" not in node_cols:       # NULL = 公用區 (public area); an account = its 個人區 (personal area)
            await db.execute("ALTER TABLE nodes ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_nodes_owner ON nodes(owner_id)")

        # Create indexes
        await db.execute("CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id)")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_nodes_code ON nodes(code)")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(node_type)")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_auth_region ON auth_links(region)")
        
        # One-time: put the new task board on home pages that were customised before it existed
        cursor = await db.execute("SELECT value FROM settings WHERE key = 'home_sections'")
        row = await cursor.fetchone()
        cursor = await db.execute("SELECT 1 FROM settings WHERE key = '_migr_board_section'")
        if row and not await cursor.fetchone():
            import json
            try:
                sections = json.loads(row[0])
                if isinstance(sections, list) and not any(isinstance(x, dict) and x.get("type") == "board" for x in sections):
                    sections.insert(0, {"type": "board"})
                    await db.execute("UPDATE settings SET value = ? WHERE key = 'home_sections'", (json.dumps(sections, ensure_ascii=False),))
            except (TypeError, ValueError):
                pass
        if row:
            await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('_migr_board_section', '1')")

        # Purge orphan nodes left behind before foreign keys were enforced
        while True:
            cursor = await db.execute(
                "DELETE FROM nodes WHERE parent_id IS NOT NULL "
                "AND parent_id NOT IN (SELECT id FROM nodes)"
            )
            if cursor.rowcount == 0:
                break

        # Sync between standalone copies and the server (app/sync.py): uids, clocks, capture triggers
        from . import sync
        await sync.install(db)

        await db.commit()
        print(f"Database initialized at {DB_PATH}")

async def close_db(db):
    """Close database connection"""
    await db.close()
