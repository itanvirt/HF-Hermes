"""Lightweight session auth gating the terminal, ENV Builder and gateway proxy.

A single shared secret (GATEWAY_TOKEN) acts as the password. Successful
login sets a signed cookie so the browser doesn't need to resend the token
on every request.
"""
import os

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

COOKIE_NAME = "hermes_session"
SESSION_MAX_AGE = 60 * 60 * 12  # 12 hours

GATEWAY_TOKEN = os.environ.get("GATEWAY_TOKEN", "")


def _serializer() -> URLSafeTimedSerializer:
    secret = GATEWAY_TOKEN or "hermes-agent-insecure-default"
    return URLSafeTimedSerializer(secret, salt="hermes-session")


def gateway_token_configured() -> bool:
    return bool(GATEWAY_TOKEN)


def issue_session_cookie() -> str:
    return _serializer().dumps({"ok": True})


def verify_session_cookie(value: str | None) -> bool:
    if not value or not gateway_token_configured():
        return False
    try:
        data = _serializer().loads(value, max_age=SESSION_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return False
    return bool(data.get("ok"))


def verify_token(token: str) -> bool:
    return gateway_token_configured() and token == GATEWAY_TOKEN


def verify_bearer(header_value: str | None) -> bool:
    if not header_value or not header_value.startswith("Bearer "):
        return False
    return verify_token(header_value.removeprefix("Bearer ").strip())
