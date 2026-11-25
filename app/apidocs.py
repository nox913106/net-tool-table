"""
API documentation (Swagger UI at /docs, the OpenAPI document at /openapi.json).

The routes keep their English docstrings (they become each operation's description);
this module adds what a reader of the Swagger page needs: a Chinese one-line summary per
operation, Chinese groups (tags) in a sensible order, and how to authenticate.
"""
from typing import Optional

from fastapi.openapi.utils import get_openapi

INTRO = """\
IPMS 的所有 API。頁面上的「Try it out」會直接呼叫這台伺服器，**以你目前登入的身分執行**，
修改資料的操作會真的改到資料，請小心使用。

**驗證**
- 伺服器版：瀏覽器登入後的 session cookie（`tt_session`）。先在同一個瀏覽器登入 IPMS，再開這一頁。
- 單機版同步：`Authorization: Bearer <裝置權杖>`（只限 `/api/sync/`）。
- 所有會修改資料的呼叫（POST／PUT／DELETE）都必須帶 `X-Tool-Table: 1` 標頭，用來防止其他網站偽造請求。
  這一頁會自動加上；用 curl 或程式呼叫時要自己帶。

**權限**：與網頁相同。看不到的卡片回 404，沒有權限回 403，未登入回 401。

**日期**：`YYYY-MM-DD` 或 `YYYY-MM-DDTHH:MM`（伺服器當地時間）。
"""

# (tag, description) in the order they appear on the page
TAGS = [
    ("待辦看板", "卡片的新增、修改、刪除、排序、結案、卡住標記、搜尋與標籤"),
    ("子任務、留言與工時", "留言串、子任務（最多五層）、計時與工時紀錄"),
    ("專案與甘特圖", "專案分析（健康度、問題、人員負載、共用時段）、排序、甘特圖資料、基準線、順延、專案通知設定"),
    ("附件", "卡片與留言的圖片和文件"),
    ("Excel 報告", "工作進度報告的匯出與匯入"),
    ("通知", "🔔 通知清單與已讀"),
    ("登入與帳號", "登入、登出、目前使用者、變更密碼、帳號與權限、人員搜尋"),
    ("入口網站", "資料夾與連結（公用區與個人區）、搜尋"),
    ("快速連結", "首頁的快速連結"),
    ("圖示", "圖示庫：上傳、改名、刪除、自動抓取網站圖示"),
    ("設定與匯出", "外觀與看板設定、整站匯出／匯入"),
    ("系統設定", "AD／LDAP、登入安全、備份、HTTPS 憑證、網路（管理員）"),
    ("單機版同步", "伺服器端（裝置連結、推送、拉取、附件）與單機版端（連線、立即同步、衝突）"),
    ("本機程式", "Windows 單機版：讀取捷徑、啟動本機程式"),
    ("公開儀表板", "不需登入的部門工作統計"),
    ("其他", "健康檢查、伺服器時間、來源 IP"),
]

SUMMARY = {
    # 入口網站
    "GET /api/nodes": "最上層的資料夾與連結",
    "POST /api/nodes": "新增資料夾或連結（公用區，管理員）",
    "GET /api/nodes/tree": "完整樹狀結構（公用區＋我的個人區）",
    "GET /api/nodes/{node_id}": "取得一個資料夾或連結",
    "PUT /api/nodes/{node_id}": "修改資料夾或連結",
    "DELETE /api/nodes/{node_id}": "刪除資料夾或連結（含底下所有項目）",
    "GET /api/nodes/{node_id}/children": "資料夾底下的項目",
    "GET /api/nodes/code/{code}": "依編號取得（例如 3-2-1）",
    "PUT /api/nodes/reorder": "批次調整順序",
    "PUT /api/nodes/{node_id}/move": "移動到其他資料夾",
    "POST /api/my/nodes": "個人區：新增",
    "PUT /api/my/nodes/reorder": "個人區：調整順序",
    "PUT /api/my/nodes/{node_id}": "個人區：修改",
    "DELETE /api/my/nodes/{node_id}": "個人區：刪除",
    "PUT /api/my/nodes/{node_id}/move": "個人區：移動",
    "GET /api/search": "搜尋資料夾與連結",
    # 快速連結
    "GET /api/auth-links": "快速連結（依區域分組）",
    "POST /api/auth-links": "新增快速連結",
    "GET /api/auth-links/all": "所有快速連結（管理用清單）",
    "GET /api/auth-links/{link_id}": "取得一個快速連結",
    "PUT /api/auth-links/{link_id}": "修改快速連結",
    "DELETE /api/auth-links/{link_id}": "刪除快速連結",
    "GET /api/auth-links/regions/list": "所有區域名稱",
    # 圖示
    "GET /api/icons": "圖示庫清單",
    "POST /api/icons": "上傳圖示（同名會取代）",
    "DELETE /api/icons/{filename}": "刪除圖示",
    "PUT /api/icons/{filename}": "圖示改名（同時更新所有引用）",
    "POST /api/icons/fetch": "自動抓取網站圖示",
    # 設定與匯出
    "GET /api/settings": "讀取設定",
    "PUT /api/settings": "儲存設定",
    "GET /api/settings/defaults": "設定的預設值",
    "POST /api/settings/reset": "設定回復預設值",
    "GET /api/export": "整站匯出（設定、資料夾與連結、快速連結）",
    "POST /api/import": "整站匯入",
    # 本機程式
    "GET /api/local/status": "這個瀏覽器能不能使用本機程式",
    "POST /api/local/shortcut": "讀取捷徑（.lnk／.url）內容",
    "POST /api/local/resolve": "找出拖進來的檔案路徑",
    "POST /api/local/inspect": "檢查本機路徑",
    "POST /api/launch/{node_id}": "啟動本機程式",
    # 待辦看板
    "GET /api/tasks": "看得到的所有卡片",
    "POST /api/tasks": "新增卡片",
    "PUT /api/tasks/{task_id}": "修改卡片（只送要改的欄位）",
    "DELETE /api/tasks/{task_id}": "刪除卡片",
    "POST /api/tasks/reorder": "拖曳後的欄位與順序",
    "POST /api/tasks/sweep": "把過期的單次卡片移到「過期未結案」",
    "POST /api/tasks/{task_id}/complete": "結案（週期工作會排下一次）",
    "POST /api/tasks/{task_id}/blocked": "標記／解除卡住",
    "POST /api/tasks/{task_id}/collab/{user_id}/done": "協作人標記自己的部分完成",
    "GET /api/tasks/tags": "用過的標籤與次數",
    "GET /api/tasks/search": "搜尋卡片（標題、說明、留言、人員）",
    # 子任務、留言與工時
    "GET /api/tasks/{task_id}/comments": "留言串與子任務",
    "POST /api/tasks/{task_id}/comments": "新增留言或回覆",
    "PUT /api/tasks/{task_id}/comments/{comment_id}": "修改留言內容",
    "DELETE /api/tasks/{task_id}/comments/{comment_id}": "刪除留言（含回覆、附件、工時）",
    "PUT /api/tasks/{task_id}/comments/{comment_id}/task": "設為子任務／修改子任務欄位",
    "POST /api/tasks/{task_id}/subtasks": "新增子任務（可指定上層子任務）",
    "POST /api/tasks/{task_id}/subtasks/order": "子任務排序",
    "POST /api/tasks/{task_id}/comments/{comment_id}/timer": "開始／停止計時",
    "POST /api/tasks/{task_id}/comments/{comment_id}/time": "手動記錄工時",
    "PUT /api/tasks/{task_id}/comments/{comment_id}/time/{entry_id}": "修改一筆工時",
    "DELETE /api/tasks/{task_id}/comments/{comment_id}/time/{entry_id}": "刪除一筆工時",
    # 專案與甘特圖
    "GET /api/tasks/projects/analysis": "專案分析：健康度、問題、人員負載、共用時段",
    "POST /api/tasks/projects/order": "專案排序（看板管理員、部門管理員）",
    "GET /api/tasks/projects/suspected": "看起來像專案的一般卡",
    "POST /api/tasks/projects/events/run": "立刻送出今天的專案通知（管理員）",
    "GET /api/tasks/{task_id}/watch": "我在這個專案的通知模式",
    "PUT /api/tasks/{task_id}/watch": "設定我在這個專案的通知模式",
    "GET /api/tasks/gantt": "甘特圖資料（所有子任務與排程欄位）",
    "POST /api/tasks/{task_id}/baseline": "設定／清除基準線",
    "POST /api/tasks/shift": "多個項目一起順延 N 天",
    # 附件
    "POST /api/tasks/{task_id}/images": "上傳附件（圖片或文件）",
    "GET /api/tasks/{task_id}/images/{image_id}": "下載附件",
    "DELETE /api/tasks/{task_id}/images/{image_id}": "刪除附件",
    # Excel
    "POST /api/tasks/export.xlsx": "匯出工作進度報告",
    "POST /api/tasks/import.xlsx": "匯入報告（先預覽，再套用）",
    # 通知
    "GET /api/notifications": "我的通知",
    "POST /api/notifications/read": "標記已讀（不帶 ids＝全部）",
    # 登入與帳號
    "GET /api/auth/status": "是否需要登入、目前是否已登入",
    "POST /api/auth/login": "登入（AD 或本機帳號）",
    "POST /api/auth/logout": "登出",
    "GET /api/auth/me": "目前使用者與權限",
    "POST /api/auth/password": "變更本機帳號密碼",
    "GET /api/users": "帳號與權限清單（管理員）",
    "POST /api/users": "新增帳號（管理員）",
    "PUT /api/users/{user_id}": "修改帳號角色、上級、啟用（管理員）",
    "GET /api/people": "人員搜尋（已知帳號＋AD 目錄）",
    # 公開儀表板
    "GET /api/public/dashboard": "部門 › 帳號 › 狀態的工作統計（免登入）",
    # 系統設定
    "GET /api/system/ldap": "讀取 AD／LDAP 設定",
    "PUT /api/system/ldap": "儲存 AD／LDAP 設定",
    "POST /api/system/ldap/test": "測試 AD／LDAP 設定（不儲存）",
    "GET /api/system/security": "讀取登入安全設定",
    "PUT /api/system/security": "儲存登入安全設定",
    "GET /api/system/info": "系統資訊",
    "GET /api/system/backup": "讀取自動備份設定",
    "PUT /api/system/backup": "儲存自動備份設定",
    "POST /api/system/backups": "立即備份",
    "GET /api/system/backups/{name}": "下載備份檔",
    "DELETE /api/system/backups/{name}": "刪除備份檔",
    "POST /api/system/backups/{name}/restore": "從備份還原",
    "POST /api/system/backups/upload": "上傳備份檔",
    "GET /api/system/tls": "HTTPS 憑證資訊",
    "POST /api/system/tls": "更換 HTTPS 憑證",
    "GET /api/system/network": "讀取連接埠與主機名稱",
    "PUT /api/system/network": "修改連接埠與主機名稱",
    "GET /api/system/apply/{rid}": "系統變更的套用進度",
    # 單機版同步
    "GET /api/sync/wait": "等待變更（長輪詢）",
    "POST /api/sync/link": "單機版連結到伺服器（取得裝置權杖）",
    "POST /api/sync/unlink": "解除連結",
    "GET /api/sync/devices": "我連結的裝置",
    "DELETE /api/sync/devices/{device_id}": "移除一個裝置",
    "POST /api/sync/push": "上傳本機的修改",
    "POST /api/sync/pull": "下載伺服器的修改",
    "GET /api/sync/people": "人員搜尋（給單機版）",
    "PUT /api/sync/blob/{uid}": "上傳附件檔案",
    "GET /api/sync/blob/{uid}": "下載附件檔案",
    "PUT /api/sync/icon/{name}": "上傳個人區連結用的圖示",
    "GET /api/sync/client": "單機版：同步狀態",
    "POST /api/sync/client/connect": "單機版：連線到伺服器",
    "POST /api/sync/client/now": "單機版：立即同步",
    "POST /api/sync/client/disconnect": "單機版：中斷連線",
    "GET /api/sync/client/log": "單機版：同步紀錄與衝突",
    "POST /api/sync/client/resolve": "單機版：處理衝突",
    # 其他
    "GET /api/health": "健康檢查",
    "GET /api/time": "伺服器時間（毫秒）",
    "GET /api/whoami": "伺服器看到的來源 IP",
}

_ROUTER_TAG = {"nodes": "入口網站", "auth-links": "快速連結", "settings": "設定與匯出", "local": "本機程式",
               "auth": "登入與帳號", "dashboard": "公開儀表板", "system": "系統設定", "sync": "單機版同步"}


def _tag(method: str, path: str, old: Optional[list]) -> str:
    if path.startswith("/api/icons"):
        return "圖示"
    if path == "/api/search":
        return "入口網站"
    if path.startswith("/api/notifications"):
        return "通知"
    if path.startswith("/api/tasks"):
        if path.endswith((".xlsx",)):
            return "Excel 報告"
        if "/images" in path:
            return "附件"
        if "/projects" in path or path.endswith(("/gantt", "/baseline", "/shift", "/watch")):
            return "專案與甘特圖"
        if "/comments" in path or "/subtasks" in path:
            return "子任務、留言與工時"
        return "待辦看板"
    return _ROUTER_TAG.get((old or [""])[0], "其他")


INTRO_EN = """\
Every IPMS API. “Try it out” calls this server **as the account you are signed in with**;
calls that change data really change it.

**Authentication**
- Server edition: the session cookie (`tt_session`) of a browser sign-in. Sign in to IPMS in the same browser first.
- Standalone sync: `Authorization: Bearer <device token>` (only for `/api/sync/`).
- Every call that changes data (POST / PUT / DELETE) must send the `X-Tool-Table: 1` header, so other websites can't forge requests.
  This page adds it; add it yourself with curl or in code. `X-Lang: en` returns messages in English.

**Permissions**: the same as the web pages. A card you can't see answers 404, no permission 403, not signed in 401.

**Dates**: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` (server local time).
"""
TAGS_EN = {"待辦看板": ("Board", "Cards: create, change, delete, order, close, blocked, search and tags"),
           "子任務、留言與工時": ("Subtasks, comments & time", "Comment threads, subtasks (up to five levels), timers and time logs"),
           "專案與甘特圖": ("Projects & Gantt", "Project analysis (health, problems, people load, shared windows), ranking, Gantt data, baselines, shifting, project notifications"),
           "附件": ("Attachments", "Images and documents on cards and comments"),
           "Excel 報告": ("Excel report", "Export and import the progress report"),
           "通知": ("Notifications", "🔔 notifications and marking them read"),
           "登入與帳號": ("Sign-in & accounts", "Sign in and out, the current user, passwords, accounts and permissions, people search"),
           "入口網站": ("Portal", "Folders and links (public and personal areas), search"),
           "快速連結": ("Quick links", "The home page's quick links"),
           "圖示": ("Icons", "Icon library: upload, rename, delete, fetch site icons"),
           "設定與匯出": ("Settings & export", "Appearance and board settings, whole-site export / import"),
           "系統設定": ("System settings", "AD / LDAP, sign-in security, backups, HTTPS certificate, network (administrators)"),
           "單機版同步": ("Standalone sync", "Server side (device link, push, pull, files) and the standalone side (connect, sync now, conflicts)"),
           "本機程式": ("Local programs", "Windows standalone: read shortcuts, start local programs"),
           "公開儀表板": ("Public dashboard", "Work counts by department, no sign-in"),
           "其他": ("Other", "Health check, server time, client IP")}


def install(app, version: str):
    """Replace app.openapi with one that carries the summaries, groups and the intro (Chinese, or English for X-Lang: en)."""
    from . import i18n
    cache = {}

    def openapi():
        lang = i18n.lang()
        if lang in cache:
            return cache[lang]
        en = lang == "en"
        spec = get_openapi(title="IPMS API", version=version, description=INTRO_EN if en else INTRO, routes=app.routes)
        spec["tags"] = [{"name": TAGS_EN[n][0] if en else n, "description": TAGS_EN[n][1] if en else d} for n, d in TAGS]
        for path, ops in spec.get("paths", {}).items():
            for method, op in ops.items():
                key = f"{method.upper()} {path}"
                if en:
                    first = (op.get("description") or "").strip().split("\n")[0].strip()
                    if first:
                        op["summary"] = first[:120]
                elif key in SUMMARY:
                    op["summary"] = SUMMARY[key]
                tag = _tag(method, path, op.get("tags"))
                op["tags"] = [TAGS_EN[tag][0] if en else tag]
        spec["components"] = spec.get("components", {})
        spec["components"]["securitySchemes"] = {
            "session": {"type": "apiKey", "in": "cookie", "name": "tt_session", "description": "Browser sign-in session" if en else "瀏覽器登入後的 session"},
            "device": {"type": "http", "scheme": "bearer", "description": "Standalone device token (only /api/sync/)" if en else "單機版的裝置權杖（只限 /api/sync/）"},
        }
        spec["security"] = [{"session": []}, {"device": []}]
        cache[lang] = spec
        return spec
    app.openapi = openapi
