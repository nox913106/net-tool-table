"""Build the Windows client: an installer (Inno Setup) and a portable zip.

No custom-compiled .exe is shipped on purpose: corporate antivirus (e.g. Trend Micro) deletes
PyInstaller bootloader executables as a false positive. The client runs on the official,
PSF-signed python.exe from python.org's embeddable package instead:

  stage/
    python/                     python.org embeddable Python + Lib/site-packages (requirements.txt)
    app/                        app/, frontend/, resource/icon/, portable/launcher.py
    data/                       created on first start (database, icons) — kept on upgrade
    IPMS.cmd                    starts the client (python\\pythonw.exe app\\portable\\launcher.py, no console window)
    tooltable.ico, README.txt

Runs on Windows (CI: windows-latest). Usage:
    python portable/build_portable.py [--version 1.0.0] [--skip-iscc]
Outputs in portable/output/: IPMS-Setup-<ver>.exe and IPMS-windows-x64.zip (whose folder stays ToolTable: data lives there)
"""
import argparse
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

PY_VER = "3.12.10"          # last 3.12 release with python.org binaries (embeddable zip)
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
STAGE = HERE / "stage"
CACHE = HERE / "cache"
OUT = HERE / "output"


def run(cmd, **kw):
    print("  $", " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], check=True, **kw)


def fetch_embed() -> Path:
    CACHE.mkdir(exist_ok=True)
    z = CACHE / f"python-{PY_VER}-embed-amd64.zip"
    if not z.exists():
        url = f"https://www.python.org/ftp/python/{PY_VER}/{z.name}"
        print("  下載", url, flush=True)
        z.write_bytes(urllib.request.urlopen(url, timeout=180).read())
    return z


def find_iscc():
    cands = []
    for base in (os.environ.get("ProgramFiles(x86)", ""), os.environ.get("ProgramFiles", ""), os.environ.get("LOCALAPPDATA", "")):
        cands += [Path(base) / "Inno Setup 6" / "ISCC.exe", Path(base) / "Programs" / "Inno Setup 6" / "ISCC.exe"]
    found = shutil.which("iscc")
    if found:
        cands.insert(0, Path(found))
    return next((p for p in cands if p.exists()), None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", default="1.0.0")
    ap.add_argument("--skip-iscc", action="store_true")
    a = ap.parse_args()
    minor = PY_VER.rsplit(".", 1)[0]
    print(f"=== Build IPMS client {a.version} (embedded Python {PY_VER}) ===", flush=True)

    print("[1/4] 內嵌 Python", flush=True)
    if STAGE.exists():
        shutil.rmtree(STAGE)
    pydir = STAGE / "python"
    pydir.mkdir(parents=True)
    zipfile.ZipFile(fetch_embed()).extractall(pydir)
    pth = next(pydir.glob("python3*._pth"))
    pth.write_text(f"{pth.stem}.zip\n.\nLib\\site-packages\n..\\app\nimport site\n", encoding="ascii")
    site = pydir / "Lib" / "site-packages"
    site.mkdir(parents=True)

    print("[2/4] 套件", flush=True)
    # wheels for the embedded interpreter, whatever Python runs this script
    run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "-q", "--only-binary=:all:",
         "--platform", "win_amd64", "--python-version", minor, "--implementation", "cp",
         "--target", site, "-r", ROOT / "requirements.txt"])
    for d in site.rglob("__pycache__"):
        shutil.rmtree(d, ignore_errors=True)
    # pip's console-script launchers (uvicorn.exe…) are small generated executables: not needed, and
    # exactly the kind of file antivirus flags
    shutil.rmtree(site / "bin", ignore_errors=True)
    for f in site.rglob("*.exe"):
        f.unlink()

    print("[3/4] 程式", flush=True)
    app = STAGE / "app"
    skip = shutil.ignore_patterns("__pycache__", "*.pyc")
    shutil.copytree(ROOT / "app", app / "app", ignore=skip)
    shutil.copytree(ROOT / "frontend", app / "frontend", ignore=skip)
    shutil.copytree(ROOT / "resource" / "icon", app / "resource" / "icon")
    (app / "portable").mkdir()
    shutil.copy2(HERE / "launcher.py", app / "portable" / "launcher.py")
    shutil.copy2(ROOT / "requirements.txt", app / "requirements.txt")   # part of the version id (app/version.py)
    for f in ("VERSION", "CHANGELOG.md"):                                 # 後台「版本紀錄」
        shutil.copy2(ROOT / f, app / f)
    shutil.copy2(HERE / "tooltable.ico", STAGE / "tooltable.ico")
    shutil.copy2(HERE / "README.txt", STAGE / "README.txt")
    (STAGE / "IPMS.cmd").write_text(
        '@echo off\r\nstart "" "%~dp0python\\pythonw.exe" "%~dp0app\\portable\\launcher.py" %*\r\n', encoding="ascii")
    if os.name == "nt":                                   # self-test with the embedded interpreter
        run([pydir / "python.exe", "-c", "import sys; sys.path.insert(0, r'%s'); import uvicorn, aiosqlite, openpyxl, ldap3, "
             "cryptography, PIL, icoextract; from app.main import app; print('   self-test OK')" % app],
            env={**os.environ, "TOOL_TABLE_DATA_DIR": str(CACHE / "selftest")})
    size = sum(f.stat().st_size for f in STAGE.rglob("*") if f.is_file()) / 2**20
    print(f"   stage {size:.0f} MB", flush=True)

    print("[4/4] 封裝", flush=True)
    OUT.mkdir(exist_ok=True)
    z = OUT / "IPMS-windows-x64.zip"
    if z.exists():
        z.unlink()
    with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for f in sorted(STAGE.rglob("*")):
            if f.is_file() and "data" not in f.relative_to(STAGE).parts[:1]:
                zf.write(f, Path("ToolTable") / f.relative_to(STAGE))   # same folder as before: unzip over it, data stays
    print(f"   {z.name} {z.stat().st_size / 2**20:.0f} MB", flush=True)
    if a.skip_iscc:
        return
    iscc = find_iscc()
    if not iscc:
        sys.exit("找不到 Inno Setup 6（ISCC.exe）：winget install --id JRSoftware.InnoSetup -e --scope user")
    run([iscc, "/Q", f"/DAppVersion={a.version}", HERE / "ToolTable.iss"])
    exe = OUT / f"IPMS-Setup-{a.version}.exe"
    print(f"   {exe.name} {exe.stat().st_size / 2**20:.0f} MB", flush=True)


if __name__ == "__main__":
    main()
