#!/usr/bin/env python3
"""Translations of the web interface.

The interface is written in Traditional Chinese; every text shown to people goes through
_t('中文', ...) in frontend/assets/js. frontend/assets/i18n/en.json maps the Chinese text to
English ({0} {1} … are the values filled in).

    python3 scripts/i18n.py check   # texts used in the code that have no English yet (exit 1 if any)
    python3 scripts/i18n.py build   # en.json → en.js (the file the pages load)
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JS = ROOT / "frontend" / "assets" / "js"
EN_JSON = ROOT / "frontend" / "assets" / "i18n" / "en.json"
EN_JS = ROOT / "frontend" / "assets" / "i18n" / "en.js"
CALL = re.compile(r"""_t\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")""")


def used():
    keys = {}
    for f in sorted(JS.glob("*.js")):
        if f.name == "i18n.js":
            continue
        for m in CALL.finditer(f.read_text(encoding="utf-8")):
            lit = m.group(1)
            if lit.startswith("'"):
                lit = '"' + lit[1:-1].replace('\\\'', "'").replace('"', '\\"') + '"'
            keys.setdefault(json.loads(lit), f.name)
    return keys


def build():
    d = json.loads(EN_JSON.read_text(encoding="utf-8"))
    EN_JS.write_text("/* English dictionary: Traditional Chinese source text → English. Generated from en.json (scripts/i18n.py build). */\n"
                     "window.TT_I18N_EN = " + json.dumps(d, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    print(f"en.js: {len(d)} entries")


def check():
    d = json.loads(EN_JSON.read_text(encoding="utf-8"))
    miss = {k: f for k, f in used().items() if k not in d}
    bad = [k for k, v in d.items() if sorted(re.findall(r"\{\d+\}", k)) != sorted(re.findall(r"\{\d+\}", v))]
    for k, f in sorted(miss.items(), key=lambda x: x[1]):
        print(f"missing  {f}: {k!r}")
    for k in bad:
        print(f"placeholders differ: {k!r}")
    print(f"{len(used())} texts in use, {len(miss)} without English, {len(bad)} with mismatched placeholders")
    return 1 if miss or bad else 0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    sys.exit(build() or 0 if cmd == "build" else check())
