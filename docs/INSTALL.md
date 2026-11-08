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
2. 用安裝結束時印出的**本機管理員**（`localadmin` ＋ 密碼）登入；密碼也存在 `/etc/tool-table/initial-admin.txt`（僅 root 可讀）
3. 照第 2.6 節設定 AD，再到後台「帳號與權限」指定至少一位 AD 管理員；之後平常都用 AD 帳號
4. 首頁是空的，點「前往管理後台新增 →」或開啟 `/admin`
5. 在「外觀與設定」設定網站名稱、首頁、快速連結等
6. 在「內容」建立資料夾與連結；或在「備份與匯入」匯入現成的 JSON 範本

**安裝成 App（Chrome / Edge）**：入口頁頁首右上角會出現「安裝」按鈕（或網址列右側的安裝圖示），
裝好後就是獨立視窗，有自己的開始功能表與工作列圖示。
自簽憑證下瀏覽器不信任此網站，按鈕不會出現；這時可用瀏覽器選單
「投放、儲存及分享 → 建立捷徑…」並勾選「以視窗開啟」，效果相同。
想要完整的 App 功能（離線時顯示上次的畫面），請讓用戶端信任這張憑證
（把 `/etc/tool-table/tls/server.crt` 匯入「受信任的根憑證授權單位」，或用 AD 群組原則派送），或換成正式憑證（第 3 節）。

### 2.6 帳號與 AD 登入

伺服器版整站都需要登入（只有公開進度看板 `/dashboard` 不用）。

| 角色 | 怎麼來 | 能做什麼 |
|------|--------|----------|
| 本機管理員 `localadmin` | 安裝時建立，密碼只印一次 | 最高權限，**平常不用**，留作 AD 故障時的緊急入口 |
| 管理員 | 在後台「帳號與權限」把 AD 帳號設為管理員 | 看得到所有看板卡片，可新增、刪除、修改、指派；可編輯入口與後台 |
| 使用者 | AD 帳號第一次登入時自動建立（預設） | 只看得到自己建立、被指派或被 @ 的卡片，可以編輯；入口只能瀏覽 |

系統要求**至少保留一位 AD 管理員**（最後一位不能被降級或停用）。

**設定 AD**：編輯 `/etc/tool-table/tool-table.env`，填入 `TOOL_TABLE_LDAP_*`（範本裡有說明）：

```bash
TOOL_TABLE_LDAP_URL=ldaps://dc1.corp.local
TOOL_TABLE_LDAP_BASE_DN=DC=corp,DC=local
# 建議：唯讀服務帳號（才能在看板 @ 還沒登入過的同事、在後台預先加入帳號）
TOOL_TABLE_LDAP_BIND_DN=CN=svc-tooltable,OU=Service Accounts,DC=corp,DC=local
TOOL_TABLE_LDAP_BIND_PASSWORD=服務帳號密碼
# 或不使用服務帳號：TOOL_TABLE_LDAP_DOMAIN=corp.local（以 帳號@網域 登入）
# 只允許某個群組登入（選用）：
# TOOL_TABLE_LDAP_USER_FILTER=(memberOf=CN=ToolTable-Users,OU=Groups,DC=corp,DC=local)
```

```bash
sudo systemctl restart tool-table
```

```bash
# 測試連線與服務帳號
sudo bash /opt/tool-table/scripts/tool-table.sh ldap-check
```

```bash
# 實際用某個帳號登入看看（會詢問密碼），並顯示讀到的姓名與部門
sudo bash /opt/tool-table/scripts/tool-table.sh ldap-test alice
```

- 帳號可以輸入 `alice`、`CORP\alice` 或 `alice@corp.local`
- 姓名取自 `displayName`、部門取自 `department`（公開進度看板依部門分組），每次登入時更新
- 建議用 `ldaps://`（636）；網域控制站若用內部 CA 簽發，設定 `TOOL_TABLE_LDAP_CA_FILE=/etc/tool-table/ad-ca.pem`
- 停用的帳號會立刻被登出；連續輸錯密碼會暫時鎖定（同帳號 15 分鐘內 8 次），nginx 另外限制每個 IP 每分鐘 10 次登入

**忘記本機管理員密碼**：

```bash
sudo bash /opt/tool-table/scripts/tool-table.sh reset-admin
```

```bash
# 列出所有帳號與權限
sudo bash /opt/tool-table/scripts/tool-table.sh users
```

**公開進度看板** `https://<伺服器>:33443/dashboard`：不需登入、唯讀，依「部門 → 帳號 → 狀態」顯示卡片數量，
不顯示任何卡片內容，不含週期工作；每 15 秒自動更新，適合放在牆上的螢幕。可在後台「外觀與設定」關閉。

> 從沒有帳號功能的舊版執行 `upgrade` 時，會自動開啟登入並建立本機管理員（密碼印在畫面上，也存在 `initial-admin.txt`）。

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
| `/etc/tool-table/tool-table.env` | 設定（埠號、路徑、備份保留天數、AD 連線） |
| `/etc/tool-table/initial-admin.txt` | 本機管理員密碼（安裝 / reset-admin 時寫入，僅 root 可讀，記下後可刪除） |
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
