#!/usr/bin/env bash
set -uo pipefail

echo "=== Hermes Agent (HF Space) starting ==="

bash /home/user/app/scripts/configure_hermes.sh

exec supervisord -c /home/user/app/supervisord.conf
