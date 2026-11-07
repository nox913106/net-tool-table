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
