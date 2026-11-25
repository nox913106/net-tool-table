"""
Command-line helpers (run inside the app directory / venv):

  python -m app.cli local-admin              create the local break-glass admin if missing
                                             (prints a generated password once)
  python -m app.cli local-admin --reset      set a new generated password (signs it out everywhere)
  python -m app.cli local-admin --password-stdin   use the password read from stdin
  python -m app.cli users                    list accounts and roles
  python -m app.cli ldap-check               test the AD / LDAP connection (and service account)
  python -m app.cli ldap-test <user>         try signing in as <user> (password from stdin)

The local admin's name is TOOL_TABLE_LOCAL_ADMIN (default "localadmin").
"""
import argparse
import asyncio
import contextlib
import io
import sqlite3
import sys

from . import config as C
from .auth import generate_password, hash_password
from .database import DB_PATH, init_db


def local_admin(reset: bool, password: str = None) -> int:
    with contextlib.redirect_stdout(io.StringIO()):     # keep the output to what the admin needs
        asyncio.run(init_db())
    con = sqlite3.connect(DB_PATH)
    con.execute("PRAGMA foreign_keys = ON")
    row = con.execute("SELECT id, source FROM users WHERE username = ?", (C.LOCAL_ADMIN,)).fetchone()
    if row and row[1] != "local":
        print(f"錯誤：帳號 {C.LOCAL_ADMIN} 已是 AD 帳號，請用 TOOL_TABLE_LOCAL_ADMIN 換一個名稱", file=sys.stderr)
        return 2
    if row and not reset and password is None:
        print(f"本機管理員 {C.LOCAL_ADMIN} 已存在（未變更密碼；要重設請加 --reset）")
        return 0
    generated = password is None
    password = password or generate_password()
    if len(password) < 12:
        print("錯誤：密碼至少 12 個字元", file=sys.stderr)
        return 2
    if row:
        con.execute("UPDATE users SET password_hash = ?, role = 'superadmin', active = 1, must_change_password = ? WHERE id = ?",
                    (hash_password(password), int(generated), row[0]))
        con.execute("DELETE FROM sessions WHERE user_id = ?", (row[0],))
    else:
        con.execute("""INSERT INTO users (username, source, display_name, role, password_hash, must_change_password)
                       VALUES (?, 'local', '本機管理員', 'superadmin', ?, ?)""", (C.LOCAL_ADMIN, hash_password(password), int(generated)))
    con.commit()
    con.close()
    print(f"本機管理員帳號：{C.LOCAL_ADMIN}")
    if generated:
        print(f"密碼：{password}")
        print("（第一次登入時會要求改成你自己的密碼；之後都在後台操作）")
    return 0


def list_users() -> int:
    with contextlib.redirect_stdout(io.StringIO()):     # keep the output to what the admin needs
        asyncio.run(init_db())
    con = sqlite3.connect(DB_PATH)
    rows = con.execute("SELECT username, source, role, active, department, display_name, last_login FROM users ORDER BY role, username").fetchall()
    for r in rows:
        print(f"{r[0]:<20} {r[1]:<6} {r[2]:<11} {'啟用' if r[3] else '停用':<3} {r[4] or '':<12} {r[5] or '':<12} {r[6] or ''}")
    if not rows:
        print("（沒有帳號）")
    return 0


def ldap_check() -> int:
    from . import ldapauth, sysconfig
    c = sysconfig.ldap()
    print(f"AD 伺服器   {c.url or '（未設定：請在後台「系統設定 → AD 登入」填寫）'}")
    print(f"Base DN     {c.base_dn or '（未設定）'}")
    print(f"登入方式    {'服務帳號搜尋 + 驗證' if c.bind_dn else ('UPN（帳號@' + c.domain + '）' if c.domain else '（未設定）')}")
    if not ldapauth.enabled(c):
        print("→ AD 尚未啟用或設定不完整，目前只能用本機管理員登入")
        return 1
    if not c.bind_dn:
        print("→ 沒有服務帳號，無法預先測試；請在後台用「測試登入」")
        return 0
    try:
        ldapauth._connect(c.bind_dn, c.bind_password, c).unbind()
        print("✔ 服務帳號登入成功")
        found = ldapauth.search_directory("a", limit=5, cfg=c)
        print(f"✔ 目錄搜尋可用（例：{', '.join(a['username'] for a in found) or '沒有結果'}）")
        return 0
    except Exception as e:
        print(f"✘ {e}")
        return 1


def ldap_test(username: str, password: str) -> int:
    from . import ldapauth
    try:
        info = ldapauth.authenticate(username, password)
    except ConnectionError as e:
        print(f"✘ {e}")
        return 1
    if not info:
        print("✘ 帳號或密碼錯誤，或帳號不在允許的範圍（TOOL_TABLE_LDAP_USER_FILTER）")
        return 1
    print(f"✔ 登入成功：{info['username']}　姓名：{info['display_name']}　部門：{info['department'] or '（AD 沒有填 department）'}　信箱：{info['email']}")
    return 0


def backup_cmd(incremental: bool) -> int:
    """Same backup as the admin UI (database, key, icons, every attachment, manifest + check). Prints JSON."""
    import json
    from . import backup as bk
    b = bk.make_backup("manual", incremental=incremental)
    print(json.dumps({"name": b["name"], "path": str(bk.BACKUP_DIR / b["name"]), "type": b["type"],
                      "check": b.get("check"), "ok": b.get("check_ok", True)}, ensure_ascii=False))
    return 0 if b.get("check_ok", True) else 3


def export_cmd(name: str, out: str) -> int:
    """A complete archive of a backup (an incremental one gathered from its chain) at `out`."""
    import shutil
    from pathlib import Path
    from . import backup as bk
    p = bk.safe_path(name)
    if bk.kind_of(name) == "inc":
        tmp = bk.consolidate(p)
        shutil.move(str(tmp), out)
    else:
        shutil.copy2(p, out)
    print(Path(out).resolve())
    return 0


def restore_cmd(file: str) -> int:
    """Restore a backup file (a full one, or an incremental one whose chain is in the backup folder)."""
    import shutil
    from pathlib import Path
    from . import backup as bk
    src = Path(file).resolve()
    if src.parent != bk.BACKUP_DIR.resolve() or not bk.NAME_RE.match(src.name):
        target = bk.new_name("upload")
        shutil.copy2(src, target)
        src = target
    r = bk.restore(src)
    print(f"已還原 {r['restored']}（{r['files']} 個檔案）；還原前的狀態存成 {r['safety_backup']}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m app.cli")
    sub = ap.add_subparsers(dest="cmd", required=True)
    la = sub.add_parser("local-admin")
    la.add_argument("--reset", action="store_true")
    la.add_argument("--password-stdin", action="store_true")
    sub.add_parser("users")
    sub.add_parser("ldap-check")
    lt = sub.add_parser("ldap-test")
    lt.add_argument("username")
    bp = sub.add_parser("backup")
    bp.add_argument("--incremental", action="store_true")
    ep = sub.add_parser("backup-export")
    ep.add_argument("name")
    ep.add_argument("out")
    rp = sub.add_parser("restore")
    rp.add_argument("file")
    a = ap.parse_args(argv)
    if a.cmd == "backup":
        return backup_cmd(a.incremental)
    if a.cmd == "backup-export":
        return export_cmd(a.name, a.out)
    if a.cmd == "restore":
        return restore_cmd(a.file)
    if a.cmd == "ldap-check":
        return ldap_check()
    if a.cmd == "ldap-test":
        return ldap_test(a.username, sys.stdin.readline().rstrip("\n"))
    if a.cmd == "local-admin":
        pw = sys.stdin.readline().rstrip("\n") if a.password_stdin else None
        return local_admin(a.reset, pw)
    return list_users()


if __name__ == "__main__":
    raise SystemExit(main())
