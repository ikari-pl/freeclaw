#!/usr/bin/env bash
# Restart the OpenClaw gateway via launchd (the installed service).
# Falls back to a direct `gateway restart` CLI call if the service isn't installed.
#
# Usage: scripts/restart-gateway.sh [--tail] [--install]
#   --tail      Follow the gateway log after restarting
#   --install   Re-run `gateway install --force` before starting (picks up new port/token)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${ROOT_DIR}/openclaw.mjs"
CONFIG="${HOME}/.openclaw/openclaw.json"
PLIST="${HOME}/Library/LaunchAgents/ai.openclaw.gateway.plist"
LAUNCHD_LOG="${HOME}/.openclaw/logs/gateway.log"
DAILY_LOG="/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"
TAIL=0
INSTALL=0

for arg in "$@"; do
  case "${arg}" in
    --tail|-t)    TAIL=1 ;;
    --install|-i) INSTALL=1 ;;
    --help|-h)
      echo "Usage: $(basename "$0") [--tail] [--install]"
      echo "  --tail      Follow gateway log after restarting"
      echo "  --install   Reinstall launchd service before starting"
      exit 0
      ;;
  esac
done

# Read port from config (default 18789).
PORT="$(
  node -e '
    const fs = require("node:fs");
    try {
      const cfg = JSON.parse(fs.readFileSync("'"${CONFIG}"'", "utf8"));
      process.stdout.write(String(cfg?.gateway?.port ?? 18789));
    } catch { process.stdout.write("18789"); }
  '
)"

# Kill any rogue nohup gateway processes that aren't launchd-managed.
# This cleans up leftovers from the old script.
pkill -f "openclaw.mjs gateway run" 2>/dev/null || true

if [[ "${INSTALL}" -eq 1 ]]; then
  echo "==> Reinstalling launchd service"
  node "${NODE}" gateway stop 2>/dev/null || true
  node "${NODE}" gateway install --force --port "${PORT}"
fi

echo "==> Restarting gateway (port ${PORT})"
node "${NODE}" gateway restart

# Wait for the gateway to bind.
for i in {1..20}; do
  if lsof -iTCP:"${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
    PID="$(lsof -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null | head -1)"
    echo "OK: Gateway running (pid ${PID}, port ${PORT})"
    if [[ "${TAIL}" -eq 1 ]]; then
      # Follow whichever log exists; prefer daily internal log.
      if [[ -f "${DAILY_LOG}" ]]; then
        exec tail -f "${DAILY_LOG}"
      else
        exec tail -f "${LAUNCHD_LOG}"
      fi
    fi
    exit 0
  fi
  sleep 0.5
done

echo "WARN: Gateway may not have started. Check:"
echo "  tail -f ${LAUNCHD_LOG}"
echo "  tail -f ${DAILY_LOG}"
exit 1
