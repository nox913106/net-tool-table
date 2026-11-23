# Tool Table 安裝與運維 SOP

適用：在一台**全新、空白的 Linux** 上部署 Tool Table。
架構：nginx 以 HTTPS（預設 **33443**）對外，反向代理到只綁 `127.0.0.1` 的應用程式，
應用程式的服務埠不對外開放；HTTP（80）一律轉到 HTTPS。預設使用自簽憑證。

```
瀏覽器 ──http://主機/───────────► nginx :80     ─301─► https://主機:33443/
瀏覽器 ──https://主機:33443/───► nginx :33443  (TLS、安全標頭)
                                     │ 反向代理
                                     ▼
                          uvicorn 127.0.0.1:8080   ← 不對外，外部連不到
                          （systemd：tool-table.service，帳號 tooltable）
```

---

## 1. 系統需求

| 項目 | 需求 |
|------|------|
| 作業系統 | Debian 12 / 13、Ubuntu 22.04 / 24.04 / 26.04（x86_64 或 arm64） |
| 硬體 | 1 核心 · 1 GB 記憶體 · 5 GB 磁碟即可 |
| 網路 | 安裝時需能連到 GitHub 與 apt / PyPI 套件來源 |
| 權限 | root 或 sudo |
| 對外埠 | `33443/tcp`（HTTPS）、`80/tcp`（只做轉址，可關閉） |

其他 apt 系發行版會顯示警告後繼續安裝；非 apt 系統不支援。

---

## 2. 一鍵安裝

### 2.1 預備：系統更新（建議）

```bash
sudo apt-get update && sudo apt-get -y full-upgrade && sudo reboot
```

### 2.2 安裝

```bash
# 前置：最小化系統可能沒有 curl
sudo apt-get update && sudo apt-get install -y curl
```

```bash
# 一行完成：自動 clone 到 /opt/tool-table 並安裝
curl -fsSL https://raw.githubusercontent.com/nox913106/net-tool-table/main/scripts/bootstrap.sh | sudo bash
```

安裝腳本會：

1. 安裝 `python3`、`python3-venv`、`nginx`、`openssl`
2. 建立系統帳號 `tooltable`（無法登入）
3. 建立 Python 虛擬環境 `/opt/tool-table/.venv` 並安裝相依套件
4. 寫入設定 `/etc/tool-table/tool-table.env`
5. 產生自簽憑證 `/etc/tool-table/tls/server.{crt,key}`（ECDSA P-384，SAN 自動帶入主機名稱與所有本機 IP）
6. 安裝並啟動 `tool-table.service`（只綁 `127.0.0.1:8080`）與每日備份排程 `tool-table-backup.timer`
7. 設定 nginx：`33443` HTTPS 反向代理、`80` 轉 HTTPS；停用 nginx 預設站台
8. 若 `ufw` / `firewalld` 已啟用，自動開放 `33443/tcp` 與 `80/tcp`
9. 確認服務真的有回應後，印出入口網址

完成時會顯示：

```
  入口      https://<伺服器IP>:33443/
  管理後台  https://<伺服器IP>:33443/admin
```

### 2.3 安裝選項

選項放在 `bash -s --` 後面：

```bash
curl -fsSL https://raw.githubusercontent.com/nox913106/net-tool-table/main/scripts/bootstrap.sh \
  | sudo bash -s -- --https-port 33443 --fqdn portal.example.com
```

| 選項 | 預設 | 說明 |
|------|------|------|
| `--https-port N` | `33443` | 對外 HTTPS 埠 |
| `--http-port N` | `80` | 只做轉址的 HTTP 埠；`0` = 不開 HTTP |
| `--app-port N` | `8080` | 應用程式埠（只綁 127.0.0.1，不對外） |
| `--fqdn 名稱` | 空（接受任何主機名稱） | nginx `server_name` 與自簽憑證的 CN |

環境變數：`TOOL_TABLE_BRANCH`（預設 `main`）、`TOOL_TABLE_REPO`、`TOOL_TABLE_DIR`（預設 `/opt/tool-table`）。

已經裝好之後要改埠號，直接再跑一次 install 即可（設定與資料都會保留）：

```bash
sudo bash /opt/tool-table/scripts/tool-table.sh install --https-port 443 --http-port 80
```

### 2.4 第一次使用

1. 瀏覽 `https://<伺服器IP>:33443/`，瀏覽器會警告自簽憑證，確認後繼續
2. 用安裝結束時印出的**本機管理員**（`localadmin` ＋ 密碼）登入，第一次登入會要求設定新密碼
3. 照第 2.5 節在後台設定 AD，並在「帳號與權限」指定至少一位 AD 系統管理者；之後平常都用 AD 帳號
4. 首頁是空的，點「前往管理後台新增 →」或開啟 `/admin`
5. 在「外觀與設定」設定網站名稱、首頁、快速連結等
6. 在「內容」建立資料夾與連結；或在「備份與匯入」匯入現成的 JSON 範本

**安裝成 App（Chrome / Edge）**：入口頁頁首右上角會出現「安裝」按鈕（或網址列右側的安裝圖示），
裝好後就是獨立視窗，有自己的開始功能表與工作列圖示。
自簽憑證下瀏覽器不信任此網站，按鈕不會出現；這時可用瀏覽器選單
「投放、儲存及分享 → 建立捷徑…」並勾選「以視窗開啟」，效果相同。
想要完整的 App 功能（離線時顯示上次的畫面），請讓用戶端信任這張憑證
（把 `/etc/tool-table/tls/server.crt` 匯入「受信任的根憑證授權單位」，或用 AD 群組原則派送），或換成正式憑證（第 3 節）。

### 2.5 帳號、AD 與其他設定（全部在後台）

安裝完成後**不需要再登入伺服器或編輯任何設定檔**，所有設定都在網頁後台完成：

| 後台位置 | 可以設定 |
|----------|----------|
| 系統設定 → AD 登入 | 網域控制站（ldaps:// / ldap:// + StartTLS）、Base DN、服務帳號與密碼（加密保存）、或用網域直接登入、只允許某群組、屬性名稱、內部 CA 憑證（直接貼上）、逾時。**「測試」按鈕**可用表單內容（不必先儲存）測試服務帳號、目錄搜尋與某個帳號的實際登入 |
| 系統設定 → 登入安全 | 閒置登出時間、最長登入天數、密碼連續錯誤鎖定（次數 / 分鐘）、每個來源 IP 上限 |
| 系統設定 → HTTPS 憑證 | 目前憑證資訊與到期天數；貼上或選擇正式憑證（fullchain）與私鑰套用；重新產生自簽憑證 |
| 系統設定 → 連線埠與名稱 | HTTPS 埠、HTTP 埠（0 = 不開）、伺服器名稱（FQDN） |
| 備份與匯入 → 自動備份 | 每天幾點、保留天數、立即備份、下載、上傳備份檔、還原 |
| 帳號與權限 | 指定權限（系統管理者、看板總管理者 RW / RO、部門看板管理者 RW / RO、使用者）與管理部門、停用帳號、預先加入 AD 帳號 |

| 權限 | 後台 | 看板：看得到 | 看板：可編輯 / 刪除 / 指派 |
|------|------|--------------|----------------------------|
| 本機管理員 `localadmin` | 全部（緊急用，平常不用） | 所有卡片 | 所有卡片 |
| 系統管理者（RW） | 全部設定 | 所有卡片 | 所有卡片 |
| 看板總管理者（RW） | — | 所有卡片 | 所有卡片 |
| 看板總管理者（RO） | — | 所有部門的卡片（詳細內容） | 只有自己的卡片；其他卡片可以留言 |
| 部門看板管理者（RW） | — | 管理部門的卡片 ＋ 自己的 | 管理部門的卡片（只能指派該部門的人）＋ 自己的 |
| 部門看板管理者（RO） | — | 管理部門的卡片 ＋ 自己的 | 只有自己的卡片；其他卡片可以留言 |
| 使用者（AD 預設） | — | 自己建立、被指派、被 @ 的卡片 | 同左（不能指派） |

卡片屬於「建立者」與「負責人」所在的部門（AD 的 `department`）。部門看板管理者預設管理自己的部門，
可在「帳號與權限」勾選要管理的其他部門。系統要求**至少保留一位 AD 系統管理者**。
本機管理員第一次登入必須改成自己的密碼；AD 帳號第一次登入時自動建立為「使用者」。

**第一次設定 AD 的順序**

1. 用本機管理員登入，設定新密碼
2. 系統設定 → AD 登入：填伺服器、Base DN、服務帳號，按「測試」（可同時輸入一組帳號密碼測試登入）
3. 測試全部打勾後，打開「啟用 AD 登入」並儲存
4. 請一位同事用 AD 帳號登入一次，再到「帳號與權限」把他設為「系統管理者」（有服務帳號時也可以直接用「加入」預先建立）；其他人依需要設為看板 / 部門看板管理者

- 帳號可以輸入 `alice`、`CORP\alice` 或 `alice@corp.local`；姓名取自 `displayName`、部門取自 `department`（公開進度看板依部門分組），每次登入時更新
- 憑證與連線埠的變更由伺服器上的 `tool-table-apply.path` 套用：網頁服務本身沒有 root 權限，它只留下變更要求，由這個系統服務檢查內容（憑證與私鑰是否成對、埠號是否被占用）後套用；nginx 不接受時自動還原
- 服務帳號密碼以 AES-256-GCM 加密保存，金鑰在 `/var/lib/tool-table/.secret.key`（安裝時自動產生，僅服務帳號可讀；備份會一併帶上）

**公開進度看板** `https://<伺服器>:33443/dashboard`：不需登入、唯讀，依「部門 → 帳號 → 狀態」顯示卡片數量，
不顯示任何卡片內容，不含週期工作；每 15 秒自動更新，適合放在牆上的螢幕。可在「外觀與設定 → 待辦看板」關閉。

**緊急狀況**（例如 AD 故障又忘了本機管理員密碼）才需要登入伺服器：

```bash
sudo bash /opt/tool-table/scripts/tool-table.sh reset-admin
```

> 從沒有帳號功能的舊版執行 `upgrade` 時，會自動開啟登入並建立本機管理員（密碼印在畫面上，也存在 `initial-admin.txt`）。
> 舊版寫在設定檔的 `TOOL_TABLE_LDAP_*` 仍然有效，第一次在後台儲存 AD 設定後就以後台為準。

### 2.6 上下級

- **自動**：「系統設定 → AD 登入 → 進階」的「從 AD 同步上級」預設開啟，讀 AD 的 `manager` 屬性（需要服務帳號），使用者每次登入時更新。
- **手動**：「帳號與權限」的「上級」欄點一下就能指定；手動指定的不會被 AD 覆蓋，按「改回依 AD」恢復。不能把自己或自己的下級設為上級。
- **權限**：「外觀與設定 → 待辦看板 → 上級對下級卡片的權限」：可編輯（預設：瀏覽、留言、增刪修、指派給下級）／檢視＋留言／不分享。下級可以多層。

### 2.7 端對端檢查

```bash
# 健檢：每一項失敗都會印出修法（→ 開頭那行）
sudo bash /opt/tool-table/scripts/tool-table.sh doctor
```

```bash
# HTTP 應回 301 並轉到 https://…:33443/
curl -sI http://127.0.0.1/ | grep -iE '^(HTTP|location)'
```

```bash
# 服務埠只能出現在 127.0.0.1
sudo ss -ltnp | grep -E ':(80|8080|33443) '
```

```bash
# 安全標頭（每個應只出現一次，Server 不含版本）
curl -skI https://127.0.0.1:33443/ | grep -iE 'strict-transport|content-security|x-frame|^server'
```

---

## 3. 換成正式憑證

在後台「系統設定 → HTTPS 憑證」貼上（或選擇檔案）憑證與私鑰，按「套用新憑證」：

- 憑證請用含中繼憑證的 **fullchain**（伺服器憑證在最前面）；私鑰不能有密碼保護
- 套用前會檢查憑證與私鑰是否成對、是否過期；nginx 不接受時自動換回原本的（舊憑證留一份在 `/etc/tool-table/tls/previous/`）
- 主機改了 IP 或名稱：同一頁按「重新產生自簽憑證」
- 之後執行 upgrade **不會**覆蓋你的憑證

---

## 4. 升級

```bash
sudo bash /opt/tool-table/scripts/tool-table.sh upgrade
```

流程：`git pull` → 備份 → 更新 Python 套件 → 更新 systemd / nginx 設定 → 重啟 → 確認有回應。
設定檔、資料庫、圖示、憑證都會保留。

---

## 5. 備份與還原

在後台「備份與匯入 → 自動備份」設定每天幾點備份、保留幾天；也可以「立即備份」、下載、上傳備份檔與還原。
備份內容是資料庫一致性快照（帳號、看板、連結、設定）、所有圖示、看板附件與加密金鑰，存在 `/var/lib/tool-table/backups/`。
還原前會自動再備份一次目前的狀態。下載的備份檔含有解密金鑰，請妥善保管。

另外，「備份與匯入」的「匯出 / 匯入」可以把設定、連結、快速連結與看板卡片匯出成一個 JSON，適合搬家或分享範本（不含帳號、加密設定與圖示檔）。

伺服器另有系統層級的每日備份（含 TLS 憑證與 nginx 設定，`/var/backups/tool-table/`），整台主機重建時使用：

```bash
sudo bash /opt/tool-table/scripts/tool-table.sh restore /var/backups/tool-table/tool-table-YYYYmmdd-HHMMSS.tar.gz
```

---

## 6. 解除安裝

```bash
# 移除服務與 nginx 站台，保留設定與資料
sudo bash /opt/tool-table/scripts/tool-table.sh uninstall
```

```bash
# 連同設定、資料庫、圖示、憑證、系統帳號一起刪除（備份會保留）
sudo bash /opt/tool-table/scripts/tool-table.sh uninstall --purge
```

原始碼 `/opt/tool-table` 不會被刪除，不需要時可自行 `sudo rm -rf /opt/tool-table`。

---

## 7. 檔案位置

| 路徑 | 內容 |
|------|------|
| `/opt/tool-table/` | 原始碼（git）與 `.venv` |
| `/etc/tool-table/tool-table.env` | 安裝時寫入的基本設定（路徑、埠號）；**不需要手動編輯**，後台變更埠號時會自動更新 |
| `/etc/tool-table/initial-admin.txt` | 本機管理員初始密碼（安裝 / reset-admin 時寫入，僅 root 可讀，第一次登入改完後可刪除） |
| `/var/lib/tool-table/.secret.key` | 加密金鑰（AD 服務帳號密碼），自動產生 |
| `/var/lib/tool-table/backups/` | 後台的自動備份 |
| `/var/lib/tool-table/requests/` | 後台送給 `tool-table-apply.path` 的憑證 / 埠號變更要求 |
| `/etc/tool-table/tls/` | `server.crt`、`server.key` |
| `/var/lib/tool-table/tool-table.db` | SQLite 資料庫 |
| `/var/lib/tool-table/icons/` | 圖示（後台上傳的也在這裡） |
| `/var/lib/tool-table/attachments/` | 看板卡片與留言的附件（圖片與文件，只能透過 API 依權限讀取） |
| `/var/backups/tool-table/` | 每日備份 |
| `/etc/nginx/sites-available/tool-table` | nginx 站台（由腳本產生，請勿手改） |
| `/etc/systemd/system/tool-table*.service/.timer` | systemd 單元 |
| `/var/log/nginx/tool-table.*.log` | 存取 / 錯誤記錄 |
| `journalctl -u tool-table` | 應用程式記錄 |

## 8. 安全設計

- 應用程式只綁 `127.0.0.1`，唯一入口是 nginx
- HTTP 與「用 http:// 連 33443」都會 301 轉到 HTTPS
- TLS 1.2 / 1.3、只用 AEAD 加密套件
- 安全標頭：HSTS、CSP（只允許本站 script，不載入任何第三方 script）、X-Frame-Options、nosniff、Referrer-Policy、Permissions-Policy、COOP、CORP
- 時鐘向本伺服器校時（`/api/time`），不依賴外部服務；離線內網也能正常運作
- 隱藏版本：nginx `server_tokens off`，uvicorn 不送 Server 標頭
- 正式環境關閉 `/docs`、`/redoc`、`/openapi.json`
- 上傳的圖示（含 SVG）以 `sandbox` CSP 送出，無法執行 script；檔名經過驗證，無法寫出圖示目錄
- 寫入 API 以 nginx 限速（每 IP 每分鐘 120 次）；登入每 IP 每分鐘 10 次，應用程式另外鎖定連續失敗
- 整站需要登入（公開進度看板除外）：工作階段權杖只存雜湊值，Cookie 為 HttpOnly、Secure、SameSite=Lax；閒置 12 小時、最長 7 天失效
- 所有寫入 API 都要帶自訂標頭 `X-Tool-Table`（跨站表單無法加上），搭配 SameSite 防 CSRF
- 本機管理員密碼以 scrypt 雜湊；AD 密碼不落地，只用來向網域控制站驗證；空白密碼一律拒絕（避免 LDAP 匿名繫結）
- 權限在伺服器端檢查：使用者看不到、也改不了不屬於自己的卡片；只有管理員能指派、能改入口與後台
- systemd 沙箱：唯讀系統、只能寫 `/var/lib/tool-table`、無特權、限制系統呼叫

## 9. 疑難排解

| 狀況 | 處理 |
|------|------|
| 任何問題 | 先跑 `sudo bash /opt/tool-table/scripts/tool-table.sh doctor` |
| 網頁顯示 502 | 應用程式沒起來：`sudo journalctl -u tool-table -n 50 --no-pager` |
| 連不到 33443 | 確認雲端安全群組 / 外部防火牆有開 `33443/tcp` |
| 安裝時說埠被占用 | 用 `--https-port` / `--http-port` / `--app-port` 換一個 |
| 主機沒有 IPv6 | 安裝腳本會自動改成只監聽 IPv4 |
| 想讓 80 埠給別的服務用 | `install --http-port 0`，就不再監聽 HTTP |
