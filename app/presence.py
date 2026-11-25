"""
Standalone copy: stop when its window is closed.

portable/launcher.py opens the program in its own window and sets TOOL_TABLE_EXIT_WHEN_CLOSED. Every page
of the program says it is open (POST /api/local/presence every 20 s, and "bye" when it goes away). Once a
page has been seen and none is left — the window was closed — the program stops by itself, so there is
nothing else to close. A reload says bye and hello within a moment: only 5 s without any page counts.
Hidden pages (window minimised) still report about once a minute; a page silent for 150 s is gone.
"""
import asyncio
import os
import time

ENABLED = os.environ.get("TOOL_TABLE_EXIT_WHEN_CLOSED") == "1"
STALE = 150
GRACE = 5
on_empty = None                 # set by the launcher: stop the server
_pages: dict = {}
_state = {"seen": False, "empty_since": None}


def beat(page: str, bye: bool = False):
    now = time.time()
    if bye:
        _pages.pop(page, None)
    else:
        _pages[page] = now
        _state["seen"] = True


async def watch():
    if not ENABLED:
        return
    while True:
        await asyncio.sleep(1)
        now = time.time()
        for k in [k for k, t in _pages.items() if now - t > STALE]:
            _pages.pop(k, None)
        if not _state["seen"] or _pages:
            _state["empty_since"] = None
            continue
        _state["empty_since"] = _state["empty_since"] or now
        if now - _state["empty_since"] >= GRACE and on_empty:
            on_empty()
            return
