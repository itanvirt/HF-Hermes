"""Collects the data shown on the landing page status cards."""
import json
import os
import shutil
import time
from pathlib import Path

import httpx

START_TIME = time.time()
GATEWAY_PORT = int(os.environ.get("GATEWAY_PORT", "8642"))
APP_PORT = int(os.environ.get("PORT", "7860"))
BACKUP_STATE_FILE = Path(os.environ.get("BACKUP_STATE_FILE", "/home/user/app/data/backup_state.json"))


def _format_duration(seconds: float) -> str:
    seconds = int(seconds)
    days, seconds = divmod(seconds, 86400)
    hours, seconds = divmod(seconds, 3600)
    minutes, _ = divmod(seconds, 60)
    parts = []
    if days:
        parts.append(f"{days}d")
    parts.append(f"{hours}h")
    parts.append(f"{minutes}m")
    return " ".join(parts)


async def gateway_status() -> dict:
    online = False
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(f"http://127.0.0.1:{GATEWAY_PORT}/health")
            online = resp.status_code < 500
    except Exception:
        online = False
    return {
        "online": online,
        "port": GATEWAY_PORT,
        "protected": bool(os.environ.get("GATEWAY_TOKEN")),
    }


def model_status() -> dict:
    model = os.environ.get("LLM_MODEL", "")
    provider = "unknown"
    lowered = model.lower()
    if "gemini" in lowered:
        provider = "gemini"
    elif lowered.startswith("gpt") or "openai" in lowered:
        provider = "openai"
    elif "claude" in lowered or "anthropic" in lowered:
        provider = "anthropic"
    elif "openrouter" in lowered:
        provider = "openrouter"
    return {
        "model": model or "not configured",
        "provider": provider,
        "configured": bool(os.environ.get("LLM_API_KEY")),
    }


def runtime_status() -> dict:
    return {
        "uptime": _format_duration(time.time() - START_TIME),
        "port": APP_PORT,
    }


def telegram_status() -> dict:
    configured = bool(os.environ.get("TELEGRAM_BOT_TOKEN")) and bool(
        os.environ.get("TELEGRAM_ALLOWED_USERS")
    )
    return {
        "configured": configured,
        "via": "Webhook via Cloudflare Worker proxy",
    }


def backup_status() -> dict:
    if BACKUP_STATE_FILE.exists():
        try:
            data = json.loads(BACKUP_STATE_FILE.read_text())
            return data
        except Exception:
            pass
    hf_token = os.environ.get("HF_TOKEN", "")
    return {
        "status": "pending" if hf_token else "not configured",
        "repo": None,
        "at": None,
    }


def keep_awake_status() -> dict:
    worker_url = os.environ.get("CF_WORKER_URL", "")
    space_host = os.environ.get("SPACE_HOST", "")
    target = f"https://{space_host}/health" if space_host else "<your-space>.hf.space/health"
    return {
        "configured": bool(worker_url),
        "via": "CF Cron",
        "target": target,
    }


def disk_status() -> dict:
    total, used, free = shutil.disk_usage("/home/user")
    return {"total": total, "used": used, "free": free}


async def full_status() -> dict:
    return {
        "gateway": await gateway_status(),
        "model": model_status(),
        "runtime": runtime_status(),
        "telegram": telegram_status(),
        "backup": backup_status(),
        "keep_awake": keep_awake_status(),
    }
