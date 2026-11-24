; Inno Setup script: IPMS client installer
; - no admin rights; installs to %LOCALAPPDATA%\Programs\ToolTable (the folder name of the earlier name, kept: data lives there)
; - packs portable\stage (official python.org embeddable Python + packages + app); no custom .exe,
;   so corporate antivirus does not flag it (PyInstaller executables are a common false positive)
; - data\ (database, icons) stays on upgrade and on uninstall
; Build via: python portable\build_portable.py --version x.y.z
#define AppName "IPMS"
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#define AppPy "{app}\python\python.exe"
#define AppScript "{app}\app\portable\launcher.py"

[Setup]
AppId={{6F1C2B7E-3A54-4C1D-9E7B-5B2A8C0D4E61}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=IPMS
DefaultDirName={localappdata}\Programs\ToolTable
DefaultGroupName={#AppName}
UsePreviousGroup=no
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
OutputDir=output
OutputBaseFilename=IPMS-Setup-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
SetupIconFile=tooltable.ico
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\tooltable.ico
WizardStyle=modern
CloseApplications=yes

[Languages]
Name: "cht"; MessagesFile: "ChineseTraditional.isl"

[Tasks]
Name: "desktopicon"; Description: "在桌面建立「{#AppName}」捷徑"
Name: "startup"; Description: "開機時自動在背景啟動（不開視窗）"; Flags: unchecked

[InstallDelete]
; clean upgrade: old program files go, data\ stays
; the shortcuts of the versions named Tool Table (the install folder keeps its name: the data is there)
Type: filesandordirs; Name: "{autoprograms}\Tool Table"
Type: files; Name: "{autodesktop}\Tool Table.lnk"
Type: files; Name: "{userstartup}\Tool Table.lnk"
Type: filesandordirs; Name: "{app}\python"
Type: filesandordirs; Name: "{app}\app"

[Files]
Source: "stage\*"; DestDir: "{app}"; Excludes: "data\*"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autodesktop}\{#AppName}"; Filename: "{#AppPy}"; Parameters: """{#AppScript}"""; WorkingDir: "{app}"; \
  IconFilename: "{app}\tooltable.ico"; Comment: "開啟 IPMS（關閉黑色視窗即停止）"; Tasks: desktopicon
Name: "{group}\{#AppName}"; Filename: "{#AppPy}"; Parameters: """{#AppScript}"""; WorkingDir: "{app}"; IconFilename: "{app}\tooltable.ico"
Name: "{group}\解除安裝 {#AppName}"; Filename: "{uninstallexe}"
Name: "{userstartup}\{#AppName}"; Filename: "{#AppPy}"; Parameters: """{#AppScript}"" --no-browser"; WorkingDir: "{app}"; \
  IconFilename: "{app}\tooltable.ico"; Flags: runminimized; Tasks: startup

[Run]
Filename: "{#AppPy}"; Parameters: """{#AppScript}"""; WorkingDir: "{app}"; Description: "立即開啟 IPMS"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; program files only (incl. __pycache__ made at run time); data\ is kept
Type: filesandordirs; Name: "{app}\python"
Type: filesandordirs; Name: "{app}\app"
