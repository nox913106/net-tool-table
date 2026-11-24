#!/bin/bash
# IPMS - local development launcher
# Production: see docs/INSTALL.md (scripts/bootstrap.sh → nginx HTTPS + systemd)

echo "========================================"
echo "  IPMS - 本機開發模式"
echo "========================================"
echo

cd "$(dirname "$0")"

# Check Python
if ! command -v python3 &> /dev/null; then
    echo "[ERROR] Python3 is not installed"
    exit 1
fi

# Create virtual environment
if [ ! -d "venv" ]; then
    echo "[1/3] Creating virtual environment..."
    python3 -m venv venv
fi

# Activate
echo "[2/3] Activating virtual environment..."
source venv/bin/activate

# Install dependencies
if [ ! -f "venv/.installed" ]; then
    echo "[3/3] Installing dependencies..."
    pip install -r requirements.txt --quiet
    touch venv/.installed
else
    echo "[3/3] Dependencies already installed"
fi

echo
echo "========================================"
echo "  Server starting at http://127.0.0.1:8080"
echo "  Admin panel: http://127.0.0.1:8080/admin"
echo "  Press Ctrl+C to stop"
echo "========================================"
echo

# Start server
# Development only: bound to localhost. Production runs behind nginx (docs/INSTALL.md)
uvicorn app.main:app --host 127.0.0.1 --port 8080 --reload
