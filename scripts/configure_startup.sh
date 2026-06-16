#!/usr/bin/env bash
# Runs user-defined startup packages and scripts on every boot.
# Useful for installing tools or running setup that can't be baked into
# the image (HF Space containers are ephemeral, so manual installs are
# lost on restart unless replayed here).
#
# Environment variables:
#   STARTUP_APT_PACKAGES   space-separated apt packages to install
#   STARTUP_PIP_PACKAGES   space-separated pip packages to install
#   STARTUP_NPM_PACKAGES   space-separated npm packages to install
#   STARTUP_RUN            bash commands to execute (multi-line OK)
#   STARTUP_RUN_BASE64     same, but base64-encoded (for complex scripts)
#
# A persistent startup.sh file at data/startup.sh is also run if present.
# Create or edit it from Open Terminal to add commands that run on every
# boot (note: the file itself is ephemeral unless included in backups).
set -uo pipefail

LOG=/home/user/app/data/startup.log
mkdir -p /home/user/app/data
: > "$LOG"

_has_any() {
    [ -n "${1:-}" ]
}

if _has_any "${STARTUP_APT_PACKAGES:-}"; then
    echo "[startup] apt: ${STARTUP_APT_PACKAGES}" >>"$LOG"
    # shellcheck disable=SC2086
    sudo apt-get install -y -qq ${STARTUP_APT_PACKAGES} >>"$LOG" 2>&1 \
        || apt-get install -y -qq ${STARTUP_APT_PACKAGES} >>"$LOG" 2>&1 \
        || echo "[startup] apt install failed (may lack root; install manually)" >>"$LOG"
fi

if _has_any "${STARTUP_PIP_PACKAGES:-}"; then
    echo "[startup] pip: ${STARTUP_PIP_PACKAGES}" >>"$LOG"
    # shellcheck disable=SC2086
    pip install --user -q ${STARTUP_PIP_PACKAGES} >>"$LOG" 2>&1 \
        || echo "[startup] pip install failed" >>"$LOG"
fi

if _has_any "${STARTUP_NPM_PACKAGES:-}"; then
    echo "[startup] npm: ${STARTUP_NPM_PACKAGES}" >>"$LOG"
    # shellcheck disable=SC2086
    npm install -g ${STARTUP_NPM_PACKAGES} >>"$LOG" 2>&1 \
        || echo "[startup] npm install failed" >>"$LOG"
fi

if _has_any "${STARTUP_RUN_BASE64:-}"; then
    echo "[startup] running STARTUP_RUN_BASE64..." >>"$LOG"
    echo "${STARTUP_RUN_BASE64}" | base64 -d | bash >>"$LOG" 2>&1 \
        || echo "[startup] STARTUP_RUN_BASE64 failed" >>"$LOG"
elif _has_any "${STARTUP_RUN:-}"; then
    echo "[startup] running STARTUP_RUN..." >>"$LOG"
    bash -c "${STARTUP_RUN}" >>"$LOG" 2>&1 \
        || echo "[startup] STARTUP_RUN failed" >>"$LOG"
fi

STARTUP_SH="/home/user/app/data/startup.sh"
if [ -f "$STARTUP_SH" ]; then
    echo "[startup] running $STARTUP_SH..." >>"$LOG"
    bash "$STARTUP_SH" >>"$LOG" 2>&1 \
        || echo "[startup] $STARTUP_SH failed" >>"$LOG"
fi

echo "[startup] done." >>"$LOG"
