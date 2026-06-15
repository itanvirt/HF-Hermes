#!/usr/bin/env bash
# Runs the Hermes Agent messaging gateway on GATEWAY_PORT.
# If no Telegram bot token is configured, idles instead of crash-looping
# under supervisord.
set -uo pipefail

GATEWAY_PORT="${GATEWAY_PORT:-8642}"

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
    echo "[hermes-gateway] TELEGRAM_BOT_TOKEN not set; gateway idle. Configure secrets and restart."
    exec sleep infinity
fi

if ! command -v hermes >/dev/null 2>&1; then
    echo "[hermes-gateway] hermes binary not found; gateway idle."
    exec sleep infinity
fi

echo "[hermes-gateway] starting on port $GATEWAY_PORT"
exec hermes gateway --port "$GATEWAY_PORT" --telegram
