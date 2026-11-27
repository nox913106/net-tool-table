"""
Outline numbers inside one card / project (the Excel report, the Gantt sheet, MS Project's WBS, the card outline),
following OpenProject's structure — the card itself is the project's head and carries no number:

  專案／主卡 (the card)            (no number)
  階段      (its subtasks)         A, B, … Z, AA …     — phases; how many depends on the project
  工作      (their subtasks)       A1, A2
  子工作    (next level)           A1-1, A1-2
  細項      (deeper)               A1-1.1, A1-1.1.1

Numbers restart in every card. to_path() reads a number as its path inside the card ("A1-2" → (1, 1, 2)), and also
the dotted numbers (1.2.3) of very old files. Files from the version that numbered the card itself (A, A1 …) are
recognised by the card row having a number and read the old way (to_path gives the card first).
"""
import re
from typing import Optional, Tuple

CODE_RE = re.compile(r"([A-Za-z]+)(?:(\d+)(?:-(\d+)((?:\.\d+)*))?)?")
OLD_RE = re.compile(r"\d+(?:\.\d+)*")
# a number inside free text (前置任務): new codes or old dotted numbers
TOKEN = r"(?<![A-Za-z\d.\-])([A-Za-z]{1,3}(?:\d+(?:-\d+(?:\.\d+)*)?)?|\d+(?:\.\d+)*)(?![A-Za-z\d\-])"


def letters(n: int) -> str:
    """1 → A, 26 → Z, 27 → AA."""
    s = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def child(parent: str, depth: int, k: int) -> str:
    """The k-th child of `parent`; depth is the child's subtask depth (1 = a direct subtask of the card, a phase:
    its number is a letter and `parent` — the card, which has no number — is ignored)."""
    return letters(k) if depth == 1 else f"{parent}{k}" if depth == 2 else f"{parent}-{k}" if depth == 3 else f"{parent}.{k}"


def sub_code(path) -> str:
    """A path inside the card → its number: (1,) → A, (1, 2) → A2, (1, 2, 3) → A2-3, (1, 2, 3, 4) → A2-3.4."""
    out = ""
    for d, k in enumerate(path, start=1):
        out = child(out, d, k)
    return out



def from_letters(s: str) -> int:
    n = 0
    for ch in s.upper():
        n = n * 26 + ord(ch) - 64
    return n


def to_path(code) -> Optional[Tuple[int, ...]]:
    """'A1-2.3' → (1, 1, 2, 3); '1.1.2.3' → the same; anything else → None."""
    s = str(code or "").strip()
    if OLD_RE.fullmatch(s):
        return tuple(int(x) for x in s.split("."))
    m = CODE_RE.fullmatch(s)
    if not m:
        return None
    path = [from_letters(m.group(1))]
    if m.group(2):
        path.append(int(m.group(2)))
    if m.group(3):
        path.append(int(m.group(3)))
    if m.group(4):
        path += [int(x) for x in m.group(4).split(".") if x]
    return tuple(path)


def from_path(path) -> str:
    """A full path (card, then the path inside it) → the number shown for it (the card itself: "")."""
    return sub_code(path[1:])
