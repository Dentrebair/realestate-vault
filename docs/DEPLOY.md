# Deploying to Railway

One Railway service runs everything: the bot, the lead board and the retention clock. It must deploy the **`telegram`
branch** (the default branch, `main`, is the WhatsApp version).

## Before you start

- **Stop the copy on your laptop.** A bot can be served by polling or by a webhook, not both. Once the deployed service
  registers its webhook, a laptop copy polling at the same time fights it.
- **Do not paste secrets into chat, issues or commits.** Type them into Railway's Variables page yourself.
- The Supabase SQL for the features you want should be run first. Order: `001`, `002`, `003`, `004`, `005`. The bot still
  works if `004` or `005` is missing (agreeing, answers and photos all degrade gracefully), but knowledge gaps and the
  access and deletion logs are not saved until they exist.

## Steps

1. Railway: **New Project, Deploy from GitHub repo**, choose `Dentrebair/realestate-vault`, and set the branch to
   `telegram` (Service, Settings, Source).
2. **Variables**, from the table below.
3. **Settings, Networking, Generate Domain.** This is required: Telegram needs a public https address for the webhook. The
   service picks up `RAILWAY_PUBLIC_DOMAIN` by itself, so you do not set `PUBLIC_BASE_URL`.
4. **Settings, Region**: choose one near your Supabase project (its region is in the Supabase dashboard, Settings, General).
5. **Replicas: 1.** The duplicate-message check, the rate limit and the one-message-at-a-time queue live in memory.
6. Deploy. In **Deployments, View logs** you should see:
   ```
   Connector listening on port <n> (production)
   Telegram webhook set to https://<your-domain>/telegram/webhook
   ```
   If the second line says the webhook mode needs `PUBLIC_BASE_URL`, the domain has not been generated yet.

## Variables

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` | from Supabase, Settings, API |
| `TELEGRAM_BOT_TOKEN` | from @BotFather (rotate it first if it was ever shared) |
| `TELEGRAM_WEBHOOK_SECRET` | a long random string; `openssl rand -hex 32`. Production should use its own, not your laptop's |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | `gpt-5-mini`, and optionally `OPENAI_REASONING_EFFORT=minimal` |
| `SALES_DESK_CHAT_ID` | the chat that receives site visit alerts |
| `BUSINESS_NAME`, `PRIVACY_CONTACT` | named in the privacy notice. Set these before real customers |
| `BUSINESS_HOURS`, `TEAM_CONFIRM_LINE` | wording customers see. Keep the defaults only if they are true |
| `BOARD_SHOW_CONVERSATIONS` | `test`, `all` or `none` |
| `CHAT_RETENTION_HOURS`, `LEAD_RETENTION_HOURS` | `24` and `24` for a demo; `720` and `8760` otherwise |

Leave unset: `PORT` (Railway sets it), `PUBLIC_BASE_URL`, `TELEGRAM_MODE`, `ENABLE_TOOL_ROUTES` and
`CONNECTOR_BEARER_TOKEN` (the old WhatsApp-style HTTP routes stay off in production; the service refuses to start if they
are turned on without a token).

## Check it works

1. `https://<your-domain>/health` returns `ok: true`, `supabaseConfigured: true`, `telegramConfigured: true`.
2. In Telegram, `/start` on a fresh account asks for agreement; tap **I agree**; ask for `3BHK in OMR under 1.5 crore`.
3. `https://<your-domain>/admin/`: sign in, find the lead, move its stage, open **Listings** and **Knowledge**.
4. Tap **Book Site Visit** and confirm the alert reaches the Sales desk chat.

## If something is wrong

- **The bot does not answer.** Check the logs for errors. Ask Telegram what it knows: open
  `https://api.telegram.org/bot<TOKEN>/getWebhookInfo` in a browser (substitute your token locally; do not share the
  address). `last_error_message` says what failed. A `409 Conflict` means another copy is polling.
- **Webhook "not set".** Generate the domain, then redeploy.
- **Cannot sign in to the board.** The account needs to exist in Supabase Auth and be on the staff list
  (`npm run add-staff`); `SUPABASE_ANON_KEY` must be set; sessions use secure cookies, so use the `https` address.
- **Photos do not load in the board.** The page may only load images from your `SUPABASE_URL`; check that variable.
- **Running locally again.** `npm start` on your laptop deletes the webhook so it can poll, which silences the deployed
  bot. Redeploy or restart the Railway service afterwards to register the webhook again.
- **Roll back.** Redeploy an earlier commit from Deployments. Data lives in Supabase and is unaffected.
