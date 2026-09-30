# Chennai Real Estate Assistant (Telegram)

A Telegram bot that helps people find Chennai property and moves them through a sales pipeline, plus a
lead board where the sales team watches every lead by stage.

This is the `telegram` branch. The WhatsApp connector lives on `main`. Vocabulary is in [CONTEXT.md](CONTEXT.md),
the plan and decisions in [docs/SPRINT_PLAN.md](docs/SPRINT_PLAN.md), and the demo script in [docs/DEMO.md](docs/DEMO.md).

## What it does

- **Match and recommend.** The customer says what they want in plain English. The bot shows properties that fit.
  When nothing fits exactly, it shows the closest one to three, each labelled with how it differs
  ("1 bedroom fewer", "₹1.8 Cr over your budget", "about 4 km from OMR"). Sold and reserved listings are never shown.
- **Track the pipeline.** Every lead has a stage: initiated, interested, negotiating, site visit ready, closed, or
  not interested. The bot moves leads forward as they act; the sales team can correct any stage.
- **Hand over hot leads.** Tapping Book Site Visit alerts the Sales desk on Telegram.
- **Lead board.** A web page for staff with leads in stage columns, each lead's history, and a list of what customers
  asked for that the inventory could not meet.

## How it fits together

```
Telegram ──▶ bot (grammY) ──▶ model (OpenAI) ◀──▶ tools: search, details, save requirements, site visit
                 │                                          │
                 ▼                                          ▼
         cards and buttons                      matching engine + lead store
                 │                                          │
                 └──────────────▶ Supabase ◀────────────────┘
                                      ▲
                          lead board (staff sign-in)
```

Cards, prices and stage changes are made by code, not by the model. The model writes short plain-text replies and
decides which tool to call. Checks around it stop it inventing prices, promising discounts or creating hot leads.

## Setup

You need Node 20 or newer, a Supabase project, an OpenAI key and a Telegram bot from @BotFather.

```bash
npm install
cp .env.example .env        # then fill it in; see the comments in the file
```

Run these in the Supabase SQL editor, in order:

1. [sql/001_prototype_schema.sql](sql/001_prototype_schema.sql) creates the lead tables.
2. [sql/002_admin.sql](sql/002_admin.sql) creates the staff list for the board.

The listings themselves live in a `properties` table that already exists in the project.

Load the 50 test leads:

```bash
npm run seed:test-leads
```

## Run

```bash
npm start
```

With `NODE_ENV=development` the bot uses polling, so no public address is needed: message your bot and it answers.
In production it uses a webhook and needs `PUBLIC_BASE_URL` (Railway's domain is picked up automatically).

## Lead board

Open http://localhost:3000/admin/.

To let someone in:

1. Supabase dashboard, Authentication, Users, Add user, Create new user. Type their email and a password and tick
   **Auto Confirm User**. Do not send passwords through chat or email.
2. `npm run add-staff -- their@email.com admin` (use `viewer` for read-only).
3. Authentication, Sign In / Providers, turn off **Allow new users to sign up**.

Admins can move leads between stages; viewers can only look. Each move is recorded with who made it.
`BOARD_SHOW_CONVERSATIONS` decides who can read what customers actually typed: `test` (test leads only, the default),
`all`, or `none`. Decide this before real customers use the bot.

A lead can be linked directly: `/admin/#lead=telegram:123456`.

## Test leads and the demo

`test/fixtures/testLeads.js` holds 50 made-up leads written against the real inventory: clean matches, near misses,
missing information, vague or conflicting requests, returning customers, a discount request, a rental request, a
Tanglish message and a prompt-injection attempt.

| Command | What it does |
|---|---|
| `npm run seed:test-leads` | Insert or refresh all 50 (safe to repeat) |
| `npm run demo:reset` | Delete every test lead and load them again |
| `node scripts/seed-test-leads.js --adopt 043 <your Telegram id>` | Give your account that lead's profile and a clean conversation, then chat as them |
| `node scripts/seed-test-leads.js --clean` | Delete every test lead |
| `node scripts/seed-test-leads.js --dry` | Check the fixture against the live inventory; write nothing |

Your Telegram id is in your lead's id on the board (`telegram:<id>`).

## Tests and evals

```bash
npm test                       # about 110 tests, offline, a few seconds
npm run eval                   # 36 leads through the real model, about a minute
npm run eval -- --all          # all 50
npm run eval -- --lead 011,014 --verbose
node scripts/try-agent.js "3BHK in OMR under 1.5 crore"    # one conversation, nothing saved
```

Evals call OpenAI (about 230,000 tokens for a full run) and check behaviour, not wording: which tools were called,
which cards were shown or hidden, the stage each lead ended in, and forbidden content. The model is not perfectly
consistent, so a single failure is worth re-running before changing anything.

## Project layout

```
src/telegram/   the bot: pipeline, agent and tools, cards, buttons, commands, guards
src/admin/      lead board: sign-in, routes, data, and the page in public/
src/matching.js, microMarkets.js, propertyTypes.js, money.js   search and recommendations
src/leadMemory.js, stages.js                                     lead store and stage rules
sql/            database setup          test/           tests and fixtures
evals/          model evals             scripts/        seeding and helpers
```

## Safety, in short

- Webhook requests need a secret header, compared in constant time.
- Staff passwords are checked by Supabase; sessions live in HttpOnly, SameSite=Strict cookies; the staff list decides who may enter.
- Lead tables are locked to the server. The public Supabase key cannot read them.
- Customer text is shown on the board as plain text only.
- The HTTP tool routes are off in production unless `ENABLE_TOOL_ROUTES=true`, and then need `CONNECTOR_BEARER_TOKEN`.
- Secrets live in `.env`, which is not committed. If one is ever pasted somewhere it should not be, rotate it.

## Deploying to Railway (not done yet)

Deliberately left for last, after the Phase 2 work: create a Railway project from this repository's `telegram` branch, set the
variables from `.env.example` (leave `TELEGRAM_MODE` empty, `NODE_ENV=production`), and Railway's domain becomes the
webhook address. One instance is assumed; the duplicate-message and rate-limit guards live in memory.

## Troubleshooting

- **The bot does not answer.** Check the terminal for `Telegram bot @... is polling`. Two copies running at once
  fight over updates; stop the other one.
- **"customer_leads is not usable".** Run the SQL files above.
- **Sales alerts do not arrive.** Set `SALES_DESK_CHAT_ID` and send the bot `/start` from that account first; a bot
  cannot message someone who has not started it.
- **Cannot sign in to the board.** The account must exist in Supabase Auth and be on the staff list
  (`npm run add-staff`). `SUPABASE_ANON_KEY` must be set.
