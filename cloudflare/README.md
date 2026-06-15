# Cloudflare Worker (optional, advanced)

**You probably don't need this.** Keep-awake is already handled for free by
`.github/workflows/keep-awake.yml`, which pings `/health` every 15 minutes
with zero extra setup. This Worker is an alternative for people who'd
rather not depend on GitHub Actions, and/or who want the optional Telegram
webhook proxy:

1. **Keep-awake**: pings `/health` on a cron schedule so a free-tier Space
   stays awake. The Telegram gateway uses long-polling, so the container
   needs to stay running for the bot to keep responding.
2. **Telegram webhook proxy (optional/advanced)**: if you've manually
   switched Hermes to webhook mode (`TELEGRAM_WEBHOOK_URL` /
   `TELEGRAM_WEBHOOK_PORT`, see the Hermes Agent docs) instead of the
   default long-polling, this proxies Telegram's webhook updates to the
   Space, attaching the `GATEWAY_TOKEN` bearer header that Telegram itself
   can't send. Not needed for the default setup.

## Prerequisites

- [Node.js](https://nodejs.org/) and `npx` available locally.
- A Cloudflare account and an API token with **Edit Cloudflare Workers**
  permission (this is the value you put in the `CLOUDFLARE_WORKERS_TOKEN`
  Space secret).

## Deploy

```bash
cd cloudflare
export CLOUDFLARE_API_TOKEN=<your CLOUDFLARE_WORKERS_TOKEN value>
npx wrangler deploy
```

This publishes the worker to
`https://hermes-agent-proxy.<your-subdomain>.workers.dev`.

## Configure secrets

```bash
npx wrangler secret put SPACE_URL
# -> https://<owner>-<space>.hf.space   (no trailing slash)
```

The `GATEWAY_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` secrets are only needed if
you're using the optional Telegram webhook proxy below.

```bash
npx wrangler secret put GATEWAY_TOKEN
# -> same value as the Space's GATEWAY_TOKEN secret

npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
# -> any random string, e.g. `openssl rand -hex 20`
```

## (Optional) Point Telegram at the worker for webhook mode

Only needed if you've configured Hermes for webhook mode instead of the
default long-polling. Register the webhook with Telegram, using the same
`TELEGRAM_WEBHOOK_SECRET` value as the `secret_token`:

```bash
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://hermes-agent-proxy.<your-subdomain>.workers.dev/telegram" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
```

## Verify keep-awake

The cron trigger runs every 10 minutes (edit `wrangler.toml` to change the
schedule) and calls `${SPACE_URL}/health`. You can trigger it manually for
testing:

```bash
npx wrangler tail        # in one terminal, to watch logs
curl https://hermes-agent-proxy.<your-subdomain>.workers.dev/health
```
