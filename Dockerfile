# Hermes Agent - self-hosted free-tier build for Hugging Face Spaces
FROM python:3.11-slim-bookworm

# --- system dependencies -----------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        git \
        ca-certificates \
        bash \
        build-essential \
        ffmpeg \
        procps \
        nodejs \
        npm \
        supervisor \
        && rm -rf /var/lib/apt/lists/*

# --- non-root user (required by Hugging Face Docker Spaces) ------------
RUN useradd -m -u 1000 user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:/home/user/.hermes/bin:$PATH

WORKDIR /home/user/app

# --- install Hermes Agent (official installer) --------------------------
# Run as the unprivileged user so it installs into $HOME, and run it in
# non-interactive mode so it doesn't block the build waiting on stdin.
USER user
ENV CI=1 \
    NONINTERACTIVE=1 \
    HERMES_NONINTERACTIVE=1
COPY --chown=user:user scripts/install_hermes.sh /home/user/app/scripts/install_hermes.sh
RUN bash /home/user/app/scripts/install_hermes.sh || \
    echo "WARN: Hermes Agent install did not complete at build time; entrypoint will retry at startup."

# --- python dependencies -------------------------------------------------
COPY --chown=user:user requirements.txt /home/user/app/requirements.txt
RUN pip install --no-cache-dir --user -r /home/user/app/requirements.txt

# --- application code -----------------------------------------------------
COPY --chown=user:user . /home/user/app

USER root
RUN chmod +x /home/user/app/scripts/*.sh && \
    mkdir -p /home/user/.hermes /home/user/app/data /var/log/supervisor && \
    chown -R user:user /home/user/.hermes /home/user/app/data /var/log/supervisor

USER user

EXPOSE 7860

HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -fsS http://127.0.0.1:7860/health || exit 1

ENTRYPOINT ["/home/user/app/scripts/entrypoint.sh"]
