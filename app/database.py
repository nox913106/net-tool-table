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
                          ("owner_id", "INTEGER REFERENCES users(id) ON DELETE SET NULL")):
            if col not in task_cols:                       # recurring cards (added later)
                await db.execute(f"ALTER TABLE tasks ADD COLUMN {col} {decl}")

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
                role TEXT NOT NULL,                           -- assignee | mention
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.execute("CREATE INDEX IF NOT EXISTS idx_images_task ON task_images(task_id, comment_id)")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_comments_task ON task_comments(task_id)")
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

        await db.commit()
        print(f"Database initialized at {DB_PATH}")

async def close_db(db):
    """Close database connection"""
    await db.close()
