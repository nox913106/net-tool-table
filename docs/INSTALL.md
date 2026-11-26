# IPMS 安裝與運維 SOP

適用：在一台**全新、空白的 Linux** 上部署 IPMS。
架構：nginx 以 HTTPS（預設 **443**）對外，反向代理到只綁 `127.0.0.1` 的應用程式，
應用程式的服務埠不對外開放；HTTP（80）一律轉到 HTTPS。預設使用自簽憑證。

```
瀏覽器 ──http://主機/───────────► nginx :80     ─301─► https://主機/
瀏覽器 ──https://主機/───► nginx :443  (TLS、安全標頭)
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
| 對外埠 | `443/tcp`（HTTPS）、`80/tcp`（只做轉址，可關閉） |

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
7. 設定 nginx：`443` HTTPS 反向代理、`80` 轉 HTTPS；停用 nginx 預設站台
8. 若 `ufw` / `firewalld` 已啟用，自動開放 `443/tcp` 與 `80/tcp`
9. 確認服務真的有回應後，印出入口網址

完成時會顯示：

```
  入口      https://<伺服器IP>/
  管理後台  https://<伺服器IP>/admin
```

### 2.3 安裝選項

選項放在 `bash -s --` 後面：

```bash
curl -fsSL https://raw.githubusercontent.com/nox913106/net-tool-table/main/scripts/bootstrap.sh \
  | sudo bash -s -- --https-port 443 --fqdn portal.example.com
```

| 選項 | 預設 | 說明 |
|------|------|------|
| `--https-port N` | `443` | 對外 HTTPS 埠 |
| `--http-port N` | `80` | 只做轉址的 HTTP 埠；`0` = 不開 HTTP |
| `--app-port N` | `8080` | 應用程式埠（只綁 127.0.0.1，不對外） |
| `--fqdn 名稱` | 空（接受任何主機名稱） | nginx `server_name` 與自簽憑證的 CN |

環境變數：`TOOL_TABLE_BRANCH`（預設 `main`）、`TOOL_TABLE_REPO`、`TOOL_TABLE_DIR`（預設 `/opt/tool-table`）。

已經裝好之後要改埠號，直接再跑一次 install 即可（設定與資料都會保留）：

```bash
sudo bash /opt/tool-table/scripts/tool-table.sh install --https-port 443 --http-port 80
```

### 2.4 第一次使用

1. 瀏覽 `https://<伺服器IP>/`，瀏覽器會警告自簽憑證，確認後繼續
2. 用安裝結束時印出的**本機管理員**（`localadmin` ＋ 密碼）登入，第一次登入會要求設定新密碼
3. 照第 2.5 節在後台設定 AD，並在「帳號管理」把至少一位 AD 帳號勾上「＋系統管理」；之後平常都用 AD 帳號
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
| 系統設定 → AD 驗證 → AD 登入 | 網域控制站（ldaps:// / ldap:// + StartTLS）、Base DN、服務帳號與密碼（加密保存）、網域（UPN 後綴，例如 `ad.rallytech.com.tw`：登入頁會在帳號後面自動帶入 `@網域`，本機帳號不加；不用服務帳號時也用它登入）、只允許某群組、屬性名稱、內部 CA 憑證（直接貼上）、逾時。**「測試」按鈕**可用表單內容（不必先儲存）測試服務帳號、目錄搜尋與某個帳號的實際登入 |
| 系統設定 → AD 驗證 → Microsoft Entra ID 登入 | 租用戶 ID、應用程式 ID、用戶端密碼（加密保存）、重新導向 URI、只允許某些群組、登入時更新姓名部門上級、Entra 目錄搜尋；**「測試」按鈕**檢查租用戶、密碼與目錄權限 |
| 系統設定 → 發送與通知 | Teams 頻道（Workflow 網址，加密保存）、每個頻道要收哪些通知與哪些卡片、訊息語言、狀態報告時間、告警門檻；**測試**、**立即送出狀態報告**、目前的系統狀態 |
| 系統設定 → AD 驗證 → 登入安全 | 閒置登出時間、最長登入天數、密碼連續錯誤鎖定（次數 / 分鐘）、每個來源 IP 上限 |
| 系統設定 → HTTPS 憑證 | 目前憑證資訊與到期天數；貼上或選擇正式憑證（fullchain）與私鑰套用；重新產生自簽憑證 |
| 系統設定 → HTTPS 憑證 → 連線埠與名稱 | HTTPS 埠、HTTP 埠（0 = 不開）、伺服器名稱（FQDN） |
| 系統設定 → 備份還原 | 完整備份（每週哪幾天、幾點）、增量備份（每幾小時）、保留天數、立即備份、下載、上傳備份檔、還原 |
| 系統設定 → 帳號管理 | 指定等級（看板總管理者 RW / RO、部門看板管理者 RW / RO、使用者、訪客）與附加的「＋系統管理」與管理部門；新登入的 AD 帳號是「訪客」，在這裡開通、停用帳號、預先加入 AD 帳號 |
| 系統設定 → 系統狀態 | 健康檢查表（每項正常／注意／失敗與修正方式）、立即檢查、最近的維護工作、安裝時決定的項目 |
| 系統設定 → 稽核紀錄 | 查詢、匯出 CSV、保存天數（180–3650 天） |
| 系統設定 → 系統資訊 | 硬體、作業系統、服務、套件；下載 JSON |
| 系統設定 → 版本紀錄 | 目前版本、GitHub 上的新版、升級到最新版、全部版本 |

| 權限 | 後台 | 看板：看得到 | 看板：可編輯 / 刪除 / 指派 |
|------|------|--------------|----------------------------|
| 本機管理員 `localadmin` | 全部（緊急用，平常不用） | 所有卡片 | 所有卡片 |
| 看板總管理者（RW） | — | 所有卡片 | 所有卡片 |
| 看板總管理者（RO） | — | 所有部門的卡片（詳細內容） | 只有自己的卡片；其他卡片可以留言 |
| 部門看板管理者（RW） | — | 管理部門的卡片 ＋ 自己的 | 管理部門的卡片（只能指派該部門的人）＋ 自己的 |
| 部門看板管理者（RO） | — | 管理部門的卡片 ＋ 自己的 | 只有自己的卡片；其他卡片可以留言 |
| 使用者 | — | 自己建立、被指派、被 @ 的卡片 | 同左（不能指派） |
| ＋ 系統管理（附加，使用者以上皆可） | 全部設定與查詢 | 不增加，依原本的等級 | 不增加，依原本的等級 |
| 訪客（AD／Entra ID 帳號第一次登入的預設） | — | 只有入口的公用連結；頁面上方提示聯絡系統管理員 | 無（看板、專案、個人區、單機版連線都要開通後才能用） |

卡片屬於「建立者」與「負責人」所在的部門（AD 的 `department`）。部門看板管理者預設管理自己的部門，
可在「帳號管理」勾選要管理的其他部門。系統要求**至少保留一位 AD 帳號有系統管理**。

**系統管理是附加身分，不是等級**：使用者以上的任何等級（訪客除外）都可以另外賦予「系統管理」，成為「等級＋系統管理」的多重身分，
例如「使用者＋系統管理」「部門看板管理者（RW）＋系統管理」。系統管理只能操作後台的設定與查詢（系統狀態、AD 驗證、帳號管理、稽核紀錄、備份還原…），
不增加看板權限：看板上看得到、能改什麼仍依原本的等級。升級時，原本的「系統管理者」自動轉成「看板總管理者（RW）＋系統管理」（看板權限不變），
不需要看全部卡片的人請在「帳號管理」把等級調低。
本機管理員第一次登入必須改成自己的密碼；AD 帳號第一次登入時自動建立為「訪客」（只能看入口連結，畫面上方提示聯絡系統管理員），到「帳號管理」把權限改成「使用者」或以上才算開通。

**第一次設定 AD 的順序**

1. 用本機管理員登入，設定新密碼
2. 系統設定 → AD 登入：填伺服器、Base DN、服務帳號，按「測試」（可同時輸入一組帳號密碼測試登入）
3. 測試全部打勾後，打開「啟用 AD 登入」並儲存
4. 請一位同事用 AD 帳號登入一次，再到「帳號管理」給他適當的等級並勾上「＋系統管理」（有服務帳號時也可以直接用「加入」預先建立）；其他人依需要設為看板 / 部門看板管理者

- 帳號可以輸入 `alice`、`CORP\alice` 或 `alice@corp.local`；姓名取自 `displayName`、部門取自 `department`（公開進度看板依部門分組），每次登入時更新
- 憑證與連線埠的變更由伺服器上的 `tool-table-apply.path` 套用：網頁服務本身沒有 root 權限，它只留下變更要求，由這個系統服務檢查內容（憑證與私鑰是否成對、埠號是否被占用）後套用；nginx 不接受時自動還原
- 服務帳號密碼以 AES-256-GCM 加密保存，金鑰在 `/var/lib/tool-table/.secret.key`（安裝時自動產生，僅服務帳號可讀；備份會一併帶上）

**公開進度看板** `https://<伺服器>/dashboard`：不需登入、唯讀、只顯示數量（不顯示任何卡片標題或內容，不含週期工作），每 15 秒自動更新：

- 各狀態卡片數與近 8 週趨勢、到期（已過到期日／今天／3 天內／7 天內）、每人一條狀態色條
- 專案進度（預設只顯示「專案 A、B…」與進度，可改為顯示名稱或不顯示）、人員負載（每人每週預估工時）、系統狀態燈號（預設關閉，只顯示正常／注意／異常）
- 網址：`/dashboard` 總覽；`/dashboard?rotate=1` 總覽與各部門輪流顯示（大老闆模式，`&sec=30` 指定每頁秒數）；
  `/dashboard?dept=資訊部` 只看一個部門（部門主管模式）；加 `&tv=1` 為壁掛模式（字體放大、隱藏按鈕、大時鐘）

- 工作範圍：全部工作／一般維運／某一個專案（網址 `&scope=ops`、`&scope=project:12`）；選專案時統計的是它最下層的工作項目與歸屬它的卡片
- 每個資訊都能點：狀態數字（只看這個狀態，`&status=`）、部門名稱（鎖定部門）、人名（個人摘要：各狀態、到期、每週工時）、專案（只看這個專案）；
  旁邊的 ↗ 在看板開啟同一批卡片（`/#/board?dept=…&user=…&status=…&kind=…`），需要登入，依看板權限顯示

在「外觀與設定 → 公開進度看板」設定公開哪些項目、輪播秒數，或整個關閉。趨勢線每小時記錄一次各部門的數量，新安裝的系統累積兩週以上才會出現。

**緊急狀況**（例如 AD 故障又忘了本機管理員密碼）才需要登入伺服器：

```bash
sudo bash /opt/tool-table/scripts/tool-table.sh reset-admin
```

> 從沒有帳號功能的舊版執行 `upgrade` 時，會自動開啟登入並建立本機管理員（密碼印在畫面上，也存在 `initial-admin.txt`）。
> 舊版寫在設定檔的 `TOOL_TABLE_LDAP_*` 仍然有效，第一次在後台儲存 AD 設定後就以後台為準。

### 2.6 Microsoft Entra ID 登入（選用）

和 AD 登入可以同時使用：登入頁多一個「以 Microsoft 帳號登入」按鈕，用公司的 Microsoft 帳號（含多重要素驗證）登入。

1. Entra 系統管理中心 →「應用程式註冊」→「新增註冊」：名稱例如 IPMS；支援的帳戶類型選「僅此組織目錄中的帳戶」
2. 重新導向 URI 選「Web」，填 `https://<伺服器>:<埠>/api/auth/entra/callback`（後台「系統設定 → AD 驗證 → Microsoft Entra ID 登入」會顯示這台伺服器的正確網址，可按「複製」）
3. 「憑證與祕密」→ 新增用戶端密碼，複製「值」
4. 「API 權限」保留 Microsoft Graph 的 `User.Read`（委派）即可。要在看板 @ 或指派還沒登入過的人，另外加 `User.Read.All`（**應用程式**權限）並由系統管理員同意
5. 只讓特定群組登入：在「權杖設定」加上 groups 宣告，或授與 `GroupMember.Read.All`；在後台填群組的物件 ID
6. 後台填入租用戶 ID、應用程式 ID、用戶端密碼，按「測試」，全部打勾後啟用並儲存

- **帳號對應**：混合式環境中，內部部署帳號名稱（sAMAccountName）和現有 AD 帳號相同的人，登入後就是同一個帳號（權限、卡片都一樣）；只有雲端帳號的人，以 UPN `@` 前面的部分建立新帳號，預設為「使用者」
- **只讀取**：登入時從 Microsoft Graph 讀姓名、部門、信箱與上級；**不會寫入 Entra ID 或 AD**
- **單機版**：Microsoft 帳號沒有可以輸入的密碼，單機版連線時改按「改用瀏覽器登入」：在瀏覽器登入並確認代碼後按「允許連結」，單機版就連上了（AD 帳號也可以這樣做）
- 伺服器要能連到 `login.microsoftonline.com` 與 `graph.microsoft.com`（HTTPS 443）
- 用戶端密碼有到期日，到期前在 Entra 建立新的並到後台更換

### 2.7 Microsoft Teams 通知與系統告警（選用）

1. 在 Teams 頻道的「⋯」→「工作流程」，新增「收到 webhook 要求時張貼到頻道」（Post to a channel when a webhook request is received），複製它產生的網址
2. 後台「系統設定 → 發送與通知」→「新增頻道」，貼上網址，勾選要送哪些通知，按「測試」，再儲存

| 通知 | 內容 |
|------|------|
| 卡片與專案的變更 | 同一張卡片一分鐘內的修改合成一則：「欄位：原本 → 現在」與修改的人，含新增／刪除子任務、留言、負責人變更；單機版同步上來的修改也算。範圍：只有專案（含歸屬卡片）／所有卡片／指定的專案 |
| 每日專案事件 | 落後基準線、跨專案前置延誤、時段衝突、3 天內到期的里程碑（和系統內的專案通知相同） |
| 系統與硬體告警 | 磁碟空間、記憶體、CPU 負載、溫度（主機有感測器時）、軟體 RAID、重新開機、自動備份、HTTPS 憑證到期、nginx、AD 與 Entra ID 連線、資料庫檢查；異常時、持續異常時（每隔幾小時提醒）與恢復時各通知一次 |
| 定時系統狀態報告 | 每天指定時間（預設 08:30、17:30）送出所有檢查結果與磁碟用量；可設定全部正常時不送 |

- 不需要 Entra ID 應用程式；Workflow 網址等同密碼，加密保存，存檔後不再顯示
- 訊息語言預設跟網站預設語言，也可以指定繁體中文或英文；訊息裡的連結預設用伺服器名稱與連接埠，可以另外指定
- 伺服器要能連到 Workflow 網址的主機（通常是 `*.logic.azure.com` 或 `*.environment.api.powerplatform.com`，HTTPS 443）
- 傳送失敗會自動重試三次；最近一次結果顯示在設定頁

### 2.7.1 AI 接入點（選用）

後台「系統設定 → AI 接入點」新增 AI 服務。**地端**（Ollama、vLLM、LM Studio、llama.cpp、LocalAI、公司 AI 閘道）只要這台伺服器連得到該主機的埠（例如 `http://ai-host:11434/v1`）；
**雲端**服務需要能連到對方的 API（例如 `api.anthropic.com`、`api.openai.com`、`generativelanguage.googleapis.com`、`<資源>.openai.azure.com`、`bedrock-runtime.<區域>.amazonaws.com`），
並在後台打開「允許使用雲端服務」。每個服務先按「測試」確認連線，再到「測試台」比較回答。呼叫 Claude 用官方 `anthropic` 套件（已列在 requirements.txt，升級時自動安裝）。

**AiPM（AI 專案經理）**：同一頁下方的「AiPM」區塊。預設啟用、每日巡檢 08:30（伺服器本機時間）。
「每日對齊」（預設開啟）在巡檢時間私訊每個手上有進行中工作的人，不呼叫 AI；結案對齊的偵測每 10 分鐘一次，也不呼叫 AI。
AiPM 的每一項變更都要專案負責人或看板管理人（看板總管理者 RW、所屬部門的部門看板管理者 RW）核准；通知只送給相關、而且看得到該卡片的帳號。
工程師貼的截圖只會送給勾選「可看圖片」的服務，而且預設只送地端；要送雲端，另外打開「允許把截圖送到雲端服務」。
背景檢視每 10 分鐘看一次哪些進行中的專案有變動（同一專案最多每 30 分鐘一次）；每次檢視是一次 AI 呼叫，用量記在「用量紀錄」（用途 `aipm_*`）。

### 2.8 介面語言

繁體中文與英文。每個人用頁首的「中／EN」切換，會記在自己的帳號；網站預設語言在「外觀與設定」選（繁體中文、英文或跟隨瀏覽器）。
錯誤訊息、通知、Excel 報告與 API 文件都會跟著語言；卡片、留言等使用者輸入的內容不會被翻譯。

### 2.9 上下級

- **自動**：「系統設定 → AD 登入 → 進階」的「從 AD 同步上級」預設開啟，讀 AD 的 `manager` 屬性（需要服務帳號），使用者每次登入時更新。
- **手動**：「帳號管理」的「上級」欄點一下就能指定；手動指定的不會被 AD 覆蓋，按「改回依 AD」恢復。不能把自己或自己的下級設為上級。
- **權限**：「外觀與設定 → 待辦看板 → 上級對下級卡片的權限」：可編輯（預設：瀏覽、留言、增刪修、指派給下級）／檢視＋留言／不分享。下級可以多層。

### 2.10 端對端檢查

```bash
# 健檢：每一項失敗都會印出修法（→ 開頭那行）
sudo bash /opt/tool-table/scripts/tool-table.sh doctor
```

```bash
# HTTP 應回 301 並轉到 https://…/
curl -sI http://127.0.0.1/ | grep -iE '^(HTTP|location)'
```

```bash
# 服務埠只能出現在 127.0.0.1
sudo ss -ltnp | grep -E ':(80|8080|443) '
```

```bash
# 安全標頭（每個應只出現一次，Server 不含版本）
curl -skI https://127.0.0.1/ | grep -iE 'strict-transport|content-security|x-frame|^server'
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

**從網頁升級**（v19.0.0 起）：後台「系統設定 → 版本紀錄」列出 GitHub 上比目前新的版本與內容，系統管理員按「升級到最新版」，
`tool-table-upgrade.path` 會以 root 執行 `tool-table.sh web-upgrade`，做的事和上面的指令完全相同（先備份），頁面顯示進度與升級記錄
（`/var/lib/tool-table-upgrade/`），完成後自動重新載入；每次升級都記在「稽核紀錄」。這個服務隨升級安裝，所以**第一次仍要在主機用指令升級一次**。

- 預設 HTTPS 埠已改為 **443**（網址不必再帶埠號）。仍使用舊預設 `33443` 的伺服器，升級時若 443 沒有被其他程式占用會自動改到 443
  並開放防火牆；被占用則維持原埠並提示。要用其他埠可在後台「系統設定 → HTTPS 憑證」修改。
- 新增「訪客」等級：升級後第一次登入的 AD／Entra ID 帳號是訪客，只能看入口連結；已經存在的帳號維持原本的權限。

---

## 5. 備份與還原

在後台「備份與匯入 → 自動備份」設定兩種排程（預設：每週日 03:30 完整備份、每 6 小時增量備份、保留 14 天）：

| 種類 | 內容 |
|---|---|
| 完整備份（`…-full.tar.gz`） | 資料庫一致性快照（帳號、看板、連結、設定）、加密金鑰、所有圖示、所有看板／留言附件（圖片、PDF、Office、文字檔…） |
| 增量備份（`…-inc.tar.gz`） | 每次都有**完整的資料庫**與金鑰；檔案只存上次備份後新增或變更的 |

- 每份備份都有清單（manifest）：當下**每一個檔案**的大小與 SHA-256，以及它存在哪一份備份裡；資料庫的附件紀錄（`task_images`、同步中的檔案）就是靠檔名對到這些檔案。
- 每次備份都會**檢查資料庫 ↔ 檔案**：資料庫完整性、每個附件紀錄都有對應的檔案；有缺漏時備份結果標「警告」，系統告警也會提醒。
- 還原增量備份時，自動從它需要的較早備份補齊檔案，**逐一核對檢查碼**後才換上；還原前會先完整備份一次目前的狀態。
- 下載增量備份時，會把它和需要的較早備份合成一份完整的檔案（可以直接上傳到別台還原）。
- 超過保留天數的備份會刪除，但還有增量備份需要的會保留；有增量備份依賴的完整備份，刪除前會提醒。
- 也可以「立即完整備份」「立即增量備份」。備份存在 `/var/lib/tool-table/backups/`；下載的備份檔含有解密金鑰，請妥善保管。

**示範資料**（測試機用）：「備份與匯入 → 示範資料 → 建立示範資料」會建立 7 個部門的 16 位示範人員（帳號 `demo.*`，只存在 IPMS 資料庫、不能登入、不會寫入 AD）、
一年期的主機房改建專案與各部門日常卡片（標籤 `#示範`），公開進度看板也會有近 8 週的趨勢；「移除示範資料」只刪除它建立的東西。

另外，「備份與匯入」的「匯出 / 匯入」可以把設定、連結、快速連結與看板卡片匯出成一個 JSON，適合搬家或分享範本（不含帳號、加密設定與圖示檔）。

伺服器另有系統層級的每日備份（`tool-table-backup.timer`，存在 `/var/backups/tool-table/`，與資料目錄分開）：
內容與後台的完整備份相同（同一套程式產生、同樣檢查），另外加一份主機設定 `…-host.tar.gz`（`/etc/tool-table`：設定、TLS 憑證與金鑰；nginx 站台設定），整台主機重建時使用：

```bash
sudo bash /opt/tool-table/scripts/tool-table.sh backup
```

```bash
sudo bash /opt/tool-table/scripts/tool-table.sh restore /var/backups/tool-table/tool-table-YYYYmmdd-HHMMSS-full.tar.gz
```

```bash
sudo bash /opt/tool-table/scripts/tool-table.sh restore /var/backups/tool-table/tool-table-YYYYmmdd-HHMMSS-host.tar.gz
```

舊版腳本做的備份（`tool-table-YYYYmmdd-HHMMSS.tar.gz`）也一樣可以還原。

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
| `/var/lib/tool-table/upgrade_request/` | 後台「升級到最新版」的要求（`tool-table-upgrade.path` 看到就升級，內容不採用） |
| `/var/lib/tool-table-upgrade/` | 網頁升級的狀態與記錄（root 寫入，服務只能讀） |
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
- HTTP 與「用 http:// 連 HTTPS 埠」都會 301 轉到 HTTPS
- TLS 1.2 / 1.3、只用 AEAD 加密套件
- 安全標頭：HSTS、CSP（只允許本站 script，不載入任何第三方 script）、X-Frame-Options、nosniff、Referrer-Policy、Permissions-Policy、COOP、CORP
- 時鐘向本伺服器校時（`/api/time`），不依賴外部服務；離線內網也能正常運作
- 隱藏版本：nginx `server_tokens off`，uvicorn 不送 Server 標頭
- API 文件（Swagger UI `/docs`、`/openapi.json`）預設只開放給管理員；`/etc/tool-table/tool-table.env` 設 `TOOL_TABLE_API_DOCS=off` 可完全關閉
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
| 連不到 443 | 確認雲端安全群組 / 外部防火牆有開 `443/tcp` |
| 安裝時說埠被占用 | 用 `--https-port` / `--http-port` / `--app-port` 換一個 |
| 主機沒有 IPv6 | 安裝腳本會自動改成只監聽 IPv4 |
| 想讓 80 埠給別的服務用 | `install --http-port 0`，就不再監聽 HTTP |
