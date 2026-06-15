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

# --- map LLM_MODEL -> provider id + the API key env var Hermes expects ----
case "${LLM_MODEL:-}" in
    gemini*|*gemini*)
        HERMES_PROVIDER="google"
        export GOOGLE_API_KEY="${LLM_API_KEY:-}"
        ;;
    gpt-*|o1*|o3*|o4*|*openai*)
        HERMES_PROVIDER="openai"
        export OPENAI_API_KEY="${LLM_API_KEY:-}"
        ;;
    claude*|*anthropic*)
        HERMES_PROVIDER="anthropic"
        export ANTHROPIC_API_KEY="${LLM_API_KEY:-}"
        ;;
    openrouter/*|*openrouter*)
        HERMES_PROVIDER="openrouter"
        export OPENROUTER_API_KEY="${LLM_API_KEY:-}"
        ;;
    *)
        # Unknown prefix: assume an OpenRouter-style "vendor/model" id.
        HERMES_PROVIDER="openrouter"
        export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-${LLM_API_KEY:-}}"
        ;;
esac

# Always write the provider keys + Telegram config to ~/.hermes/.env, which
# Hermes loads on startup (required for secrets per the Hermes config docs).
cat > "$HERMES_HOME/.env" <<EOF
GOOGLE_API_KEY=${GOOGLE_API_KEY:-}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
TELEGRAM_ALLOWED_USERS=${TELEGRAM_ALLOWED_USERS:-}
EOF
chmod 600 "$HERMES_HOME/.env"

# --- non-interactive model selection ---------------------------------------
# `hermes config set` writes non-secret settings to ~/.hermes/config.yaml.
# Best-effort: logs failures instead of failing the container start, so the
# operator can finish configuration from the in-browser terminal
# ("Open Hermes Agent" / "Open Terminal" -> `hermes config` / `hermes model`).
if command -v hermes >/dev/null 2>&1 && [ -n "${LLM_MODEL:-}" ]; then
    {
        hermes config set model.default "${LLM_MODEL}"
        hermes config set model.provider "${HERMES_PROVIDER}"
    } >/home/user/app/data/hermes-setup.log 2>&1 || \
        echo "[configure_hermes] 'hermes config set' did not complete; configure manually via the in-browser terminal." \
            >>/home/user/app/data/hermes-setup.log
fi

echo "[configure_hermes] done."
