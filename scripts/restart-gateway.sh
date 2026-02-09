#!/usr/bin/env bash
# Restart the local OpenClaw gateway (Node.js dev mode).
# Usage: scripts/restart-gateway.sh [--tail] [--verbose]
#   --tail     Follow the gateway log after starting
#   --verbose  Enable verbose/debug logging (TTS, config resolution, etc.)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${HOME}/.openclaw/openclaw.json"
LOG="/tmp/openclaw-gateway.log"
TAIL=0
VERBOSE=""

for arg in "$@"; do
  case "${arg}" in
    --tail|-t) TAIL=1 ;;
    --verbose|-v) VERBOSE="--verbose" ;;
    --help|-h)
      echo "Usage: $(basename "$0") [--tail] [--verbose]"
      echo "  --tail     Follow gateway log after starting"
      echo "  --verbose  Enable verbose/debug logging"
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

echo "==> Stopping gateway on port ${PORT}"
pkill -9 -f "openclaw.mjs gateway" 2>/dev/null || true
pkill -9 -f "openclaw-gateway" 2>/dev/null || true

# Wait for port to free up.
for i in {1..10}; do
  if ! lsof -iTCP:"${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
    break
  fi
  sleep 0.3
done

echo "==> Starting gateway (port ${PORT}, log: ${LOG})"
cd "${ROOT_DIR}"
nohup node openclaw.mjs gateway run --bind loopback --port "${PORT}" --force ${VERBOSE} > "${LOG}" 2>&1 &
GW_PID=$!

# Wait for the gateway to bind.
for i in {1..20}; do
  if lsof -iTCP:"${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "OK: Gateway running (pid ${GW_PID}, port ${PORT})"
    if [[ "${TAIL}" -eq 1 ]]; then
      exec tail -f "${LOG}"
    fi
    exit 0
  fi
  sleep 0.5
done

echo "WARN: Gateway may not have started. Check: tail -f ${LOG}"
exit 1
