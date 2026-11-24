"""
Demo data for a test machine: 7 departments of made-up staff, a one-year data-centre rebuild project
and everyday cards, so the board, the projects pages, the radar and the public dashboard have
something realistic to show. Administrators load it from 備份與匯入 → 示範資料 and remove it there.

- The demo staff (source "demo") exist only in this database: they cannot sign in, and nothing is
  ever written to AD or Entra ID.
- Dates are laid out around today: start-up and design done, procurement under way, the rest ahead,
  with a few items late, waiting, on hold, blocked or cancelled.
- What was created is remembered (settings key `_demo_data`) and removed exactly.
- scripts/make_sample_project.py writes the same project as an Excel file for 匯入 Excel.
"""
import json
from datetime import date, timedelta
from typing import Dict, List, Optional

BASE = date(2026, 11, 24)          # the plan below is written as of this day and moved to today
STATE_KEY = "_demo_data"
TAG = "示範"

# username, name, department, manager (username)
PEOPLE = [
    ("demo.mgmt.kuo", "郭振華", "管理部", None),
    ("demo.mgmt.tseng", "曾惠如", "管理部", "demo.mgmt.kuo"),
    ("demo.pmo.liu", "劉冠廷", "專案管理部", "demo.mgmt.kuo"),
    ("demo.pmo.yang", "楊雅雯", "專案管理部", "demo.pmo.liu"),
    ("demo.site.chen", "陳建志", "現場部", "demo.mgmt.kuo"),
    ("demo.site.lin", "林雅婷", "現場部", "demo.site.chen"),
    ("demo.site.huang", "黃俊翔", "現場部", "demo.site.chen"),
    ("demo.net.wang", "王志明", "網路部", "demo.mgmt.kuo"),
    ("demo.net.chang", "張家豪", "網路部", "demo.net.wang"),
    ("demo.net.lee", "李佳穎", "網路部", "demo.net.wang"),
    ("demo.sec.tsai", "蔡明哲", "資安部", "demo.mgmt.kuo"),
    ("demo.sec.wu", "吳怡君", "資安部", "demo.sec.tsai"),
    ("demo.audit.hsu", "許淑芬", "稽核部", "demo.mgmt.kuo"),
    ("demo.audit.cheng", "鄭文彬", "稽核部", "demo.audit.hsu"),
    ("demo.acct.chou", "周美玲", "會計部", "demo.mgmt.kuo"),
    ("demo.acct.hsieh", "謝宗翰", "會計部", "demo.acct.chou"),
]
NAME = {u: n for u, n, _, _ in PEOPLE}
DEPTS = sorted({d for _, _, d, _ in PEOPLE})

D = date
# The project. num, title, who (short username), status, start, due, milestone, predecessors, estimate h, extra
#   extra: log = hours logged, note = latest progress (a comment), blocked = reason, prio = high
PROJECT = ("主機房改建專案", "設備採購 → 網路架構設計 → 施工 → 設定 → 分期驗收 → 總結驗收。跨現場、網路、資安、稽核、專案管理、會計與管理部。",
           "pmo.liu")
ROWS = [
    ("1", "啟動與需求盤點", "pmo.liu", None, None, None, False, None, None, {}),
    ("1.1", "專案啟動會議", "pmo.liu", "complete", None, D(2026, 9, 3), True, None, None, {}),
    ("1.2", "現況盤點：機櫃、設備、線路、電力負載", "site.chen", "complete", D(2026, 9, 4), D(2026, 9, 18), False, "1.1", 40, {"log": 46}),
    ("1.3", "需求訪談（各系統負責人、資安、稽核）", "pmo.yang", "complete", D(2026, 9, 7), D(2026, 9, 22), False, "1.1", 24, {"log": 20}),
    ("1.4", "委外現況調查（改為自行盤點）", "pmo.liu", "canceled", D(2026, 9, 7), D(2026, 9, 25), False, None, 16,
     {"note": "報價過高，管理部決議改由現場部自行盤點"}),
    ("1.5", "改建需求書定稿", "pmo.liu", "complete", D(2026, 9, 23), D(2026, 9, 29), False, "1.2、1.3", 16, {"log": 18}),
    ("1.6", "需求書核定", "mgmt.kuo", "complete", None, D(2026, 9, 30), True, "1.5", None, {}),

    ("2", "機房基礎設施設計", "site.chen", None, None, None, False, None, None, {}),
    ("2.1", "空間與機櫃配置設計（42U × 24 櫃）", "site.chen", "complete", D(2026, 10, 1), D(2026, 10, 16), False, "1.6", 24, {"log": 22}),
    ("2.2", "電力設計：UPS N+1、雙迴路 PDU", "site.huang", "complete", D(2026, 10, 5), D(2026, 10, 23), False, "1.6", 32, {"log": 36}),
    ("2.3", "電力設計技師簽證", "site.huang", "pending", D(2026, 10, 26), D(2026, 11, 27), False, "2.2", 4,
     {"note": "已送技師事務所，等簽證回函"}),
    ("2.4", "空調與冷熱通道設計", "site.lin", "complete", D(2026, 10, 12), D(2026, 10, 30), False, "2.1", 24, {"log": 25}),
    ("2.5", "消防（潔淨氣體）與環控監控設計", "site.lin", "ongoing", D(2026, 11, 2), D(2026, 11, 20), False, "2.1", 20,
     {"log": 14, "note": "消防廠商報價延遲，預計 11/27 補齊後定稿"}),
    ("2.6", "基礎設施設計審查", "mgmt.tseng", "complete", None, D(2026, 11, 13), True, "2.2、2.4", None, {}),

    ("3", "網路架構設計", "net.wang", None, None, None, False, None, None, {}),
    ("3.1", "架構評估：三層式 vs Spine-Leaf", "net.wang", "complete", D(2026, 10, 15), D(2026, 11, 6), False, "1.6", 32,
     {"log": 30, "note": "決議採 Spine-Leaf，核心雙機"}),
    ("3.2", "IP 位址與 VLAN 規劃", "net.chang", "ongoing", D(2026, 11, 9), D(2026, 12, 4), False, "3.1", 40, {"log": 18}),
    ("3.3", "路由設計：OSPF／BGP、閘道備援（VRRP）", "net.wang", "ongoing", D(2026, 11, 23), D(2026, 12, 11), False, "3.1", 32, {"log": 4}),
    ("3.4", "防火牆分區與安全政策設計", "sec.tsai", "new", D(2026, 12, 7), D(2026, 12, 16), False, "3.2", 32, {"prio": "high"}),
    ("3.5", "頻外管理網路（OOB）與 Console 設計", "net.lee", "new", D(2026, 12, 7), D(2026, 12, 15), False, "3.2", 16, {}),
    ("3.6", "資安需求對照（ISO 27001 控制項）", "audit.hsu", "new", D(2026, 12, 7), D(2026, 12, 16), False, "3.2", 12, {}),
    ("3.7", "網路架構設計審查", "mgmt.kuo", "new", None, D(2026, 12, 18), True, "3.3、3.4、3.5、3.6", None, {}),

    ("4", "設備採購", "pmo.yang", None, None, None, False, None, None, {}),
    ("4.1", "規格書：交換器、防火牆、無線", "net.wang", "ongoing", D(2026, 11, 9), D(2026, 11, 27), False, "3.1", 32,
     {"log": 22, "prio": "high"}),
    ("4.2", "規格書：機櫃、UPS、精密空調", "site.huang", "complete", D(2026, 11, 2), D(2026, 11, 20), False, "2.2、2.4", 24, {"log": 26}),
    ("4.3", "預算追加簽核", "acct.chou", "onhold", D(2026, 11, 23), D(2026, 12, 11), False, "4.2", 8,
     {"blocked": "年度預算追加需董事會核定，等 12/10 董事會", "prio": "high"}),
    ("4.4", "採購程序稽核（比價規則、利益迴避）", "audit.cheng", "new", D(2026, 12, 1), D(2026, 12, 11), False, None, 12, {}),
    ("4.5", "採購核准", "mgmt.kuo", "new", None, D(2026, 12, 15), True, "4.3、4.4", None, {}),
    ("4.6", "招標／比價", "pmo.yang", "new", D(2026, 12, 16), D(2027, 1, 20), False, "4.5", 24, {}),
    ("4.7", "決標與簽約", "mgmt.tseng", "new", D(2027, 1, 21), D(2027, 2, 5), False, "4.6", 8, {}),
    ("4.8", "簽約款（30%）付款", "acct.chou", "new", D(2027, 2, 8), D(2027, 2, 12), False, "4.7", 4, {}),
    ("4.9", "設備交貨與點收", "site.chen", None, None, None, False, None, None, {}),
    ("4.9.1", "網路與資安設備到貨點收（序號、授權）", "net.lee", "new", D(2027, 2, 8), D(2027, 2, 26), False, "4.7（+2 天）", 16, {}),
    ("4.9.2", "機櫃、UPS、空調到貨點收", "site.chen", "new", D(2027, 2, 8), D(2027, 2, 26), False, "4.7（+2 天）", 12, {}),
    ("4.9.3", "財產登錄與標籤", "acct.hsieh", "new", D(2027, 3, 1), D(2027, 3, 5), False, "4.9.1、4.9.2", 8, {}),

    ("5", "機房施工", "site.chen", None, None, None, False, None, None, {}),
    ("5.1", "遷移計畫與停機公告", "pmo.liu", "new", D(2027, 3, 1), D(2027, 3, 12), False, "4.9.2", 16, {}),
    ("5.2", "架高地板與機櫃施工", "site.chen", "new", D(2027, 3, 15), D(2027, 4, 2), False, "5.1", 24, {}),
    ("5.3", "電力與 UPS 安裝、負載測試", "site.huang", "new", D(2027, 3, 22), D(2027, 4, 9), False, "5.2（-12 天）", 24, {"prio": "high"}),
    ("5.4", "精密空調安裝與溫濕度測試", "site.lin", "new", D(2027, 3, 29), D(2027, 4, 16), False, "5.2（-6 天）", 16, {}),
    ("5.5", "結構化佈線：光纖主幹、銅纜、標籤", "net.lee", "new", D(2027, 4, 5), D(2027, 4, 23), False, "5.2", 40, {}),
    ("5.6", "施工期間門禁與人員進出管制", "sec.wu", "new", D(2027, 3, 15), D(2027, 4, 30), False, "5.1", 12, {}),
    ("5.7", "施工完成", "mgmt.tseng", "new", None, D(2027, 4, 30), True, "5.3、5.4、5.5", None, {}),

    ("6", "網路建置與設定", "net.wang", None, None, None, False, None, None, {}),
    ("6.1", "核心交換器上架、韌體與基本設定", "net.wang", "new", D(2027, 4, 12), D(2027, 4, 23), False, "4.9.1、5.3", 32, {"prio": "high"}),
    ("6.2", "匯聚／存取交換器設定（VLAN、Trunk、LACP）", "net.chang", "new", D(2027, 4, 26), D(2027, 5, 14), False, "6.1、3.2", 48, {}),
    ("6.3", "防火牆設定與政策匯入", "sec.tsai", "new", D(2027, 4, 26), D(2027, 5, 21), False, "6.1、3.4", 48, {"prio": "high"}),
    ("6.4", "路由與高可用設定（OSPF、VRRP、鏈路備援）", "net.wang", "new", D(2027, 5, 17), D(2027, 5, 28), False, "6.2", 32, {}),
    ("6.5", "無線控制器與 AP 設定", "net.lee", "new", D(2027, 5, 24), D(2027, 6, 4), False, "6.2", 24, {}),
    ("6.6", "網管監控接入：SNMP、Syslog、NetFlow", "net.chang", "new", D(2027, 5, 31), D(2027, 6, 11), False, "6.4", 24, {}),
    ("6.7", "資安監控接入（SIEM、告警規則）", "sec.wu", "new", D(2027, 5, 31), D(2027, 6, 11), False, "6.3", 24, {}),
    ("6.8", "設定備份、拓撲圖與設定文件", "net.lee", "new", D(2027, 6, 7), D(2027, 6, 15), False, "6.4、6.5", 16, {}),

    ("7", "分期驗收", "pmo.liu", None, None, None, False, None, None, {}),
    ("7.1", "第一期：基礎設施驗收", "site.chen", None, None, None, False, None, None, {}),
    ("7.1.1", "UPS 斷電切換與電池放電測試", "site.huang", "new", D(2027, 5, 3), D(2027, 5, 7), False, "5.7", 8, {}),
    ("7.1.2", "空調備援與溫濕度 72 小時記錄", "site.lin", "new", D(2027, 5, 3), D(2027, 5, 12), False, "5.7", 8, {}),
    ("7.1.3", "驗收見證與紀錄", "audit.hsu", "new", D(2027, 5, 10), D(2027, 5, 13), False, "7.1.1", 6, {}),
    ("7.1.4", "第一期驗收", "mgmt.tseng", "new", None, D(2027, 5, 14), True, "7.1.2、7.1.3", None, {}),
    ("7.2", "第二期：網路功能驗收", "net.wang", None, None, None, False, None, None, {}),
    ("7.2.1", "備援切換測試（核心、上行、防火牆 HA）", "net.wang", "new", D(2027, 6, 16), D(2027, 6, 23), False, "6.8", 16, {}),
    ("7.2.2", "效能測試：吞吐量、延遲、封包遺失", "net.chang", "new", D(2027, 6, 16), D(2027, 6, 25), False, "6.8", 16, {}),
    ("7.2.3", "弱點掃描與政策稽核", "sec.tsai", "new", D(2027, 6, 21), D(2027, 6, 28), False, "6.7", 16, {}),
    ("7.2.4", "第二期驗收", "mgmt.kuo", "new", None, D(2027, 6, 30), True, "7.2.1、7.2.2、7.2.3", None, {}),
    ("7.2.5", "第二期款（40%）付款", "acct.chou", "new", D(2027, 7, 1), D(2027, 7, 9), False, "7.2.4", 4, {}),
    ("7.3", "第三期：系統遷移與驗收", "pmo.liu", None, None, None, False, None, None, {}),
    ("7.3.1", "第一批遷移：非關鍵系統", "net.chang", "new", D(2027, 7, 1), D(2027, 7, 9), False, "7.2.4", 24, {}),
    ("7.3.2", "第二批遷移：核心業務系統（週末停機窗口）", "net.wang", "new", D(2027, 7, 12), D(2027, 7, 24), False, "7.3.1", 40, {"prio": "high"}),
    ("7.3.3", "遷移後觀察期與問題處理", "site.lin", "new", D(2027, 7, 26), D(2027, 7, 29), False, "7.3.2", 16, {}),
    ("7.3.4", "第三期驗收", "mgmt.kuo", "new", None, D(2027, 7, 30), True, "7.3.3", None, {}),

    ("8", "總結驗收與結案", "pmo.liu", None, None, None, False, None, None, {}),
    ("8.1", "竣工文件：圖說、設備清冊、設定檔彙整", "pmo.yang", "new", D(2027, 8, 2), D(2027, 8, 13), False, "7.3.4", 24, {}),
    ("8.2", "維運交接與教育訓練", "net.lee", "new", D(2027, 8, 9), D(2027, 8, 20), False, "7.3.4", 16, {}),
    ("8.3", "舊機房設備除役與資料抹除", "site.chen", "new", D(2027, 8, 9), D(2027, 8, 24), False, "7.3.4", 24, {}),
    ("8.4", "資料抹除見證與紀錄", "sec.wu", "new", D(2027, 8, 20), D(2027, 8, 24), False, "8.3（-5 天）", 6, {}),
    ("8.5", "結案稽核", "audit.cheng", "new", D(2027, 8, 16), D(2027, 8, 24), False, "8.1", 16, {}),
    ("8.6", "總結驗收會議", "pmo.liu", "new", D(2027, 8, 25), D(2027, 8, 26), False, "8.2、8.3、8.5", 8, {}),
    ("8.7", "總結驗收", "mgmt.kuo", "new", None, D(2027, 8, 27), True, "8.6", None, {}),
    ("8.8", "尾款（30%）付款與財產轉正", "acct.hsieh", "new", D(2027, 8, 30), D(2027, 8, 31), False, "8.7", 6, {}),
    ("8.9", "結案報告與經驗回顧", "pmo.liu", "new", D(2027, 8, 30), D(2027, 8, 31), False, "8.7", 8, {}),
]

# Everyday cards: who, title, status, due (days from today; None = no date), priority, belongs to the project, extra
OPS = [
    ("site.chen", "每月機房巡檢紀錄", "ongoing", 3, "normal", False, {}),
    ("site.chen", "機房門禁卡清查", "overdue", -3, "normal", True, {}),
    ("site.lin", "舊機房冷氣濾網更換", "new", 9, "low", False, {}),
    ("site.huang", "舊機房臨時電源檢修", "complete", -6, "high", False, {}),
    ("net.wang", "分公司 VPN 斷線排查", "ongoing", 1, "high", False, {"note": "已確認是 ISP 線路問題，等中華電信派工"}),
    ("net.chang", "DHCP 範圍擴充（3F 辦公區）", "complete", -2, "normal", False, {}),
    ("net.lee", "無線網路訊號調查（會議室）", "pending", 4, "normal", False, {}),
    ("net.lee", "舊機房交換器韌體升級", "onhold", 20, "normal", False, {"blocked": "新機房完成前不升級，避免雙重停機"}),
    ("sec.tsai", "防火牆規則年度檢視", "pending", 6, "high", False, {}),
    ("sec.wu", "EDR 告警調校", "overdue", -5, "normal", False, {}),
    ("sec.wu", "年度社交工程演練", "new", 30, "normal", False, {}),
    ("audit.hsu", "年度 IT 內部控制查核", "ongoing", 12, "high", False, {}),
    ("audit.cheng", "機房存取紀錄抽查", "new", 8, "normal", True, {}),
    ("audit.cheng", "供應商資安評核", "pending", 2, "normal", False, {}),
    ("pmo.liu", "專案週報（機房改建）", "ongoing", 2, "normal", True, {"note": "本週重點：預算追加卡在董事會、消防設計延遲"}),
    ("pmo.yang", "風險登錄表更新", "ongoing", 5, "normal", True, {}),
    ("pmo.yang", "專案溝通計畫", "complete", -20, "normal", True, {}),
    ("acct.chou", "資本支出預算編列（2027）", "ongoing", 7, "high", True, {}),
    ("acct.hsieh", "設備折舊年限與財產分類", "new", 21, "normal", True, {}),
    ("acct.hsieh", "年度採購預算對帳", "pending", -1, "normal", False, {}),
    ("mgmt.kuo", "機房改建專案月會", "ongoing", 9, "high", True, {}),
    ("mgmt.kuo", "年度資訊策略會議", "new", 35, "normal", False, {}),
    ("mgmt.tseng", "資訊人力配置調整", "onhold", 40, "normal", False, {"blocked": "等年度組織調整公告"}),
]


def shift_days(today: Optional[date] = None) -> int:
    return ((today or date.today()) - BASE).days


def moved(d: Optional[date], n: int) -> Optional[str]:
    return (d + timedelta(days=n)).isoformat() if d else None


def parse_deps(text: Optional[str]):
    """'4.7（+2 天）、5.2' → [('4.7', 2), ('5.2', 0)]"""
    import re
    out = []
    for m in re.finditer(r"(\d+(?:\.\d+)*)(?:\s*（\s*([+-]?\d+)\s*天\s*）)?", text or ""):
        out.append((m.group(1), int(m.group(2) or 0)))
    return out


async def status(db) -> dict:
    cur = await db.execute("SELECT value FROM settings WHERE key = ?", (STATE_KEY,))
    r = await cur.fetchone()
    st = json.loads(r[0]) if r else None
    return {"loaded": bool(st), "tasks": len(st["tasks"]) if st else 0, "people": len(st["users"]) if st else 0,
            "departments": DEPTS}


async def load(db, actor_id: Optional[int] = None, today: Optional[date] = None) -> dict:
    """Create everything (one transaction). Refuses when it is already loaded."""
    from .routes import tasks as T
    if (await status(db))["loaded"]:
        raise ValueError("示範資料已經建立過了，要重建請先移除")
    today = today or date.today()
    n = shift_days(today)
    # ---- people
    uid = {}
    for username, name, dept, _ in PEOPLE:
        cur = await db.execute("SELECT id, source FROM users WHERE username = ?", (username,))
        r = await cur.fetchone()
        if r and r["source"] != "demo":
            raise ValueError(f"帳號 {username} 已經存在且不是示範帳號，無法建立示範資料")
        if r:
            uid[username] = r["id"]
            await db.execute("UPDATE users SET display_name = ?, department = ?, active = 1 WHERE id = ?", (name, dept, r["id"]))
        else:
            cur = await db.execute("""INSERT INTO users (username, source, display_name, department, role, active)
                                      VALUES (?, 'demo', ?, ?, 'user', 1)""", (username, name, dept))
            uid[username] = cur.lastrowid
    for username, _, _, boss in PEOPLE:
        if boss:
            await db.execute("UPDATE users SET manager_id = ?, manager_source = 'manual' WHERE id = ?", (uid[boss], uid[username]))
    who = lambda short: uid["demo." + short]
    created = []
    tags = json.dumps([TAG, "機房改建"], ensure_ascii=False)
    # ---- the project card
    title, desc, lead = PROJECT
    cur = await db.execute("SELECT COALESCE(MAX(rank), 0) + 1 FROM tasks WHERE kind = 'project'")
    rank = (await cur.fetchone())[0]
    cur = await db.execute("""INSERT INTO tasks (title, description, status, priority, owner_id, kind, rank, tags)
                              VALUES (?, ?, 'new', 'high', ?, 'project', ?, ?)""", (title, desc, who(lead), rank, tags))
    pid = cur.lastrowid
    created.append(pid)
    await db.execute("INSERT OR IGNORE INTO task_members (task_id, user_id, role) VALUES (?, ?, 'assignee')", (pid, who(lead)))
    # ---- its tree
    ids, order = {}, {}
    for num, t, w, st, start, due, ms, deps, est, extra in ROWS:
        parent = ids.get(num.rsplit(".", 1)[0]) if "." in num else None
        key = parent or 0
        order[key] = order.get(key, -1) + 1
        status_ = st or "new"
        done_day = moved(due or start, n) if status_ == "complete" else None
        cur = await db.execute("""INSERT INTO task_comments (task_id, user_id, body, is_task, title, status, start_at, due_at, assignee_id,
                                                             estimate_minutes, sort_order, task_parent_id, milestone, priority, completed_at)
                                  VALUES (?, ?, '', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                               (pid, who(lead), t, status_, None if ms else moved(start, n), moved(due, n), who(w),
                                int(est * 60) if est else None, order[key], parent, 1 if ms else 0, extra.get("prio", "normal"), done_day))
        ids[num] = cur.lastrowid
        if extra.get("log"):
            day = moved(due or start, n) if status_ == "complete" else (today - timedelta(days=1)).isoformat()
            await db.execute("""INSERT INTO task_time (task_id, comment_id, user_id, minutes, note, work_date) VALUES (?, ?, ?, ?, ?, ?)""",
                             (pid, ids[num], who(w), int(extra["log"] * 60), "示範工時", day))
        if extra.get("note"):
            await db.execute("INSERT INTO task_comments (task_id, user_id, body, parent_id) VALUES (?, ?, ?, ?)",
                             (pid, who(w), extra["note"], ids[num]))
    # predecessors (by uid, as the app stores them)
    for num, *_rest in ROWS:
        deps = _rest[6]
        if not deps:
            continue
        out = []
        for ref, lag in parse_deps(deps):
            cur = await db.execute("SELECT uid FROM task_comments WHERE id = ?", (ids[ref],))
            out.append({"u": (await cur.fetchone())[0], "lag": lag})
        await db.execute("UPDATE task_comments SET deps = ? WHERE id = ?", (json.dumps(out), ids[num]))
    # roll-ups: deepest groups first, then the card
    groups = sorted({num.rsplit(".", 1)[0] for num, *_ in ROWS if "." in num}, key=lambda x: -x.count("."))
    for g in groups:
        await T.rollup_subtask(db, ids[g])
        await T.rollup_dates(db, pid, ids[g])
    await T.rollup_dates(db, pid, None)
    await T._sync_subtask_members(db, pid)
    await T.rollup_status(db, pid)
    # the blocked item: its card is the project — show it on the project card (cards carry the 卡住 flag)
    reasons = [e["blocked"] for *_x, e in ROWS if e.get("blocked")]
    if reasons:
        await db.execute("UPDATE tasks SET blocked_at = ?, blocked_reason = ?, blocked_by = ? WHERE id = ?",
                         ((today - timedelta(days=4)).isoformat(), "預算追加簽核：" + reasons[0], who("acct.chou"), pid))
    # baseline = the plan as it was approved (so slips show)
    await db.execute("""UPDATE task_comments SET base_start = start_at, base_due = due_at WHERE task_id = ?""", (pid,))
    await db.execute("UPDATE tasks SET base_start = start_at, base_due = due_at WHERE id = ?", (pid,))
    # the budget hold pushed procurement and everything after it by a week: the approved plan was a week earlier
    later = [ids[num] for num, *_r in ROWS if num.split(".")[0] in ("4", "5", "6", "7", "8") and _r[2] != "complete"]
    await db.execute(f"""UPDATE task_comments SET base_start = date(base_start, '-7 days'), base_due = date(base_due, '-7 days')
                         WHERE id IN ({','.join('?' * len(later))})""", later)
    await db.execute("UPDATE tasks SET base_due = date(base_due, '-7 days') WHERE id = ?", (pid,))
    # ---- everyday cards
    for k, (w, t, st, due, prio, linked, extra) in enumerate(OPS):
        d = (today + timedelta(days=due)).isoformat() if due is not None else None
        cur = await db.execute("""INSERT INTO tasks (title, status, priority, due_at, owner_id, kind, project_id, tags, sort_order, completed_at,
                                                     blocked_at, blocked_reason, blocked_by)
                                  VALUES (?, ?, ?, ?, ?, 'ops', ?, ?, ?, ?, ?, ?, ?)""",
                               (t, st, prio, d, who(w), pid if linked else None, json.dumps([TAG], ensure_ascii=False), k,
                                d if st == "complete" else None,
                                (today - timedelta(days=3)).isoformat() if extra.get("blocked") else None, extra.get("blocked"),
                                who(w) if extra.get("blocked") else None))
        cid = cur.lastrowid
        created.append(cid)
        await db.execute("INSERT OR IGNORE INTO task_members (task_id, user_id, role) VALUES (?, ?, 'assignee')", (cid, who(w)))
        if extra.get("note"):
            await db.execute("INSERT INTO task_comments (task_id, user_id, body) VALUES (?, ?, ?)", (cid, who(w), extra["note"]))
    # ---- the public dashboard's trend lines: 7 earlier weeks for the demo departments
    from .routes.dashboard import snapshot
    await snapshot(db, force=True)
    cur = await db.execute(f"SELECT dept, status, n FROM dash_snap WHERE day = ? AND dept IN ({','.join('?' * len(DEPTS))})",
                           (date.today().isoformat(), *DEPTS))
    now = {}
    for r in await cur.fetchall():
        now.setdefault(r[0], {})[r[1]] = r[2]
    drift = {"overdue": 1, "complete": -1, "new": 1, "ongoing": 0, "pending": 0, "onhold": 0, "canceled": 0}
    for k, dept in enumerate(DEPTS):
        vals = {s: now.get(dept, {}).get(s, 0) for s in drift}
        for w in range(1, 8):
            day = (date.today() - timedelta(days=7 * w)).isoformat()
            for s in vals:
                step = drift[s] if (w + k) % 2 else 0
                if s in ("ongoing", "pending") and (w + k) % 3 == 0:
                    step = 1 if w % 2 else -1
                vals[s] = max(0, vals[s] + step)
                await db.execute("INSERT OR REPLACE INTO dash_snap (day, dept, status, n) VALUES (?, ?, ?, ?)", (day, dept, s, vals[s]))
    state = {"tasks": created, "users": list(uid.values()), "at": today.isoformat()}
    await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (STATE_KEY, json.dumps(state)))
    return {"tasks": len(created), "items": len(ROWS), "people": len(uid), "departments": len(DEPTS)}


async def remove(db) -> dict:
    """Delete what load() created: its cards (with their subtasks, comments, time), the demo staff, their trend rows."""
    cur = await db.execute("SELECT value FROM settings WHERE key = ?", (STATE_KEY,))
    r = await cur.fetchone()
    if not r:
        return {"tasks": 0, "people": 0}
    st = json.loads(r[0])
    tasks = [int(i) for i in st.get("tasks", [])]
    users = [int(i) for i in st.get("users", [])]
    if tasks:
        await db.execute(f"DELETE FROM tasks WHERE id IN ({','.join('?' * len(tasks))})", tasks)
    gone = 0
    for u in users:
        cur = await db.execute("SELECT source FROM users WHERE id = ?", (u,))
        row = await cur.fetchone()
        if row and row[0] == "demo":
            await db.execute("UPDATE users SET manager_id = NULL WHERE manager_id = ?", (u,))
            await db.execute("DELETE FROM users WHERE id = ?", (u,))
            gone += 1
    await db.execute(f"DELETE FROM dash_snap WHERE dept IN ({','.join('?' * len(DEPTS))})", DEPTS)
    await db.execute("DELETE FROM settings WHERE key = ?", (STATE_KEY,))
    return {"tasks": len(tasks), "people": gone}
