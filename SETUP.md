# Setup guide

## 1. Create the Hugging Face Space

1. On Hugging Face, create a new Space: **Docker** SDK, free CPU hardware.
2. Note its owner/name, e.g. `itanvirt/hf_hermes` — you'll need this for
   the sync workflow and the Cloudflare Worker config.

## 2. Add Space secrets

Settings → Variables and secrets → **New secret** for each of:

- `HF_TOKEN` — create one at https://huggingface.co/settings/tokens with
  **write** access (needed to create/update the `hermes-backup` dataset).
- `CLOUDFLARE_WORKERS_TOKEN` — Cloudflare API token with
  "Edit Cloudflare Workers" permission.
- `TELEGRAM_ALLOWED_USERS` — your Telegram numeric user ID(s),
  comma-separated. Get yours from `@userinfobot` on Telegram.
- `TELEGRAM_BOT_TOKEN` — from `@BotFather` (`/newbot`).
- `GATEWAY_TOKEN` — generate with `openssl rand -hex 24`.
- `LLM_MODEL` — e.g. `gemini-2.5-flash` (Gemini has a free tier).
- `LLM_API_KEY` — API key matching `LLM_MODEL`'s provider.

Anyone who later duplicates this Space will be prompted for the same list
of secret names (without values).

## 3. Sync this GitHub repo to the Space

The workflow in `.github/workflows/sync-to-hf.yml` pushes this repo to
`huggingface.co/spaces/itanvirt/hf_hermes` on every push to `main`.

1. Create a Hugging Face token with **write** access (can be the same
   token as `HF_TOKEN` above, or a separate one).
2. In the GitHub repo: Settings → Secrets and variables → Actions →
   **New repository secret** → name it `HF_TOKEN`, paste the token.
3. If your target Space has a different owner/name, edit `HF_SPACE` in
   `.github/workflows/sync-to-hf.yml`.
4. Push to `main` (or run the workflow manually from the Actions tab).

## 4. First boot

- Open the Space. The dashboard shows live status for the gateway, model,
  runtime, Telegram, backup and keep-awake.
- Click **Open Terminal** or **ENV Builder**, and unlock with the
  `GATEWAY_TOKEN` value you set in step 2.
- On boot, the container writes your `LLM_MODEL` / `LLM_API_KEY` and
  Telegram secrets into `~/.hermes/.env` and runs `hermes config set` to
  select the model and provider. The gateway then starts with
  `hermes gateway run`, which talks to Telegram via long-polling — your bot
  should come online within seconds of the Space starting. If anything
  looks off, check `data/hermes-setup.log` or finish configuration from
  **Open Hermes Agent** or **Open Terminal** (`hermes config`, `hermes
  model`), then click **Restart agent** in ENV Builder.

## 5. Cloudflare Worker (keep-awake)

See `cloudflare/README.md`. Summary:

```bash
cd cloudflare
export CLOUDFLARE_API_TOKEN=<CLOUDFLARE_WORKERS_TOKEN value>
npx wrangler deploy
npx wrangler secret put SPACE_URL  # https://<owner>-<space>.hf.space
```

The Telegram gateway uses long-polling, so the only thing the Worker needs
to do is keep the Space awake. The `GATEWAY_TOKEN` /
`TELEGRAM_WEBHOOK_SECRET` secrets and the `setWebhook` call are only needed
for the optional Telegram webhook proxy mode — see `cloudflare/README.md`.

## 6. Backups

Every `BACKUP_INTERVAL_HOURS` (default 6), the Space tars `~/.hermes`
(excluding secret files) and uploads it to a private dataset
`<your-hf-username>/hermes-backup`. Override the target with the
`BACKUP_DATASET_REPO` env var if you want a different repo name.
