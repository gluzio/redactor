#!/usr/bin/env bash
# uninstall_service.sh — remove Redactor server launchd agent
set -euo pipefail

DEST="$HOME/Library/LaunchAgents/com.redactor.server.plist"

if [ ! -f "$DEST" ]; then
  echo "Service is not installed ($DEST not found)."
  exit 0
fi

# ── Unload ───────────────────────────────────────────────────────────────────

echo "Stopping service…"
launchctl unload "$DEST" 2>/dev/null || true

# ── Remove plist ─────────────────────────────────────────────────────────────

rm "$DEST"
echo "Removed: $DEST"
echo ""
echo "Redactor server service uninstalled."
echo "(Log files in ~/Library/Logs/redactor/ were left intact.)"
