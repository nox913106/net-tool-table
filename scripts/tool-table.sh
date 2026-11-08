#!/usr/bin/env bash
# =============================================================================
# Tool Table — single entry-point deployment tool (Debian / Ubuntu)
#
# Usage:
#   tool-table.sh install   [--https-port 33443] [--http-port 80|0] [--app-port 8080]
#                           [--fqdn portal.example.com]
#   tool-table.sh upgrade   [--no-pull]
#   tool-table.sh uninstall [--purge] [--yes]
#   tool-table.sh doctor
#   tool-table.sh backup    [--quiet]
#   tool-table.sh restore   <backup-file.tar.gz>
#   tool-table.sh renew-cert
#   tool-table.sh apply-request          (run by tool-table-apply.path) apply a certificate /
#                                        port change requested from the admin UI
#   tool-table.sh reset-admin            new password for the local break-glass admin
#   tool-table.sh users                  list accounts and roles
#   tool-table.sh ldap-check             test the AD connection / service account
#   tool-table.sh ldap-test <account>    try an AD sign-in (asks for the password)
#   tool-table.sh help
#
# Layout:
#   /opt/tool-table                 source (git) + .venv
#   /etc/tool-table/tool-table.env  settings (ports, paths, AD / LDAP)
#   /etc/tool-table/initial-admin.txt  local admin password from install / reset-admin (root only)
#   /etc/tool-table/tls/            server.crt / server.key (self-signed by default)
#   /var/lib/tool-table/            tool-table.db + icons/   (service user: tooltable)
#   /var/backups/tool-table/        daily backups (systemd timer)
#
# Network:
#   app   → 127.0.0.1:<app-port> only (never exposed)
#   nginx → :<https-port> TLS reverse proxy; :<http-port> redirects to https
# =============================================================================
set -euo pipefail

APP_USER="tooltable"
APP_DIR="${TOOL_TABLE_DIR:-/opt/tool-table}"
ETC_DIR="/etc/tool-table"
ENV_FILE="$ETC_DIR/tool-table.env"
TLS_DIR="$ETC_DIR/tls"
DATA_DIR_DEFAULT="/var/lib/tool-table"
BACKUP_DIR_DEFAULT="/var/backups/tool-table"
VENV="$APP_DIR/.venv"

NGINX_SITE="/etc/nginx/sites-available/tool-table"
NGINX_LINK="/etc/nginx/sites-enabled/tool-table"
NGINX_SNIPPETS="/etc/nginx/snippets"
UNIT_DIR="/etc/systemd/system"

DEFAULT_HTTPS_PORT=33443
DEFAULT_HTTP_PORT=80
DEFAULT_APP_PORT=8080

# ---------------------------------------------------------------- helpers ---
log()  { echo -e "\033[1;32m[tool-table]\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*" >&2; }
die()  { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }

require_root() { [[ $EUID -eq 0 ]] || die "請用 root 執行（sudo）"; }

script_dir() { cd "$(dirname "${BASH_SOURCE[0]}")" && pwd; }

# Read KEY from the env file (empty if missing)
env_get() {
    [[ -f "$ENV_FILE" ]] || { echo ""; return; }
    sed -n "s/^$1=//p" "$ENV_FILE" | tail -n1
}

# Set KEY=VALUE in the env file (add or replace)
env_set() {
    local key="$1" value="$2"
    if grep -q "^$key=" "$ENV_FILE" 2>/dev/null; then
        sed -i "s|^$key=.*|$key=$value|" "$ENV_FILE"
    else
        echo "$key=$value" >> "$ENV_FILE"
    fi
}

# Run "python -m app.cli ..." as the service user with the service's settings
app_cli() {
    runuser -u "$APP_USER" -- bash -c 'cd "$1" && set -a && . "$2" && set +a && shift 2 && exec "$0" -m app.cli "$@"' \
        "$VENV/bin/python" "$APP_DIR" "$ENV_FILE" "$@"
}

ADMIN_NOTE=""
# Create the local break-glass admin once; keep a generated password in a root-only file
ensure_local_admin() {
    local out
    out="$(app_cli local-admin 2>&1)" || { warn "$out"; return 1; }
    if grep -q "密碼：" <<<"$out"; then
        install -m 0600 -o root -g root /dev/null "$ETC_DIR/initial-admin.txt"
        { echo "# Tool Table 本機管理員（緊急用）— $(date '+%F %T')"; echo "$out"; } > "$ETC_DIR/initial-admin.txt"
        ADMIN_NOTE="$out"
    fi
}

valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && (( $1 >= 0 && $1 <= 65535 )); }

# Who is listening on a TCP port (empty if free)
port_owner() {
    ss -Hltnp "sport = :$1" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -n1
}

# "Service started" is not "service is answering": poll until an HTTP status comes back.
wait_until_serving() {
    local url="$1" timeout="${2:-60}" waited=0 code
    while (( waited < timeout )); do
        code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || echo 000)"
        [[ "$code" =~ ^[1-4] ]] && return 0
        sleep 2; waited=$((waited + 2))
    done
    return 1
}

primary_ip() { hostname -I 2>/dev/null | awk '{print $1}'; }

check_os() {
    [[ -r /etc/os-release ]] || die "找不到 /etc/os-release，無法判斷作業系統"
    # shellcheck disable=SC1091
    . /etc/os-release
    command -v apt-get >/dev/null || die "只支援 Debian / Ubuntu（需要 apt）"
    case "${ID}:${VERSION_ID:-}" in
        debian:12|debian:13|ubuntu:22.04|ubuntu:24.04|ubuntu:26.04) ;;
        *) warn "未測試的系統：${PRETTY_NAME:-$ID}（支援 Debian 12/13、Ubuntu 22.04/24.04/26.04），繼續安裝…" ;;
    esac
}

# ------------------------------------------------------------- rendering ---
render_nginx() {
    local https_port="$1" http_port="$2" app_port="$3" fqdn="$4"
    local src="$APP_DIR/deploy/nginx"
    local server_name="${fqdn:-_}"

    install -d -m 0755 "$NGINX_SNIPPETS"
    install -m 0644 "$src/tool-table-headers.conf" "$NGINX_SNIPPETS/tool-table-headers.conf"
    install -m 0644 "$src/tool-table-proxy.conf"   "$NGINX_SNIPPETS/tool-table-proxy.conf"

    local tmp; tmp="$(mktemp)"
    sed -e "s/__HTTPS_PORT__/$https_port/g" \
        -e "s/__HTTP_PORT__/$http_port/g" \
        -e "s/__APP_PORT__/$app_port/g" \
        -e "s/__SERVER_NAME__/$server_name/g" \
        "$src/tool-table.conf" > "$tmp"
    if [[ "$http_port" == "0" ]]; then
        # No HTTP listener at all
        sed -i '/#__HTTP_BLOCK_START__/,/#__HTTP_BLOCK_END__/d' "$tmp"
    fi
    if [[ ! -e /proc/net/if_inet6 ]]; then
        # IPv6 disabled in the kernel: nginx would refuse to start on [::]
        warn "此主機未啟用 IPv6，nginx 只監聽 IPv4"
        sed -i '/listen \[::\]:/d' "$tmp"
    fi
    install -m 0644 "$tmp" "$NGINX_SITE"
    rm -f "$tmp"
    ln -sfn "$NGINX_SITE" "$NGINX_LINK"

    # The distro default site also claims port 80 as default_server
    if [[ "$http_port" == "80" && -L /etc/nginx/sites-enabled/default ]]; then
        log "停用 nginx 預設站台（/etc/nginx/sites-enabled/default，原檔仍在 sites-available）"
        rm -f /etc/nginx/sites-enabled/default
    fi

    nginx -t >/dev/null 2>&1 || { nginx -t; die "nginx 設定檢查失敗"; }
}

install_units() {
    install -m 0644 "$APP_DIR/deploy/systemd/tool-table.service"        "$UNIT_DIR/tool-table.service"
    install -m 0644 "$APP_DIR/deploy/systemd/tool-table-backup.service" "$UNIT_DIR/tool-table-backup.service"
    install -m 0644 "$APP_DIR/deploy/systemd/tool-table-backup.timer"   "$UNIT_DIR/tool-table-backup.timer"
    install -m 0644 "$APP_DIR/deploy/systemd/tool-table-apply.path"     "$UNIT_DIR/tool-table-apply.path"
    install -m 0644 "$APP_DIR/deploy/systemd/tool-table-apply.service"  "$UNIT_DIR/tool-table-apply.service"
    # Request drop box for the admin UI (certificate / ports); the marker tells the app it is served
    install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR_DEFAULT/requests"
    install -m 0644 -o root -g root /dev/null "$DATA_DIR_DEFAULT/requests/.helper"
    systemctl daemon-reload
    systemctl enable --now tool-table-apply.path >/dev/null 2>&1 || true
}

setup_python() {
    log "建立 Python 虛擬環境：$VENV"
    [[ -x "$VENV/bin/python" ]] || python3 -m venv "$VENV"
    "$VENV/bin/pip" install --quiet --upgrade pip
    "$VENV/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"
    # Pre-compile as root: the service runs with a read-only /opt
    "$VENV/bin/python" -m compileall -q "$APP_DIR/app" >/dev/null || true
}

open_firewall() {
    local https_port="$1" http_port="$2"
    if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
        log "ufw 已啟用：開放 ${https_port}/tcp$( [[ "$http_port" != 0 ]] && echo " 與 ${http_port}/tcp")"
        ufw allow "${https_port}/tcp" >/dev/null
        [[ "$http_port" != 0 ]] && ufw allow "${http_port}/tcp" >/dev/null
    fi
    if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
        log "firewalld 已啟用：開放 ${https_port}/tcp"
        firewall-cmd --permanent --add-port="${https_port}/tcp" >/dev/null
        [[ "$http_port" != 0 ]] && firewall-cmd --permanent --add-port="${http_port}/tcp" >/dev/null
        firewall-cmd --reload >/dev/null
    fi
    return 0
}

print_summary() {
    local https_port="$1" http_port="$2" fqdn="$3" ip
    ip="$(primary_ip)"
    local host="${fqdn:-${ip:-<伺服器IP>}}"
    echo
    echo "=============================================================="
    echo "  Tool Table 已就緒"
    echo "--------------------------------------------------------------"
    echo "  入口      https://${host}:${https_port}/"
    echo "  管理後台  https://${host}:${https_port}/admin"
    [[ "$http_port" != 0 ]] && \
    echo "  HTTP      http://${host}$( [[ "$http_port" != 80 ]] && echo ":$http_port")/  → 自動轉到 HTTPS"
    echo
    if [[ "$(env_get TOOL_TABLE_AUTH)" =~ ^(1|true|yes|on)$ ]]; then
    echo
    echo "  整站需要登入（公開進度看板 https://${host}:${https_port}/dashboard 除外）"
    if [[ -n "$ADMIN_NOTE" ]]; then
    echo "  ---- 本機管理員（最高權限，平常不用）----"
    sed 's/^/  /' <<<"$ADMIN_NOTE"
    echo "  （也存在 $ETC_DIR/initial-admin.txt，僅 root 可讀；第一次登入改完密碼後可刪除）"
    fi
    echo
    echo "  接下來都在網頁後台完成，不需要再登入這台伺服器："
    echo "    1. 用本機管理員登入，設定自己的密碼"
    echo "    2. 後台「系統設定」：AD 登入（可先測試再儲存）、HTTPS 憑證、連線埠"
    echo "    3. 後台「帳號與權限」：至少指定一位 AD 帳號為管理員"
    fi
    echo
    echo "  憑證為自簽，瀏覽器第一次會警告，確認後即可使用。"
    echo "  換正式憑證：覆蓋 $TLS_DIR/server.crt 與 server.key 後 systemctl reload nginx"
    echo "  健檢：     sudo bash $APP_DIR/scripts/tool-table.sh doctor"
    echo "=============================================================="
}

# --------------------------------------------------------------- install ---
cmd_install() {
    local https_port="" http_port="" app_port="" fqdn="" fqdn_set=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --https-port) https_port="$2"; shift 2 ;;
            --http-port)  http_port="$2"; shift 2 ;;
            --app-port)   app_port="$2"; shift 2 ;;
            --fqdn)       fqdn="$2"; fqdn_set=1; shift 2 ;;
            *) die "未知參數：$1（見 help）" ;;
        esac
    done
    require_root
    check_os
    [[ -f "$APP_DIR/app/main.py" ]] || die "$APP_DIR 不是 Tool Table 原始碼目錄（請用 bootstrap.sh 安裝）"

    # Values: argument > existing env file > default
    https_port="${https_port:-$(env_get TOOL_TABLE_HTTPS_PORT)}"; https_port="${https_port:-$DEFAULT_HTTPS_PORT}"
    http_port="${http_port:-$(env_get TOOL_TABLE_HTTP_PORT)}";    http_port="${http_port:-$DEFAULT_HTTP_PORT}"
    app_port="${app_port:-$(env_get TOOL_TABLE_APP_PORT)}";       app_port="${app_port:-$DEFAULT_APP_PORT}"
    (( fqdn_set )) || fqdn="$(env_get TOOL_TABLE_FQDN)"
    for p in "$https_port" "$app_port"; do valid_port "$p" && (( p > 0 )) || die "無效的埠號：$p"; done
    valid_port "$http_port" || die "無效的埠號：$http_port"
    [[ "$https_port" != "$app_port" && "$https_port" != "$http_port" && "$http_port" != "$app_port" ]] \
        || die "HTTPS / HTTP / 服務埠不可重複"

    log "安裝相依套件（python3、nginx、openssl…）"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq python3 python3-venv python3-pip nginx openssl curl ca-certificates iproute2 >/dev/null

    # Ports must be free, or already ours
    local owner
    for p in "$https_port" "$http_port"; do
        [[ "$p" == 0 ]] && continue
        owner="$(port_owner "$p")"
        [[ -z "$owner" || "$owner" == nginx ]] || die "埠 $p 已被 $owner 使用"
    done
    owner="$(port_owner "$app_port")"
    if [[ -n "$owner" ]] && ! systemctl is-active --quiet tool-table; then
        die "服務埠 $app_port 已被 $owner 使用，請用 --app-port 換一個"
    fi

    log "建立系統帳號與目錄"
    id "$APP_USER" >/dev/null 2>&1 || \
        useradd --system --home-dir "$DATA_DIR_DEFAULT" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
    install -d -m 0750 -o root -g "$APP_USER" "$ETC_DIR"
    install -d -m 0755 -o root -g root "$TLS_DIR"
    install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR_DEFAULT" "$DATA_DIR_DEFAULT/icons"
    install -d -m 0700 -o root -g root "$BACKUP_DIR_DEFAULT"

    # Bundled icons → data dir (never overwrite icons the admin uploaded or renamed)
    if [[ -d "$APP_DIR/resource/icon" ]]; then
        cp -n "$APP_DIR/resource/icon/"* "$DATA_DIR_DEFAULT/icons/" 2>/dev/null || true
        chown -R "$APP_USER:$APP_USER" "$DATA_DIR_DEFAULT/icons"
    fi

    log "寫入設定：$ENV_FILE"
    if [[ ! -f "$ENV_FILE" ]]; then
        install -m 0640 -o root -g "$APP_USER" "$APP_DIR/deploy/tool-table.env.example" "$ENV_FILE"
    fi
    env_set TOOL_TABLE_DATA_DIR "$DATA_DIR_DEFAULT"
    env_set TOOL_TABLE_ICON_DIR "$DATA_DIR_DEFAULT/icons"
    env_set TOOL_TABLE_ENABLE_DOCS false
    env_set TOOL_TABLE_APP_PORT "$app_port"
    env_set TOOL_TABLE_HTTPS_PORT "$https_port"
    env_set TOOL_TABLE_HTTP_PORT "$http_port"
    env_set TOOL_TABLE_FQDN "$fqdn"
    [[ -n "$(env_get TOOL_TABLE_BACKUP_DIR)" ]] || env_set TOOL_TABLE_BACKUP_DIR "$BACKUP_DIR_DEFAULT"
    [[ -n "$(env_get TOOL_TABLE_BACKUP_KEEP_DAYS)" ]] || env_set TOOL_TABLE_BACKUP_KEEP_DAYS 14
    # Server edition: sign-in for the whole site (keep an explicit "false" if someone set it)
    [[ -n "$(env_get TOOL_TABLE_AUTH)" ]] || env_set TOOL_TABLE_AUTH true

    setup_python
    log "本機管理員帳號"
    ensure_local_admin

    log "TLS 憑證：$TLS_DIR"
    bash "$APP_DIR/scripts/generate-self-signed-cert.sh" --out-dir "$TLS_DIR" ${fqdn:+--cn "$fqdn"}

    log "安裝 systemd 服務"
    install_units
    req_state
    systemctl enable --now tool-table.service >/dev/null
    systemctl restart tool-table.service
    systemctl enable --now tool-table-backup.timer >/dev/null

    log "設定 nginx（HTTPS :$https_port$( [[ "$http_port" != 0 ]] && echo "，HTTP :$http_port → HTTPS")）"
    render_nginx "$https_port" "$http_port" "$app_port" "$fqdn"
    systemctl enable nginx >/dev/null 2>&1 || true
    systemctl restart nginx

    open_firewall "$https_port" "$http_port"

    log "等待服務回應…"
    wait_until_serving "https://127.0.0.1:${https_port}/api/health" 60 \
        || die "服務沒有回應，請執行：sudo bash $APP_DIR/scripts/tool-table.sh doctor"

    print_summary "$https_port" "$http_port" "$fqdn"
}

# --------------------------------------------------------------- upgrade ---
cmd_upgrade() {
    local pull=1
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --no-pull) pull=0; shift ;;
            *) die "未知參數：$1" ;;
        esac
    done
    require_root
    [[ -f "$ENV_FILE" ]] || die "尚未安裝（找不到 $ENV_FILE），請先執行 install"

    if (( pull )); then
        log "更新原始碼（git pull）"
        git -C "$APP_DIR" pull --ff-only || die "git pull 失敗（$APP_DIR 有本機修改？）"
        # Hand over to the freshly pulled script so new upgrade steps take effect now
        exec bash "$APP_DIR/scripts/tool-table.sh" upgrade --no-pull
    fi

    log "升級前備份"
    cmd_backup --quiet

    setup_python
    install_units
    req_state
    # Upgrading from a version without accounts: turn sign-in on and create the local admin
    if [[ -z "$(env_get TOOL_TABLE_AUTH)" ]]; then
        env_set TOOL_TABLE_AUTH true
        log "新版加入帳號登入：已開啟 TOOL_TABLE_AUTH"
    fi
    ensure_local_admin

    # New bundled icons only (cp -n never overwrites)
    cp -n "$APP_DIR/resource/icon/"* "$(env_get TOOL_TABLE_ICON_DIR)/" 2>/dev/null || true
    chown -R "$APP_USER:$APP_USER" "$(env_get TOOL_TABLE_ICON_DIR)"

    render_nginx "$(env_get TOOL_TABLE_HTTPS_PORT)" "$(env_get TOOL_TABLE_HTTP_PORT)" \
                 "$(env_get TOOL_TABLE_APP_PORT)" "$(env_get TOOL_TABLE_FQDN)"
    systemctl restart tool-table.service
    systemctl reload nginx

    wait_until_serving "https://127.0.0.1:$(env_get TOOL_TABLE_HTTPS_PORT)/api/health" 60 \
        || die "升級後服務沒有回應，請執行 doctor；備份在 $(env_get TOOL_TABLE_BACKUP_DIR)"
    log "升級完成"
    if [[ -n "$ADMIN_NOTE" ]]; then
        echo; echo "  ---- 本機管理員（最高權限，平常不用）----"; sed 's/^/  /' <<<"$ADMIN_NOTE"
        echo "  （也存在 $ETC_DIR/initial-admin.txt，僅 root 可讀）"
        echo "  登入後在後台「系統設定」設定 AD，並在「帳號與權限」至少指定一位 AD 管理員"
    fi
}

# ------------------------------------------------------------- uninstall ---
cmd_uninstall() {
    local purge=0 yes=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --purge) purge=1; shift ;;
            --yes)   yes=1; shift ;;
            *) die "未知參數：$1" ;;
        esac
    done
    require_root

    log "停用並移除服務"
    systemctl disable --now tool-table.service tool-table-backup.timer tool-table-apply.path >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/tool-table.service" "$UNIT_DIR/tool-table-backup.service" "$UNIT_DIR/tool-table-backup.timer" \
          "$UNIT_DIR/tool-table-apply.path" "$UNIT_DIR/tool-table-apply.service"
    systemctl daemon-reload

    log "移除 nginx 站台"
    rm -f "$NGINX_LINK" "$NGINX_SITE" "$NGINX_SNIPPETS/tool-table-headers.conf" "$NGINX_SNIPPETS/tool-table-proxy.conf"
    if command -v nginx >/dev/null && nginx -t >/dev/null 2>&1; then
        systemctl reload nginx 2>/dev/null || true
    fi

    if (( purge )); then
        if (( ! yes )); then
            read -r -p "將刪除 $ETC_DIR 與 $DATA_DIR_DEFAULT（資料庫、圖示、憑證）。輸入 yes 確認：" ans
            [[ "$ans" == "yes" ]] || die "已取消"
        fi
        rm -rf "$ETC_DIR" "$DATA_DIR_DEFAULT"
        id "$APP_USER" >/dev/null 2>&1 && userdel "$APP_USER" 2>/dev/null || true
        log "已清除設定與資料（備份保留在 $BACKUP_DIR_DEFAULT）"
    else
        log "保留資料：$ETC_DIR、$DATA_DIR_DEFAULT（要一併刪除請加 --purge）"
    fi
    log "原始碼保留在 $APP_DIR（不需要可自行刪除）"
}

# ---------------------------------------------------------------- backup ---
cmd_backup() {
    local quiet=0
    [[ "${1:-}" == "--quiet" ]] && quiet=1
    require_root
    local data_dir icon_dir backup_dir keep stamp work out
    data_dir="$(env_get TOOL_TABLE_DATA_DIR)"; data_dir="${data_dir:-$DATA_DIR_DEFAULT}"
    icon_dir="$(env_get TOOL_TABLE_ICON_DIR)"; icon_dir="${icon_dir:-$data_dir/icons}"
    backup_dir="$(env_get TOOL_TABLE_BACKUP_DIR)"; backup_dir="${backup_dir:-$BACKUP_DIR_DEFAULT}"
    keep="$(env_get TOOL_TABLE_BACKUP_KEEP_DAYS)"; keep="${keep:-14}"
    stamp="$(date +%Y%m%d-%H%M%S)"
    install -d -m 0700 "$backup_dir"
    work="$(mktemp -d)"
    mkdir -p "$work/tool-table"

    # Consistent online copy of SQLite (safe while the service is running)
    if [[ -f "$data_dir/tool-table.db" ]]; then
        python3 - "$data_dir/tool-table.db" "$work/tool-table/tool-table.db" <<'PY'
import sqlite3, sys
src = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
dst.close(); src.close()
PY
    fi
    [[ -d "$icon_dir" ]] && cp -a "$icon_dir" "$work/tool-table/icons"
    [[ -d "$data_dir/attachments" ]] && cp -a "$data_dir/attachments" "$work/tool-table/attachments"
    [[ -f "$ENV_FILE" ]] && cp -a "$ENV_FILE" "$work/tool-table/"

    out="$backup_dir/tool-table-$stamp.tar.gz"
    tar -C "$work" -czf "$out" tool-table
    chmod 0600 "$out"
    rm -rf "$work"

    find "$backup_dir" -maxdepth 1 -name 'tool-table-*.tar.gz' -mtime +"$keep" -delete
    (( quiet )) || log "備份完成：$out（保留 $keep 天）"
    return 0
}

cmd_restore() {
    local file="${1:-}"
    require_root
    [[ -f "$file" ]] || die "用法：tool-table.sh restore /var/backups/tool-table/tool-table-YYYYmmdd-HHMMSS.tar.gz"
    local data_dir icon_dir work
    data_dir="$(env_get TOOL_TABLE_DATA_DIR)"; data_dir="${data_dir:-$DATA_DIR_DEFAULT}"
    icon_dir="$(env_get TOOL_TABLE_ICON_DIR)"; icon_dir="${icon_dir:-$data_dir/icons}"
    work="$(mktemp -d)"
    tar -C "$work" -xzf "$file"
    [[ -d "$work/tool-table" ]] || die "不是 Tool Table 的備份檔"

    log "還原前先備份目前資料"
    cmd_backup --quiet

    systemctl stop tool-table.service
    if [[ -f "$work/tool-table/tool-table.db" ]]; then
        install -m 0640 -o "$APP_USER" -g "$APP_USER" "$work/tool-table/tool-table.db" "$data_dir/tool-table.db"
        rm -f "$data_dir/tool-table.db-wal" "$data_dir/tool-table.db-shm"
    fi
    if [[ -d "$work/tool-table/icons" ]]; then
        rm -rf "$icon_dir"
        cp -a "$work/tool-table/icons" "$icon_dir"
        chown -R "$APP_USER:$APP_USER" "$icon_dir"
    fi
    if [[ -d "$work/tool-table/attachments" ]]; then
        rm -rf "$data_dir/attachments"
        cp -a "$work/tool-table/attachments" "$data_dir/attachments"
        chown -R "$APP_USER:$APP_USER" "$data_dir/attachments"
    fi
    rm -rf "$work"
    systemctl start tool-table.service
    log "已還原：$file"
}

# ------------------------------------------------------------ renew-cert ---
cmd_renew_cert() {
    require_root
    local fqdn
    fqdn="$(env_get TOOL_TABLE_FQDN)"
    bash "$APP_DIR/scripts/generate-self-signed-cert.sh" --out-dir "$TLS_DIR" --force ${fqdn:+--cn "$fqdn"}
    nginx -t >/dev/null 2>&1 && systemctl reload nginx
    log "已重新產生自簽憑證並重新載入 nginx"
}

# ---------------------------------------------------------------- doctor ---
cmd_doctor() {
    local fails=0
    ok()   { echo -e "  \033[1;32m✔\033[0m $*"; }
    bad()  { echo -e "  \033[1;31m✘\033[0m $1"; [[ -n "${2:-}" ]] && echo -e "    → $2"; fails=$((fails + 1)); }
    info() { echo -e "  · $*"; }

    echo "Tool Table 健檢"
    [[ $EUID -eq 0 ]] || warn "建議用 sudo 執行，部分檢查需要 root"

    if [[ -f "$ENV_FILE" ]]; then ok "設定檔 $ENV_FILE"
    else bad "找不到 $ENV_FILE" "sudo bash $APP_DIR/scripts/tool-table.sh install"; fi

    local app_port https_port http_port data_dir loc=""
    app_port="$(env_get TOOL_TABLE_APP_PORT)"; app_port="${app_port:-$DEFAULT_APP_PORT}"
    https_port="$(env_get TOOL_TABLE_HTTPS_PORT)"; https_port="${https_port:-$DEFAULT_HTTPS_PORT}"
    http_port="$(env_get TOOL_TABLE_HTTP_PORT)"; http_port="${http_port:-$DEFAULT_HTTP_PORT}"
    data_dir="$(env_get TOOL_TABLE_DATA_DIR)"; data_dir="${data_dir:-$DATA_DIR_DEFAULT}"
    info "HTTPS :$https_port　HTTP :$http_port　服務 127.0.0.1:$app_port"

    if [[ -x "$VENV/bin/uvicorn" ]]; then ok "Python 環境 $VENV"
    else bad "缺少 $VENV" "sudo bash $APP_DIR/scripts/tool-table.sh upgrade --no-pull"; fi

    if systemctl is-active --quiet tool-table; then ok "tool-table.service 執行中"
    else bad "tool-table.service 未執行" "sudo journalctl -u tool-table -n 50 --no-pager"; fi

    # Service port must NOT be reachable from the network
    local listen
    listen="$(ss -Hltn "sport = :$app_port" 2>/dev/null | awk '{print $4}' | tr '\n' ' ')"
    if [[ -z "$listen" ]]; then
        bad "服務埠 $app_port 沒有在監聽" "sudo systemctl restart tool-table"
    elif echo "$listen" | grep -qvE '^(127\.0\.0\.1|\[::1\]):'; then
        bad "服務埠 $app_port 對外開放（$listen）" "服務應只綁 127.0.0.1；請重新執行 install"
    else
        ok "服務埠只綁本機（$listen）"
    fi

    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$app_port/api/health" || echo 000)"
    [[ "$code" == 200 ]] && ok "後端回應 /api/health" || bad "後端沒有回應（HTTP $code）" "sudo journalctl -u tool-table -n 50 --no-pager"

    if nginx -t >/dev/null 2>&1; then ok "nginx 設定正確"
    else bad "nginx 設定錯誤" "sudo nginx -t"; fi
    systemctl is-active --quiet nginx && ok "nginx 執行中" || bad "nginx 未執行" "sudo systemctl restart nginx"

    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "https://127.0.0.1:$https_port/api/health" || echo 000)"
    [[ "$code" == 200 ]] && ok "HTTPS :$https_port 正常" || bad "HTTPS :$https_port 回應 $code" "sudo tail -n 30 /var/log/nginx/tool-table.error.log"

    if [[ "$http_port" != 0 ]]; then
        local loc
        loc="$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 5 "http://127.0.0.1:$http_port/admin" || true)"
        [[ "$loc" == "https://127.0.0.1:$https_port/admin" ]] && ok "HTTP :$http_port → HTTPS 轉址" \
            || bad "HTTP :$http_port 沒有轉到 HTTPS（得到：${loc:-無}）" "sudo bash $APP_DIR/scripts/tool-table.sh install"
    fi
    loc="$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 5 "http://127.0.0.1:$https_port/" || true)"
    [[ "$loc" == https://* ]] && ok "以 http:// 連 :$https_port 會轉成 https" \
        || bad "以 http:// 連 :$https_port 沒有轉址" "確認 nginx 站台含 error_page 497"

    if [[ -r "$TLS_DIR/server.crt" ]]; then
        local end
        end="$(openssl x509 -enddate -noout -in "$TLS_DIR/server.crt" | cut -d= -f2)"
        if openssl x509 -checkend $((30 * 86400)) -noout -in "$TLS_DIR/server.crt" >/dev/null; then
            ok "憑證有效至 $end"
        else
            bad "憑證 30 天內到期（$end）" "sudo bash $APP_DIR/scripts/tool-table.sh renew-cert"
        fi
    else
        bad "找不到憑證 $TLS_DIR/server.crt" "sudo bash $APP_DIR/scripts/tool-table.sh renew-cert"
    fi

    if [[ -f "$data_dir/tool-table.db" ]]; then
        [[ "$(stat -c %U "$data_dir/tool-table.db")" == "$APP_USER" ]] && ok "資料庫 $data_dir/tool-table.db" \
            || bad "資料庫擁有者不是 $APP_USER" "sudo chown -R $APP_USER:$APP_USER $data_dir"
    else
        info "資料庫尚未建立（服務第一次啟動時建立）"
    fi

    systemctl is-enabled --quiet tool-table-backup.timer 2>/dev/null && ok "每日備份排程已啟用" \
        || bad "每日備份排程未啟用" "sudo systemctl enable --now tool-table-backup.timer"
    local last
    last="$(ls -1t "$(env_get TOOL_TABLE_BACKUP_DIR)"/tool-table-*.tar.gz 2>/dev/null | head -n1 || true)"
    [[ -n "$last" ]] && info "最近一次備份：$last" || info "尚無備份"

    echo
    # Accounts / AD
    if [[ "$(env_get TOOL_TABLE_AUTH)" =~ ^(1|true|yes|on)$ ]]; then
        ok "帳號登入已開啟（公開進度看板 /dashboard 不需登入）"
        if [[ $EUID -eq 0 && -x "$VENV/bin/python" ]]; then
            local users
            users="$(app_cli users 2>/dev/null || true)"
            if grep -q " superadmin " <<<"$users"; then ok "本機管理員帳號存在"
                [[ -f "$ETC_DIR/initial-admin.txt" ]] && info "初始密碼檔 $ETC_DIR/initial-admin.txt 還在：改完密碼後可刪除"
            else bad "沒有本機管理員帳號" "sudo bash $APP_DIR/scripts/tool-table.sh reset-admin"; fi
            if grep -qE "^[^ ]+ +ldap +admin +啟用" <<<"$users"; then ok "已有 AD 管理員"
            else info "還沒有 AD 管理員：用本機管理員登入後台「帳號與權限」指定"; fi
            local ldap_out ldap_rc=0
            ldap_out="$(app_cli ldap-check 2>&1)" || ldap_rc=$?
            if [[ $ldap_rc -eq 0 ]] && grep -q "✔ 服務帳號登入成功\|沒有服務帳號" <<<"$ldap_out"; then ok "AD 連線正常"
            elif grep -q "尚未啟用\|未設定" <<<"$ldap_out"; then info "尚未啟用 AD：在後台「系統設定 → AD 登入」設定"
            else bad "AD 連線失敗：$(tail -1 <<<"$ldap_out")" "後台「系統設定 → AD 登入」按「測試」查看細節"; fi
        fi
    else
        info "帳號登入未開啟（TOOL_TABLE_AUTH）：任何人都能修改內容"
    fi

    if systemctl is-enabled --quiet tool-table-apply.path 2>/dev/null; then ok "後台設定套用服務（tool-table-apply.path）已啟用"
    else bad "後台無法套用憑證 / 連線埠變更" "sudo bash $APP_DIR/scripts/tool-table.sh upgrade --no-pull"; fi

    if (( fails == 0 )); then log "全部通過"; else warn "$fails 項需要處理（見上方 → 修法）"; return 1; fi
}

# ------------------------------------------------- admin UI requests (root) ---
# The app cannot touch nginx or /etc. It writes $REQ_DIR/request.json (+ cert.pem/key.pem);
# tool-table-apply.path runs this. Everything in the request is treated as untrusted.
REQ_DIR="$DATA_DIR_DEFAULT/requests"

req_result() {   # ok(true|false) message
    local ok="$1" msg="$2" tmp
    tmp="$(mktemp)"
    python3 - "$ok" "$msg" "$REQ_ID" > "$tmp" <<'PY'
import json, sys, datetime
print(json.dumps({"id": sys.argv[3], "ok": sys.argv[1] == "true", "message": sys.argv[2],
                  "at": datetime.datetime.now().isoformat(timespec="seconds")}, ensure_ascii=False))
PY
    install -m 0640 -o "$APP_USER" -g "$APP_USER" "$tmp" "$REQ_DIR/result.json"
    rm -f "$tmp"
}

req_state() {    # current network settings for the admin UI
    local tmp; tmp="$(mktemp)"
    python3 - "$(env_get TOOL_TABLE_HTTPS_PORT)" "$(env_get TOOL_TABLE_HTTP_PORT)" "$(env_get TOOL_TABLE_FQDN)" > "$tmp" <<'PY'
import json, sys
print(json.dumps({"https_port": int(sys.argv[1] or 33443), "http_port": int(sys.argv[2] or 0), "fqdn": sys.argv[3]}))
PY
    install -m 0640 -o "$APP_USER" -g "$APP_USER" "$tmp" "$REQ_DIR/state.json"
    rm -f "$tmp"
}

cmd_apply_request() {
    require_root
    local req="$REQ_DIR/request.json"
    [[ -f "$req" && ! -L "$req" ]] || exit 0
    # One request at a time (the path unit can fire again while we are working)
    exec 9>"/run/tool-table-apply.lock"
    flock -n 9 || exit 0
    # Parse with python into fixed, validated fields (never eval the file)
    local parsed
    parsed="$(python3 - "$req" <<'PY'
import json, re, sys
try:
    r = json.load(open(sys.argv[1]))
except Exception:
    print("bad"); sys.exit()
kind = r.get("type")
rid = str(r.get("id", ""))
if not re.fullmatch(r"[A-Za-z0-9-]{1,40}", rid):
    print("bad"); sys.exit()
if kind in ("tls_upload", "tls_selfsigned"):
    print(f"{kind} {rid}")
elif kind == "network":
    hp, p80, fq = r.get("https_port"), r.get("http_port"), r.get("fqdn") or ""
    ok = isinstance(hp, int) and 1 <= hp <= 65535 and isinstance(p80, int) and 0 <= p80 <= 65535 and hp != p80 \
         and re.fullmatch(r"(|[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*)", fq)
    print(f"network {rid} {hp} {p80} {fq or '-'}" if ok else "bad")
else:
    print("bad")
PY
)"
    local kind REQ_ID a b c
    read -r kind REQ_ID a b c <<<"$parsed"
    REQ_ID="${REQ_ID:-unknown}"
    rm -f "$req"
    case "$kind" in
        tls_upload)     apply_tls_upload ;;
        tls_selfsigned) apply_tls_selfsigned ;;
        network)        apply_network "$a" "$b" "$([[ "$c" == - ]] && echo "" || echo "$c")" ;;
        *)              req_result false "無法辨識的要求" ;;
    esac
    rm -f "$REQ_DIR/cert.pem" "$REQ_DIR/key.pem"
    req_state
}

tls_backup()  { install -d -m 0755 "$TLS_DIR/previous"; cp -p "$TLS_DIR/server.crt" "$TLS_DIR/server.key" "$TLS_DIR/previous/" 2>/dev/null || true; }
tls_restore() { cp -p "$TLS_DIR/previous/server.crt" "$TLS_DIR/previous/server.key" "$TLS_DIR/" 2>/dev/null || true; }

apply_tls_upload() {
    local crt="$REQ_DIR/cert.pem" key="$REQ_DIR/key.pem"
    [[ -f "$crt" && -f "$key" && ! -L "$crt" && ! -L "$key" ]] || { req_result false "缺少憑證或私鑰檔"; return; }
    openssl x509 -in "$crt" -noout >/dev/null 2>&1 || { req_result false "憑證不是有效的 PEM"; return; }
    openssl pkey -in "$key" -noout >/dev/null 2>&1 || { req_result false "私鑰不是有效的 PEM（或有密碼保護）"; return; }
    [[ "$(openssl x509 -in "$crt" -noout -pubkey | openssl sha256)" == "$(openssl pkey -in "$key" -pubout | openssl sha256)" ]] \
        || { req_result false "私鑰與憑證不成對"; return; }
    openssl x509 -in "$crt" -noout -checkend 0 >/dev/null 2>&1 || { req_result false "憑證已過期"; return; }
    tls_backup
    install -m 0644 -o root -g root "$crt" "$TLS_DIR/server.crt"
    install -m 0600 -o root -g root "$key" "$TLS_DIR/server.key"
    if nginx -t >/dev/null 2>&1; then
        systemctl reload nginx
        req_result true "已換上新憑證：$(openssl x509 -in "$TLS_DIR/server.crt" -noout -subject | sed 's/^subject=//')"
    else
        tls_restore; systemctl reload nginx 2>/dev/null || true
        req_result false "nginx 不接受這張憑證，已換回原本的"
    fi
}

apply_tls_selfsigned() {
    tls_backup
    if bash "$APP_DIR/scripts/generate-self-signed-cert.sh" --out-dir "$TLS_DIR" --force \
            $( [[ -n "$(env_get TOOL_TABLE_FQDN)" ]] && echo "--cn $(env_get TOOL_TABLE_FQDN)" ) >/dev/null 2>&1 && nginx -t >/dev/null 2>&1; then
        systemctl reload nginx
        req_result true "已重新產生自簽憑證"
    else
        tls_restore; systemctl reload nginx 2>/dev/null || true
        req_result false "產生自簽憑證失敗，已保留原本的"
    fi
}

apply_network() {
    local https_port="$1" http_port="$2" fqdn="$3" app_port owner p
    app_port="$(env_get TOOL_TABLE_APP_PORT)"; app_port="${app_port:-$DEFAULT_APP_PORT}"
    [[ "$https_port" != "$app_port" && "$http_port" != "$app_port" ]] || { req_result false "不能使用服務內部埠 $app_port"; return; }
    for p in "$https_port" "$http_port"; do
        [[ "$p" == 0 ]] && continue
        owner="$(port_owner "$p")"
        [[ -z "$owner" || "$owner" == nginx ]] || { req_result false "埠 $p 已被 $owner 使用"; return; }
    done
    local old_https old_http old_fqdn
    old_https="$(env_get TOOL_TABLE_HTTPS_PORT)"; old_http="$(env_get TOOL_TABLE_HTTP_PORT)"; old_fqdn="$(env_get TOOL_TABLE_FQDN)"
    cp -p "$NGINX_SITE" "$NGINX_SITE.previous" 2>/dev/null || true
    env_set TOOL_TABLE_HTTPS_PORT "$https_port"; env_set TOOL_TABLE_HTTP_PORT "$http_port"; env_set TOOL_TABLE_FQDN "$fqdn"
    if ( render_nginx "$https_port" "$http_port" "$app_port" "$fqdn" ) >/dev/null 2>&1 && systemctl reload nginx; then
        open_firewall "$https_port" "$http_port" >/dev/null 2>&1 || true
        req_result true "已套用：HTTPS :$https_port$( [[ "$http_port" != 0 ]] && echo "，HTTP :$http_port → HTTPS")${fqdn:+，名稱 $fqdn}"
    else
        env_set TOOL_TABLE_HTTPS_PORT "$old_https"; env_set TOOL_TABLE_HTTP_PORT "$old_http"; env_set TOOL_TABLE_FQDN "$old_fqdn"
        cp -p "$NGINX_SITE.previous" "$NGINX_SITE" 2>/dev/null || true
        systemctl reload nginx 2>/dev/null || true
        req_result false "nginx 無法套用新設定，已還原原本的埠與名稱"
    fi
}

# --------------------------------------------------------- accounts / AD ---
cmd_reset_admin() {
    require_root
    [[ -f "$ENV_FILE" ]] || die "尚未安裝"
    local out
    out="$(app_cli local-admin --reset)" || die "$out"
    install -m 0600 -o root -g root /dev/null "$ETC_DIR/initial-admin.txt"
    { echo "# Tool Table 本機管理員（緊急用）— 重設於 $(date '+%F %T')"; echo "$out"; } > "$ETC_DIR/initial-admin.txt"
    echo "$out"
    echo "（已登出這個帳號的所有工作階段；也存在 $ETC_DIR/initial-admin.txt）"
}

cmd_users() { require_root; app_cli users; }
cmd_ldap_check() { require_root; app_cli ldap-check; }
cmd_ldap_test() {
    require_root
    [[ -n "${1:-}" ]] || die "用法：tool-table.sh ldap-test <AD 帳號>"
    local pw
    read -r -s -p "$1 的密碼：" pw; echo
    printf '%s\n' "$pw" | app_cli ldap-test "$1"
}

cmd_help() { sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

main() {
    case "${1:-help}" in
        install)    shift; cmd_install "$@" ;;
        upgrade)    shift; cmd_upgrade "$@" ;;
        uninstall)  shift; cmd_uninstall "$@" ;;
        doctor)     shift; cmd_doctor "$@" ;;
        backup)     shift; cmd_backup "$@" ;;
        restore)    shift; cmd_restore "$@" ;;
        renew-cert) shift; cmd_renew_cert "$@" ;;
        reset-admin) shift; cmd_reset_admin "$@" ;;
        apply-request) shift; cmd_apply_request "$@" ;;
        users)      shift; cmd_users "$@" ;;
        ldap-check) shift; cmd_ldap_check "$@" ;;
        ldap-test)  shift; cmd_ldap_test "$@" ;;
        help|-h|--help) cmd_help ;;
        *) cmd_help; exit 2 ;;
    esac
}

main "$@"
