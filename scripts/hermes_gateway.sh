#!/usr/bin/env bash
# Runs the Hermes Agent messaging gateway (Telegram long-polling).
# If no Telegram bot token is configured, idles instead of crash-looping
# under supervisord.
set -uo pipefail

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
    echo "[hermes-gateway] TELEGRAM_BOT_TOKEN not set; gateway idle. Configure secrets and restart."
    exec sleep infinity
fi

if ! command -v hermes >/dev/null 2>&1; then
    echo "[hermes-gateway] hermes binary not found; gateway idle."
    exec sleep infinity
fi

echo "[hermes-gateway] starting (Telegram long-polling)"
exec hermes gateway run
