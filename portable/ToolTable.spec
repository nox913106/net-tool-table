# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the portable build:  pyinstaller portable/ToolTable.spec
# Output: dist/ToolTable/ToolTable.exe (+ _internal/). A folder build (not one-file):
# starts faster and is far less likely to be flagged by antivirus software.
import os
from PyInstaller.utils.hooks import collect_submodules

ROOT = os.path.abspath(os.path.join(SPECPATH, '..'))

hidden = (
    collect_submodules('uvicorn')
    + collect_submodules('app')
    + ['aiosqlite', 'multipart', 'python_multipart']
)

a = Analysis(
    [os.path.join(ROOT, 'portable', 'launcher.py')],
    pathex=[ROOT],
    datas=[
        (os.path.join(ROOT, 'frontend'), 'frontend'),
        (os.path.join(ROOT, 'resource', 'icon'), os.path.join('resource', 'icon')),
    ],
    hiddenimports=hidden,
    excludes=['tkinter', 'unittest', 'pydoc', 'test', 'numpy', 'yaml', 'PIL'],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='ToolTable',
    icon=os.path.join(ROOT, 'portable', 'tooltable.ico'),
    console=True,          # the window shows the URL; closing it stops the server
    upx=False,
)

coll = COLLECT(exe, a.binaries, a.datas, name='ToolTable', upx=False)
