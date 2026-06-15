# Cloudflare Worker: Telegram proxy + keep-awake

This Worker does two things for the Hermes Agent Space:

1. Proxies Telegram webhook updates to the Space, attaching the
   `GATEWAY_TOKEN` bearer header that Telegram itself can't send.
2. Pings `/health` on a cron schedule so a free-tier Space stays awake.

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

npx wrangler secret put GATEWAY_TOKEN
# -> same value as the Space's GATEWAY_TOKEN secret

npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
# -> any random string, e.g. `openssl rand -hex 20`
```

## Point Telegram at the worker

Register the webhook with Telegram, using the same
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
