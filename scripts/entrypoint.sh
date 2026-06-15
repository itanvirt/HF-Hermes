#!/usr/bin/env bash
set -uo pipefail

echo "=== Hermes Agent (HF Space) starting ==="

bash /home/user/app/scripts/configure_hermes.sh

# Best-effort, runs in the background so a slow/unreachable Cloudflare API
# doesn't delay startup.
bash /home/user/app/scripts/configure_keepawake.sh &

exec supervisord -c /home/user/app/supervisord.conf
