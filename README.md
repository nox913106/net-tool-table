# Tool Table

![Version](https://img.shields.io/badge/version-3.0.0-6366f1)
![Python](https://img.shields.io/badge/python-3.10+-3b82f6)
![License](https://img.shields.io/badge/license-MIT-22c55e)

可以自由組裝的連結入口網站。
資料夾、連結、首頁版面、配色、頁首元件**全部在管理後台調整**，不用改任何程式碼——
拿來做 IT 工具入口、部門系統入口、文件中心、個人書籤都可以。

![首頁（深色）](docs/images/home-dark.png)

| 淺色主題 | 管理後台 |
|---|---|
| ![首頁（淺色）](docs/images/home-light.png) | ![管理後台](docs/images/admin.png) |

---

## 功能

### 入口網站
- **首頁由區塊組成**：公告、快速連結、我的最愛、最近使用、所有分類，或把任一個資料夾直接攤在首頁；順序、標題、卡片大小都能調
- **資料夾無限層級**：側邊欄樹狀導覽、麵包屑、每個資料夾都有自己的網址（可加書籤、支援上一頁）
- **搜尋面板**：`Ctrl/⌘ + K` 或 `/` 叫出，鍵盤上下選、Enter 開啟；比對名稱、說明、網址、路徑與圖示
- **我的最愛 / 最近使用**：每位使用者各自的（存在瀏覽器），不需登入
- **拖曳網址直接新增**：把瀏覽器網址列、網頁上的連結或書籤拖進頁面，自動帶入標題並比對圖示，確認後就加進目前的資料夾（可在設定關閉）
- **自動取得網站圖示**：新增網址時，圖示庫沒有對應圖示就自動抓網站自己的圖示（優先高解析度的 apple-touch-icon），內網自簽憑證的網站也行
- **本機程式（Windows 單機版）**：把程式的捷徑（.lnk）、網址捷徑（.url）或執行檔（.exe）拖進來，自動讀出路徑、參數與程式圖示；點卡片就直接啟動程式（也可以開文件或資料夾）
- **快速篩選**：依圖示列出同類連結（例如所有 Fortinet 設備），可自訂或自動產生
- **格狀 / 清單**兩種顯示方式，舒適 / 緊湊兩種密度
- **外觀**：深色 / 淺色 / 跟隨系統、任意主題色、極光 / 漸層 / 純色背景；每個資料夾或連結可以有自己的顏色，子項目自動沿用
- **圖示**：上傳圖片，或直接用 emoji；沒有圖示時自動顯示名稱縮寫
- **頁首**：翻頁 / 簡潔時鐘（向本伺服器校時）、使用者 IP、對外 IP；省資源模式（關閉動畫與模糊）
- 手機、平板、桌機都能用

### 管理後台
- **內容**：樹狀編輯，**拖曳排序、拖進資料夾**；名稱、網址、說明、圖示、顏色、開新分頁、啟用 / 停用；也可以直接把網址拖到某個資料夾上新增
- **首頁版面**：加入、排序、設定首頁區塊
- **快速連結**：可分群組的捷徑按鈕（例如各區域上網驗證）
- **圖示**：拖曳上傳、改名（自動更新引用）、顯示使用次數
- **外觀與設定**：所有設定即時預覽
- **備份與匯入**：整站匯出成一個 JSON，可備份、搬家或當範本分享

---

## 安裝

### Windows 免安裝單機版

1. 下載 **[ToolTable-windows-x64.zip](https://github.com/nox913106/net-tool-table/releases/latest/download/ToolTable-windows-x64.zip)**
2. 解壓縮到任何位置（桌面、隨身碟都可以）
3. 點兩下 `ToolTable.exe`，瀏覽器會自動打開

不需要安裝 Python 或任何軟體。資料存在 `ToolTable\data\`，整個資料夾複製走就能換電腦。
第一次執行若出現「Windows 已保護您的電腦」，按「其他資訊 → 仍要執行」（程式沒有數位簽章）。
`ToolTable.exe --lan` 可讓同網段其他電腦連線；其他選項見壓縮檔內的 `README.txt`。

單機版另外可以**啟動電腦上的程式**：把桌面或開始功能表的捷徑、或執行檔直接拖進入口，確認後就變成一張卡片，點了就開啟。
為了安全，這只對「執行 ToolTable.exe 的那台電腦」本身開放：使用 `--lan` 時，其他電腦看得到這些卡片，但不能新增或啟動程式；
其他網站也無法透過瀏覽器偷偷呼叫它。Linux 伺服器版沒有這個功能（程式會在伺服器上執行，沒有意義）。

> 每次推送到 `main`，GitHub Actions 會在 Windows 上重新打包、實際啟動測試，再更新到 [Releases](https://github.com/nox913106/net-tool-table/releases)。
> 自己打包：`pip install -r requirements.txt pyinstaller` → `pyinstaller portable/ToolTable.spec` → `dist\ToolTable\`

### 正式環境（全新 Debian 12/13、Ubuntu 22.04/24.04）

```bash
curl -fsSL https://raw.githubusercontent.com/nox913106/net-tool-table/main/scripts/bootstrap.sh | sudo bash
```

- 對外只有 **HTTPS `33443`**（自簽憑證），**HTTP `80` 自動轉 HTTPS**
- 應用程式只綁 `127.0.0.1`，由 nginx 反向代理，服務埠不對外
- systemd 服務、每日自動備份；升級、健檢、還原、解除安裝都用同一支腳本

```bash
sudo bash /opt/tool-table/scripts/tool-table.sh doctor     # 健檢
```

```bash
sudo bash /opt/tool-table/scripts/tool-table.sh upgrade    # 升級
```

完整步驟、選項（埠號、FQDN）、換正式憑證、備份還原、疑難排解：**[docs/INSTALL.md](docs/INSTALL.md)**

### 本機開發

需要 Python 3.10+：

```bash
./run.sh
```

Windows 用 `run.bat`。開在 `http://127.0.0.1:8080`，後台在 `/admin`。
資料庫在 `./data`，圖示在 `./resource/icon`。第一次啟動是空的，到後台新增，或在「備份與匯入」匯入 JSON。

### 進入後台

- 直接開 `/admin`
- 或在入口快速點 **Logo 或時鐘 5 次**
- 或在「外觀與設定 → 頁首」打開「顯示 ⚙ 後台按鈕」

> ⚠️ 後台與 API 目前沒有登入驗證，請只在內網開放，或用防火牆限制來源。

---

## 專案結構

```
app/                        後端（FastAPI + SQLite）
├── main.py                 路由、靜態檔、/api/time、/api/whoami
├── config.py               環境變數（資料 / 圖示路徑、API 文件開關）
├── database.py             資料表與自動升級
├── models.py
└── routes/
    ├── nodes.py            資料夾與連結（樹、移動、排序）
    ├── auth_links.py       快速連結
    ├── search.py           圖示上傳 / 改名 / 刪除
    └── settings.py         設定、匯出 / 匯入
frontend/                   前端（無框架、無建置步驟）
├── index.html              入口
├── admin.html              管理後台
└── assets/
    ├── css/base.css        設計系統（配色、元件、深淺主題）
    ├── css/portal.css
    ├── css/admin.css
    ├── js/common.js        共用：API、主題、圖示、icon 圖庫
    ├── js/portal.js
    ├── js/clock.js
    └── js/admin.js
resource/icon/              內建圖示
deploy/                     nginx、systemd 範本
scripts/                    bootstrap.sh、tool-table.sh、自簽憑證
portable/                   Windows 免安裝單機版（啟動程式、PyInstaller 設定、圖示）
.github/workflows/          Windows 單機版自動打包
docs/INSTALL.md             安裝與運維 SOP
```

## API

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/nodes/tree` | 整棵樹（`?include_inactive=true` 含停用項目） |
| POST | `/api/nodes` | 新增資料夾 / 連結 |
| PUT | `/api/nodes/{id}` | 更新 |
| PUT | `/api/nodes/{id}/move` | 移到其他資料夾（`{"new_parent_id": id 或 null}`） |
| PUT | `/api/nodes/reorder` | 批次排序（`{"items": [{"id", "sort_order"}]}`） |
| DELETE | `/api/nodes/{id}` | 刪除（含子項目） |
| GET / POST / PUT / DELETE | `/api/auth-links` | 快速連結 |
| GET / POST / PUT / DELETE | `/api/icons` | 圖示 |
| GET / PUT | `/api/settings` | 設定（PUT `{"values": {...}}`） |
| POST | `/api/settings/reset` | 還原預設 |
| GET | `/api/export` | 匯出全部 |
| POST | `/api/import` | 匯入（`{"data": ..., "replace": true}`） |
| GET | `/api/health`、`/api/time`、`/api/whoami` | 健康檢查、伺服器時間、使用者 IP |

開發模式可在 `/docs` 看互動式 API 文件（正式環境預設關閉）。

## 授權

MIT License
