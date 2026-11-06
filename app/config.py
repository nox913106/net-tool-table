"""
Runtime configuration (environment variables)

Development: nothing to set — data lives in ./data and icons in ./resource/icon.
Production:  scripts/tool-table.sh writes /etc/tool-table/tool-table.env, e.g.
    TOOL_TABLE_DATA_DIR=/var/lib/tool-table
    TOOL_TABLE_ICON_DIR=/var/lib/tool-table/icons
    TOOL_TABLE_ENABLE_DOCS=false
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

# Interactive API docs (/docs, /redoc, /openapi.json) — disabled in production
ENABLE_DOCS = _bool("TOOL_TABLE_ENABLE_DOCS", True)

ALLOWED_ICON_EXTENSIONS = {".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif"}
MAX_ICON_BYTES = 5 * 1024 * 1024
