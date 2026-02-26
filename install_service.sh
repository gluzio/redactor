#!/usr/bin/env bash
# install_service.sh — register Redactor server as a launchd login agent
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_TEMPLATE="$SCRIPT_DIR/com.redactor.server.plist"
AGENTS_DIR="$HOME/Library/LaunchAgents"
DEST="$AGENTS_DIR/com.redactor.server.plist"
LOG_DIR="$HOME/Library/Logs/redactor"

# ── 1. Sanity checks ────────────────────────────────────────────────────────

if [ ! -f "$PLIST_TEMPLATE" ]; then
  echo "Error: $PLIST_TEMPLATE not found." >&2
  exit 1
fi

VENV_PYTHON="$HOME/redactor/.venv/bin/python"
if [ ! -f "$VENV_PYTHON" ]; then
  echo "Warning: venv not found at $VENV_PYTHON"
  echo "Run ./run.sh at least once to create the virtual environment first."
  echo ""
  read -rp "Continue anyway? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || exit 1
fi

# ── 2. Create log directory ─────────────────────────────────────────────────

echo "Creating log directory: $LOG_DIR"
mkdir -p "$LOG_DIR"

# ── 3. Install plist (substitute __HOME__ with real home) ───────────────────

mkdir -p "$AGENTS_DIR"
sed "s|__HOME__|$HOME|g" "$PLIST_TEMPLATE" > "$DEST"
echo "Installed plist: $DEST"

# ── 4. Unload existing service if loaded (ignore errors) ────────────────────

launchctl unload "$DEST" 2>/dev/null || true

# ── 5. Load the service ─────────────────────────────────────────────────────

launchctl load "$DEST"
echo ""
echo "Redactor server service installed and started."
echo ""
echo "Logs:"
echo "  stdout : $LOG_DIR/server.log"
echo "  stderr : $LOG_DIR/server.error.log"
echo ""
echo "To stop:   launchctl unload $DEST"
echo "To remove: ./uninstall_service.sh"
