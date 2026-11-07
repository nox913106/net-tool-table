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
2. 首頁是空的，點「前往管理後台新增 →」或開啟 `/admin`
3. 在「⚙️ 系統設定」設定網站名稱、首頁、快速連結等
4. 在「📂 節點」建立資料夾與連結；或在「💾 匯出入」匯入現成的 JSON 範本

**安裝成 App（Chrome / Edge）**：入口頁頁首右上角會出現「安裝」按鈕（或網址列右側的安裝圖示），
裝好後就是獨立視窗，有自己的開始功能表與工作列圖示。
自簽憑證下瀏覽器不信任此網站，按鈕不會出現；這時可用瀏覽器選單
「投放、儲存及分享 → 建立捷徑…」並勾選「以視窗開啟」，效果相同。
想要完整的 App 功能（離線時顯示上次的畫面），請讓用戶端信任這張憑證
（把 `/etc/tool-table/tls/server.crt` 匯入「受信任的根憑證授權單位」，或用 AD 群組原則派送），或換成正式憑證（第 3 節）。

> ⚠️ 目前管理後台與 API **沒有登入驗證**，能連到 33443 的人都能修改內容。
> 請只在內網開放，或在防火牆限制可連入的來源網段。

### 2.5 端對端檢查

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

憑證路徑固定為 `/etc/tool-table/tls/server.crt`、`server.key`，覆蓋後重新載入 nginx：

```bash
sudo cp fullchain.pem /etc/tool-table/tls/server.crt
sudo cp privkey.pem   /etc/tool-table/tls/server.key
sudo chmod 600 /etc/tool-table/tls/server.key
sudo nginx -t && sudo systemctl reload nginx
```

`server.crt` 請放含中繼憑證的 fullchain。之後執行 upgrade **不會**覆蓋你的憑證。

重新產生自簽憑證（例如主機改了 IP）：

```bash
sudo bash /opt/tool-table/scripts/tool-table.sh renew-cert
```

---

## 4. 升級

```bash
sudo bash /opt/tool-table/scripts/tool-table.sh upgrade
```

流程：`git pull` → 備份 → 更新 Python 套件 → 更新 systemd / nginx 設定 → 重啟 → 確認有回應。
設定檔、資料庫、圖示、憑證都會保留。

---

## 5. 備份與還原

每天 02:37 自動備份到 `/var/backups/tool-table/`（保留 14 天，可在設定檔調整），
內容為 SQLite 資料庫的一致性快照、所有圖示與設定檔。

```bash
# 立即備份
sudo bash /opt/tool-table/scripts/tool-table.sh backup
```

```bash
# 還原（會先自動備份目前狀態）
sudo bash /opt/tool-table/scripts/tool-table.sh restore /var/backups/tool-table/tool-table-YYYYmmdd-HHMMSS.tar.gz
```

另外，後台「💾 匯出 / 匯入」可以把設定、節點、快速連結匯出成一個 JSON，適合搬家或分享範本（不含圖示檔）。

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
| `/etc/tool-table/tool-table.env` | 設定（埠號、路徑、備份保留天數） |
| `/etc/tool-table/tls/` | `server.crt`、`server.key` |
| `/var/lib/tool-table/tool-table.db` | SQLite 資料庫 |
| `/var/lib/tool-table/icons/` | 圖示（後台上傳的也在這裡） |
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
- 寫入 API 以 nginx 限速（每 IP 每分鐘 120 次）
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
