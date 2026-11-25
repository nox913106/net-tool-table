"""
Outline numbers for cards and their subtasks (the Excel report, the Gantt sheet, MS Project's WBS, the card outline).

  任務大綱 (the card, L1)          A, B, … Z, AA, AB …
  主任務   (its subtasks, L2)       A1, A2
  子任務   (L3)                     A1-1, A1-2
  子任務的任務 (L4 and deeper)      A1-1.1, A1-1.1.1

to_path() also reads the older numbers (1, 1.2, 1.2.3) so files exported before this change still import.
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
    """The k-th child of `parent`; depth is the child's subtask depth (1 = a direct subtask of the card)."""
    return f"{parent}{k}" if depth == 1 else f"{parent}-{k}" if depth == 2 else f"{parent}.{k}"


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
    out = letters(path[0])
    for d, k in enumerate(path[1:], start=1):
        out = child(out, d, k)
    return out
