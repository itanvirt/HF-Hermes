"""Collects the data shown on the landing page status cards."""
import asyncio
import json
import os
import shutil
import time
from pathlib import Path

START_TIME = time.time()
APP_PORT = int(os.environ.get("PORT", "7860"))
BACKUP_STATE_FILE = Path(os.environ.get("BACKUP_STATE_FILE", "/home/user/app/data/backup_state.json"))
KEEPAWAKE_STATE_FILE = Path(os.environ.get("KEEPAWAKE_STATE_FILE", "/home/user/app/data/keepawake_state.json"))


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
    # `hermes gateway run` uses Telegram long-polling and opens no port, so
    # liveness is checked via the process itself rather than an HTTP probe.
    online = False
    try:
        proc = await asyncio.create_subprocess_exec(
            "pgrep", "-f", "hermes gateway",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()
        online = proc.returncode == 0
    except Exception:
        online = False
    return {
        "online": online,
        "telegram_configured": bool(os.environ.get("TELEGRAM_BOT_TOKEN")),
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
    space_host = os.environ.get("SPACE_HOST", "")
    default_target = f"https://{space_host}/health" if space_host else "<your-space>.hf.space/health"
    if KEEPAWAKE_STATE_FILE.exists():
        try:
            data = json.loads(KEEPAWAKE_STATE_FILE.read_text())
            status = data.get("status")
            if status == "configured":
                worker = data.get("worker")
                return {
                    "configured": True,
                    "via": f"Cloudflare Worker ({worker})" if worker else "Cloudflare Worker",
                    "target": data.get("target") or default_target,
                }
            if status == "error":
                return {
                    "configured": False,
                    "via": "Cloudflare Worker deploy failed (see data/keepawake-setup.log)",
                    "target": data.get("target") or default_target,
                }
        except Exception:
            pass
    cf_token = os.environ.get("CLOUDFLARE_WORKERS_TOKEN", "")
    return {
        "configured": False,
        "via": "pending (deploying on boot)" if cf_token else "not configured",
        "target": default_target,
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
