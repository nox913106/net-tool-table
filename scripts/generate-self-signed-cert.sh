#!/usr/bin/env bash
# =============================================================================
# IPMS — generate a self-signed TLS certificate (ECDSA P-384)
#
# Usage:
#   sudo bash scripts/generate-self-signed-cert.sh \
#       [--out-dir /etc/tool-table/tls] \
#       [--cn portal.example.com] \
#       [--san "DNS:portal.example.com,IP:192.168.1.10"] \
#       [--days 1825] [--force]
#
# Default:
#   * CN = --cn, else the host FQDN
#   * SAN = localhost, hostname (FQDN + short), 127.0.0.1, ::1 and every local IP
#   * key 0600 root:root, cert 0644
#
# Browsers warn about self-signed certificates. To use a real certificate,
# overwrite /etc/tool-table/tls/server.crt (fullchain) and server.key, then
# `systemctl reload nginx`.
# =============================================================================
set -euo pipefail

OUT_DIR="/etc/tool-table/tls"
CN=""
EXTRA_SAN=""
DAYS=1825
FORCE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --out-dir) OUT_DIR="$2"; shift 2 ;;
        --cn)      CN="$2"; shift 2 ;;
        --san)     EXTRA_SAN="$2"; shift 2 ;;
        --days)    DAYS="$2"; shift 2 ;;
        --force)   FORCE=1; shift ;;
        -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done

if [[ $EUID -ne 0 ]]; then
    echo "[error] must run as root (writes $OUT_DIR)" >&2
    exit 1
fi
command -v openssl >/dev/null || { echo "[error] openssl not installed" >&2; exit 1; }

CRT="$OUT_DIR/server.crt"
KEY="$OUT_DIR/server.key"
if [[ -s "$CRT" && -s "$KEY" && $FORCE -eq 0 ]]; then
    echo "[cert] $CRT already exists (use --force to replace)"
    exit 0
fi

HOST_FQDN="$(hostname -f 2>/dev/null || hostname)"
HOST_SHORT="$(hostname -s 2>/dev/null || hostname)"
[[ -z "$CN" ]] && CN="$HOST_FQDN"

declare -A seen=()
san=()
add_san() { [[ -n "$1" && -z "${seen[$1]:-}" ]] && { seen[$1]=1; san+=("$1"); }; return 0; }

add_san "DNS:$CN"
add_san "DNS:localhost"
add_san "DNS:$HOST_FQDN"
add_san "DNS:$HOST_SHORT"
add_san "IP:127.0.0.1"
add_san "IP:::1"
for ip in $(hostname -I 2>/dev/null || true); do
    [[ "$ip" == fe80:* ]] && continue   # skip link-local
    add_san "IP:$ip"
done
if [[ -n "$EXTRA_SAN" ]]; then
    IFS=',' read -ra extra <<< "$EXTRA_SAN"
    for s in "${extra[@]}"; do add_san "${s// /}"; done
fi
SAN_STR="$(IFS=,; echo "${san[*]}")"

install -d -m 0755 "$OUT_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

openssl ecparam -name secp384r1 -genkey -noout -out "$TMP/server.key"
openssl req -new -x509 -sha384 -days "$DAYS" \
    -key "$TMP/server.key" -out "$TMP/server.crt" \
    -subj "/CN=${CN}/O=IPMS (self-signed)" \
    -addext "subjectAltName=${SAN_STR}" \
    -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=serverAuth"

install -m 0600 -o root -g root "$TMP/server.key" "$KEY"
install -m 0644 -o root -g root "$TMP/server.crt" "$CRT"

echo "[cert] wrote $CRT (valid ${DAYS} days)"
echo "[cert] CN=$CN"
echo "[cert] SAN=$SAN_STR"
