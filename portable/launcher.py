"""
IPMS — client launcher (Windows: started by IPMS.cmd / the installed shortcut; also works from source)

Double-click → starts the portal on http://127.0.0.1:8080 (or the next free port),
opens it in its own app window (Chrome or Edge "--app" mode, no address bar / tabs;
falls back to the default browser), keeps running until this window is closed.

Data lives in .\\data next to the python\\ and app\\ folders (database + icons), so the whole folder
can be copied to another PC or a USB drive. If that folder is not writable (e.g. under
Program Files) it falls back to %LOCALAPPDATA%\\ToolTable.

Options:
  --port N        preferred port (default 8080; the next free one is used if busy)
  --lan           also accept connections from other computers (binds 0.0.0.0)
  --no-browser    do not open the browser
  --tab           open in a normal browser tab instead of an app window
  --data-dir DIR  store data somewhere else
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


def main():
    setup_console()
    parser = argparse.ArgumentParser(description=f"{APP_NAME} 單機版")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--lan", action="store_true", help="允許其他電腦連線")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--tab", action="store_true", help="用一般瀏覽器分頁開啟，而不是獨立視窗")
    parser.add_argument("--data-dir")
    parser.add_argument("--local-apps", action="store_true", help=argparse.SUPPRESS)  # testing off Windows
    args = parser.parse_args()

    host = "0.0.0.0" if args.lan else "127.0.0.1"

    # Second double-click while it is running: just open the browser again
    if already_running(args.port):
        print(f"{APP_NAME} 已在執行中，開啟視窗…")
        if not args.no_browser:
            open_ui(f"http://127.0.0.1:{args.port}/", args.tab)
        time.sleep(1.5)
        return

    data_dir = pick_data_dir(args.data_dir)
    icon_dir = data_dir / "icons"
    data_dir.mkdir(parents=True, exist_ok=True)
    seed_icons(icon_dir)

    # Must be set before the app is imported (app.config reads them at import time)
    os.environ["TOOL_TABLE_DATA_DIR"] = str(data_dir)
    os.environ["TOOL_TABLE_ICON_DIR"] = str(icon_dir)
    os.environ.setdefault("TOOL_TABLE_ENABLE_DOCS", "false")
    # Launching programs / reading shortcuts only makes sense when the server is this PC
    if os.name == "nt" or args.local_apps:
        os.environ["TOOL_TABLE_LOCAL_APPS"] = "1"

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


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:   # keep the window open so the user can read the error
        print(f"\n啟動失敗：{exc!r}")
        if (FROZEN or EMBEDDED) and os.name == "nt":
            input("按 Enter 關閉…")
        raise SystemExit(1)
