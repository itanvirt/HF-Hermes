#!/usr/bin/env bash
# Auto-deploys a tiny Cloudflare Worker that pings this Space's /health
# endpoint on a schedule, so the free-tier Space doesn't go to sleep.
# Runs on every container start; best-effort and non-fatal. Skipped if
# CLOUDFLARE_WORKERS_TOKEN or SPACE_HOST aren't set (e.g. local dev).
set -uo pipefail

STATE_FILE="${KEEPAWAKE_STATE_FILE:-/home/user/app/data/keepawake_state.json}"
LOG=/home/user/app/data/keepawake-setup.log
mkdir -p "$(dirname "$STATE_FILE")"
: > "$LOG"

write_state() {
    python3 - "$STATE_FILE" "$1" "$2" "$3" <<'PYEOF'
import json, sys, datetime
state_file, status, worker, target = sys.argv[1:5]
json.dump({
    "status": status,
    "worker": worker or None,
    "target": target or None,
    "at": datetime.datetime.utcnow().strftime("%H:%M:%S"),
}, open(state_file, "w"))
PYEOF
}

if [ -z "${CLOUDFLARE_WORKERS_TOKEN:-}" ]; then
    echo "[keepawake] CLOUDFLARE_WORKERS_TOKEN not set; skipping." >>"$LOG"
    write_state "not configured" "" ""
    exit 0
fi

if [ -z "${SPACE_HOST:-}" ]; then
    echo "[keepawake] SPACE_HOST not set (not running on Hugging Face?); skipping." >>"$LOG"
    write_state "not configured" "" ""
    exit 0
fi

API="https://api.cloudflare.com/client/v4"
TARGET="https://${SPACE_HOST}/health"

# Resolve the Cloudflare account id: prefer an explicit override, else ask
# the API for the accounts this token can see.
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
if [ -z "$ACCOUNT_ID" ]; then
    ACCOUNT_ID=$(curl -fsS -H "Authorization: Bearer ${CLOUDFLARE_WORKERS_TOKEN}" "$API/accounts" \
        | python3 -c 'import json,sys; d=json.load(sys.stdin); r=d.get("result") or []; print(r[0]["id"] if r else "")' 2>>"$LOG" || true)
fi

if [ -z "$ACCOUNT_ID" ]; then
    echo "[keepawake] could not determine Cloudflare account id from the API. Set the CLOUDFLARE_ACCOUNT_ID secret (Cloudflare dashboard -> Workers & Pages -> Account ID, right sidebar) and restart." >>"$LOG"
    write_state "error" "" "$TARGET"
    exit 0
fi

# Worker script name derived from the Space host (must be a valid Cloudflare
# script name: lowercase letters, digits, hyphens).
WORKER_NAME="keepawake-$(echo "$SPACE_HOST" | sed -E 's/\.hf\.space$//; s/[^a-zA-Z0-9-]/-/g' | tr '[:upper:]' '[:lower:]' | cut -c1-50)"

cat > /tmp/keepawake-worker.js <<EOF
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetch("${TARGET}").catch(() => {}));
  },
  async fetch() {
    return new Response("ok");
  },
};
EOF

if curl -fsS -X PUT \
        -H "Authorization: Bearer ${CLOUDFLARE_WORKERS_TOKEN}" \
        "$API/accounts/$ACCOUNT_ID/workers/scripts/$WORKER_NAME" \
        -F 'metadata={"main_module":"worker.js","compatibility_date":"2024-09-01"};type=application/json' \
        -F "worker.js=@/tmp/keepawake-worker.js;type=application/javascript+module" \
        >>"$LOG" 2>&1 \
    && curl -fsS -X PUT \
        -H "Authorization: Bearer ${CLOUDFLARE_WORKERS_TOKEN}" \
        -H "Content-Type: application/json" \
        "$API/accounts/$ACCOUNT_ID/workers/scripts/$WORKER_NAME/schedules" \
        -d '[{"cron":"*/10 * * * *"}]' \
        >>"$LOG" 2>&1
then
    echo "[keepawake] deployed Cloudflare Worker '$WORKER_NAME' pinging $TARGET every 10 min." >>"$LOG"
    write_state "configured" "$WORKER_NAME" "$TARGET"
else
    echo "[keepawake] Cloudflare Worker deploy failed; see entries above." >>"$LOG"
    write_state "error" "$WORKER_NAME" "$TARGET"
fi
