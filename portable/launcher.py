"""
IPMS — client launcher (Windows: started by IPMS.cmd / the installed shortcut; also works from source)

Double-click → starts the portal on http://127.0.0.1:8080 (or the next free port) without a console
window (pythonw.exe; a start through python.exe — an older shortcut, IPMS.cmd — hands over to it),
opens it in its own app window (Chrome or Edge "--app" mode, no address bar / tabs; falls back to the
default browser) and stops by itself when that window is closed (app/presence.py). Started with
--no-browser (the "start with Windows" shortcut) it keeps running in the background.
Messages go to data\\ipms.log; a start-up error is shown in a message box.

Data lives in .\\data next to the python\\ and app\\ folders (database + icons), so the whole folder
can be copied to another PC or a USB drive. If that folder is not writable (e.g. under
Program Files) it falls back to %LOCALAPPDATA%\\ToolTable.

Options:
  --port N        preferred port (default 8080; the next free one is used if busy)
  --lan           also accept connections from other computers (binds 0.0.0.0)
  --no-browser    do not open the browser
  --tab           open in a normal browser tab instead of an app window
  --data-dir DIR  store data somewhere else
  --console       keep the console window (to watch the log)

Updates: once linked, the copy checks its server's version and, when it differs, downloads that
version from the server (into app.new next to app), stops, swaps the folders and starts again on the
same port; the open window reloads by itself. data\\ is never touched.
"""
import argparse
import os
import shutil
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

APP_NAME = "IPMS"
FROZEN = getattr(sys, "frozen", False)
# Where the program files are: <install>\app (installed / portable zip) or the repository root
BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
# Installed client / portable zip: <install>\python\python.exe (official python.org build) + <install>\app;
# its data goes to <install>\data, next to them, so upgrades (which replace python\ and app\) keep it.
_PY = Path(sys.executable).resolve().parent
EMBEDDED = _PY.name.lower() == "python" and (_PY.parent / "app").is_dir() and BUNDLE_DIR == _PY.parent / "app"
HOME_DIR = _PY.parent if EMBEDDED else Path(sys.executable).resolve().parent if FROZEN else BUNDLE_DIR


def headless() -> bool:
    """No console to write to (pythonw.exe)."""
    return sys.stdout is None or os.path.basename(sys.executable).lower().startswith("pythonw")


def hand_over_to_pythonw() -> bool:
    """Started with python.exe (console window): start again with pythonw.exe and let the console close."""
    if os.name != "nt" or not (EMBEDDED or FROZEN) or "--console" in sys.argv or headless():
        return False
    pyw = Path(sys.executable).with_name("pythonw.exe")
    if not pyw.is_file():
        return False
    import subprocess
    try:
        subprocess.Popen([str(pyw), str(Path(__file__).resolve()), *sys.argv[1:]], cwd=os.getcwd(),
                         creationflags=getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
                         close_fds=True)
        return True
    except OSError:
        return False


def log_to_file(data_dir: Path):
    """Without a console, messages (and errors) go to data\\ipms.log (kept small)."""
    if not headless():
        return
    f = data_dir / "ipms.log"
    try:
        if f.exists() and f.stat().st_size > 1_000_000:
            f.replace(data_dir / "ipms.old.log")
        stream = open(f, "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = stream
        print(f"\n----- {time.strftime('%Y-%m-%d %H:%M:%S')} -----")
    except OSError:
        pass


def message_box(text: str):
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, text, APP_NAME, 0x10)
            return
        except Exception:
            pass
    print(text)


def setup_console():
    """UTF-8 console output on Windows so Chinese text is readable."""
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.kernel32.SetConsoleOutputCP(65001)
            ctypes.windll.kernel32.SetConsoleTitleW(f"{APP_NAME} — 關閉此視窗即停止")
        except Exception:
            pass
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
        except Exception:
            pass


def writable(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".write-test"
        probe.write_text("ok")
        probe.unlink()
        return True
    except OSError:
        return False


def pick_data_dir(cli_value):
    if cli_value:
        return Path(cli_value).resolve()
    preferred = HOME_DIR / "data"
    if writable(preferred):
        return preferred
    fallback = Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".local" / "share") / "ToolTable"
    return fallback


def seed_icons(icon_dir: Path):
    """Copy bundled icons that are not there yet (never overwrites the user's icons)."""
    src = BUNDLE_DIR / "resource" / "icon"
    icon_dir.mkdir(parents=True, exist_ok=True)
    if not src.is_dir():
        return
    for f in src.iterdir():
        target = icon_dir / f.name
        if f.is_file() and not target.exists():
            shutil.copy2(f, target)


def port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if os.name != "nt":
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def already_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1.5) as r:
            return b'"status":"ok"' in r.read()
    except Exception:
        return False


def choose_port(host: str, preferred: int) -> int:
    for port in [preferred, *range(preferred + 1, preferred + 20)]:
        if port_free(host, port):
            return port
    with socket.socket() as s:   # let the OS pick
        s.bind((host, 0))
        return s.getsockname()[1]


def lan_addresses():
    addrs = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                addrs.add(ip)
    except OSError:
        pass
    return sorted(addrs)


def find_app_browser():
    """Chrome or Edge executable that supports --app windows (Windows only), or None."""
    if os.name != "nt":
        return None
    roots = [os.environ.get(k) for k in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")]
    rels = [r"Google\Chrome\Application\chrome.exe", r"Microsoft\Edge\Application\msedge.exe"]
    for rel in rels:                       # Chrome first, then Edge (always present on Windows 10/11)
        for root in roots:
            if root and (Path(root) / rel).is_file():
                return str(Path(root) / rel)
    return shutil.which("chrome") or shutil.which("msedge")


def open_ui(url: str, tab: bool = False):
    """Open the portal as an app window when possible, otherwise in the default browser."""
    exe = None if tab else find_app_browser()
    if exe:
        try:
            import subprocess
            subprocess.Popen([exe, f"--app={url}", "--window-size=1440,900"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))
            return
        except OSError:
            pass
    webbrowser.open(url)


def update_paths():
    return BUNDLE_DIR.parent / (BUNDLE_DIR.name + ".new"), BUNDLE_DIR.parent


def apply_update() -> bool:
    """Swap in the version the sync client downloaded (app.new → app). The old folder is removed."""
    new, parent = update_paths()
    if not (new / ".build").is_file():
        return False
    old = parent / f"{BUNDLE_DIR.name}.old-{int(time.time())}"
    for _ in range(20):                              # a virus scanner may hold a file for a moment
        try:
            os.replace(BUNDLE_DIR, old)
            break
        except OSError:
            time.sleep(0.5)
    else:
        return False
    try:
        os.replace(new, BUNDLE_DIR)
    except OSError:
        os.replace(old, BUNDLE_DIR)
        return False
    (BUNDLE_DIR / ".build").unlink(missing_ok=True)
    shutil.rmtree(old, ignore_errors=True)
    return True


def clean_old():
    _, parent = update_paths()
    for d in parent.glob(BUNDLE_DIR.name + ".old-*"):
        shutil.rmtree(d, ignore_errors=True)


def wait_port_free(host: str, port: int, seconds: float = 15):
    end = time.time() + seconds
    while time.time() < end and not port_free(host, port):
        time.sleep(0.3)


def main():
    setup_console()
    parser = argparse.ArgumentParser(description=f"{APP_NAME} 單機版")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--lan", action="store_true", help="允許其他電腦連線")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--tab", action="store_true", help="用一般瀏覽器分頁開啟，而不是獨立視窗")
    parser.add_argument("--data-dir")
    parser.add_argument("--local-apps", action="store_true", help=argparse.SUPPRESS)  # testing off Windows
    parser.add_argument("--self-update", action="store_true", help=argparse.SUPPRESS)  # testing from a copy
    parser.add_argument("--after-update", action="store_true", help=argparse.SUPPRESS)  # restarted by an update
    parser.add_argument("--console", action="store_true", help="保留主控台視窗（看執行紀錄）")
    args = parser.parse_args()

    host = "0.0.0.0" if args.lan else "127.0.0.1"
    if args.after_update:                            # the previous run is still letting go of the port
        wait_port_free(host, args.port)

    # Second double-click while it is running: just open the browser again
    if already_running(args.port):
        print(f"{APP_NAME} 已在執行中，開啟視窗…")
        if not args.no_browser:
            open_ui(f"http://127.0.0.1:{args.port}/", args.tab)
        return

    data_dir = pick_data_dir(args.data_dir)
    self_update = (EMBEDDED or args.self_update) and not data_dir.resolve().is_relative_to(BUNDLE_DIR.resolve())
    if self_update:
        clean_old()
        if update_paths()[0].is_dir() and not apply_update():    # left from a run that was closed mid-update
            os.environ["TOOL_TABLE_UPDATE_FAILED"] = "1"
    icon_dir = data_dir / "icons"
    data_dir.mkdir(parents=True, exist_ok=True)
    log_to_file(data_dir)
    seed_icons(icon_dir)

    # Must be set before the app is imported (app.config reads them at import time)
    os.environ["TOOL_TABLE_DATA_DIR"] = str(data_dir)
    os.environ["TOOL_TABLE_ICON_DIR"] = str(icon_dir)
    os.environ.setdefault("TOOL_TABLE_ENABLE_DOCS", "false")
    # Launching programs / reading shortcuts only makes sense when the server is this PC
    if os.name == "nt" or args.local_apps:
        os.environ["TOOL_TABLE_LOCAL_APPS"] = "1"
    if not args.no_browser:                          # its window is opened here: stop when it is closed
        os.environ["TOOL_TABLE_EXIT_WHEN_CLOSED"] = "1"  # (kept by a restart after an update)
    if self_update:                                  # the sync client may replace these program files
        os.environ["TOOL_TABLE_SELF_UPDATE_DIR"] = str(BUNDLE_DIR)

    sys.path.insert(0, str(BUNDLE_DIR))
    import uvicorn
    from app.main import app

    port = choose_port(host, args.port)
    url = f"http://127.0.0.1:{port}/"

    line = "=" * 58
    print(line)
    print(f"  {APP_NAME} 單機版")
    print(line)
    print(f"  入口      {url}")
    print(f"  管理後台  {url}admin")
    if args.lan:
        for ip in lan_addresses():
            print(f"  區網      http://{ip}:{port}/")
    print(f"  資料位置  {data_dir}")
    print(line)
    print("  關閉這個視窗（或按 Ctrl+C）即停止服務")
    print(line)

    config = uvicorn.Config(app, host=host, port=port, log_level="warning", access_log=False,
                            server_header=False, date_header=False)
    server = uvicorn.Server(config)
    from app import syncclient

    def restart():
        """A new version was downloaded: once the server lets go of the port, swap it in and start again."""
        server.should_exit = True

        def go():
            time.sleep(0.5)
            wait_port_free(host, port, 20)
            print("\n  更新到伺服器的版本，重新啟動中…", flush=True)
            env = dict(os.environ)
            env.pop("TOOL_TABLE_UPDATE_FAILED", None)
            if not apply_update():
                env["TOOL_TABLE_UPDATE_FAILED"] = "1"
            import subprocess
            argv, skip = [], False
            for a in sys.argv[1:]:                    # same options, this port, no second window
                if skip:
                    skip = False
                elif a == "--port":
                    skip = True
                elif not a.startswith("--port=") and a not in ("--after-update", "--no-browser"):
                    argv.append(a)
            subprocess.Popen([sys.executable, str(BUNDLE_DIR / "portable" / "launcher.py"), *argv,
                              "--port", str(port), "--no-browser", "--after-update"], env=env)
            os._exit(0)                               # not waiting for a long poll still open to the server
        threading.Thread(target=go, daemon=True).start()
    syncclient.on_restart = restart

    def stop_when_closed():
        """The program's window was closed (app/presence.py): stop, without waiting for a long poll still open."""
        server.should_exit = True

        def go():
            time.sleep(3)                             # requests in progress finish
            os._exit(0)
        threading.Thread(target=go, daemon=True).start()
    from app import presence
    presence.on_empty = stop_when_closed

    def open_browser():
        for _ in range(100):
            if server.started:
                open_ui(url, args.tab)
                return
            time.sleep(0.1)

    if not args.no_browser:
        threading.Thread(target=open_browser, daemon=True).start()

    try:
        server.run()
    except KeyboardInterrupt:
        pass
    if syncclient.restart_wanted:                    # restart() finishes the job
        time.sleep(30)


if __name__ == "__main__":
    if hand_over_to_pythonw():                       # no console window: start again without one
        raise SystemExit(0)
    try:
        main()
    except Exception as exc:
        print(f"\n啟動失敗：{exc!r}")
        if headless():                               # nobody sees a console: say it in a message box
            message_box(f"IPMS 啟動失敗：\n{exc}")
        elif (FROZEN or EMBEDDED) and os.name == "nt":
            input("按 Enter 關閉…")
        raise SystemExit(1)
