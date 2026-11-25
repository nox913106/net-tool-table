#!/usr/bin/env bash
#
# IPMS one-shot install: clone to /opt/tool-table, then run the installer.
# Usage (no manual git needed):
#   curl -fsSL https://raw.githubusercontent.com/nox913106/net-tool-table/main/scripts/bootstrap.sh | sudo bash
#   # with options:
#   ... | sudo bash -s -- --https-port 443 --fqdn portal.example.com
#
set -euo pipefail

REPO="${TOOL_TABLE_REPO:-https://github.com/nox913106/net-tool-table.git}"
BRANCH="${TOOL_TABLE_BRANCH:-main}"
DIR="${TOOL_TABLE_DIR:-/opt/tool-table}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "[error] Please run as root (sudo)." >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "[*] Installing git..."
  apt-get update -qq && apt-get install -y -qq git
fi

if [[ -d "$DIR/.git" ]]; then
  echo "[*] $DIR exists; updating to origin/$BRANCH…"
  git config --global --add safe.directory "$DIR" 2>/dev/null || true
  git -C "$DIR" remote set-url origin "$REPO" 2>/dev/null || true
  git -C "$DIR" fetch --quiet origin "$BRANCH"
  git -C "$DIR" checkout --quiet "$BRANCH" 2>/dev/null || git -C "$DIR" checkout --quiet -b "$BRANCH" "origin/$BRANCH"
  if ! git -C "$DIR" merge --ff-only --quiet "origin/$BRANCH"; then
    echo "[warn] $DIR has local changes; resetting to origin/$BRANCH" >&2
    git -C "$DIR" reset --hard --quiet "origin/$BRANCH"
  fi
else
  echo "[*] git clone $REPO ($BRANCH) -> $DIR"
  git clone --quiet --branch "$BRANCH" "$REPO" "$DIR"
fi

cd "$DIR"
echo "[*] Running scripts/tool-table.sh install $*"
exec bash scripts/tool-table.sh install "$@"
