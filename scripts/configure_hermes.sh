#!/usr/bin/env bash
# Translates Space secrets / env vars into Hermes Agent configuration.
# Runs on every container start (entrypoint.sh), so it must be idempotent.
set -uo pipefail

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HERMES_HOME"

# Re-install if the build-time install didn't complete (e.g. installer
# needed network access that wasn't available during image build).
if ! command -v hermes >/dev/null 2>&1; then
    echo "[configure_hermes] hermes binary not found, retrying install..."
    bash "$(dirname "$0")/install_hermes.sh" || true
fi

# --- map LLM_MODEL -> the API key env var the matching provider expects ---
# Hermes Agent reads provider credentials from these standard env vars.
case "${LLM_MODEL:-}" in
    gemini*|*gemini*)
        export GEMINI_API_KEY="${LLM_API_KEY:-}"
        ;;
    gpt-*|o1*|o3*|o4*|*openai*)
        export OPENAI_API_KEY="${LLM_API_KEY:-}"
        ;;
    claude*|*anthropic*)
        export ANTHROPIC_API_KEY="${LLM_API_KEY:-}"
        ;;
    openrouter/*|*openrouter*)
        export OPENROUTER_API_KEY="${LLM_API_KEY:-}"
        ;;
    *)
        # Unknown provider prefix: export both the generic var and a best
        # guess so `hermes model` can still pick it up.
        export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-${LLM_API_KEY:-}}"
        ;;
esac

# Generic vars some Hermes versions read directly.
export HERMES_MODEL="${LLM_MODEL:-}"
export HERMES_API_KEY="${LLM_API_KEY:-}"

# --- non-interactive setup -------------------------------------------------
# Best-effort: newer Hermes CLIs support `hermes setup --non-interactive`
# with flags for model + telegram. If the flags don't exist on the
# installed version, this fails harmlessly and the operator can finish
# configuration from the in-browser terminal ("Open Hermes Agent" / "Open
# Terminal" -> `hermes setup`).
if command -v hermes >/dev/null 2>&1; then
    hermes setup --non-interactive \
        --model "${LLM_MODEL:-}" \
        ${TELEGRAM_BOT_TOKEN:+--telegram-bot-token "$TELEGRAM_BOT_TOKEN"} \
        ${TELEGRAM_ALLOWED_USERS:+--telegram-allowed-users "$TELEGRAM_ALLOWED_USERS"} \
        >/home/user/app/data/hermes-setup.log 2>&1 || \
        echo "[configure_hermes] 'hermes setup --non-interactive' did not complete; configure manually via the in-browser terminal." \
            >>/home/user/app/data/hermes-setup.log
fi

# Always write a plain .env file in HERMES_HOME too, in case the installed
# version reads its config from there instead of process env.
cat > "$HERMES_HOME/.env" <<EOF
HERMES_MODEL=${LLM_MODEL:-}
HERMES_API_KEY=${LLM_API_KEY:-}
GEMINI_API_KEY=${GEMINI_API_KEY:-}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
TELEGRAM_ALLOWED_USERS=${TELEGRAM_ALLOWED_USERS:-}
EOF
chmod 600 "$HERMES_HOME/.env"

echo "[configure_hermes] done."
