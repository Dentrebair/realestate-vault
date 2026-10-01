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
3. [sql/003_photos.sql](sql/003_photos.sql) creates the photo table and the public `property-photos` storage bucket.
4. [sql/004_knowledge.sql](sql/004_knowledge.sql) creates the tables for knowledge gaps and approved answers.
5. [sql/005_privacy.sql](sql/005_privacy.sql) adds the consent version, the staff access log and the deletion log.

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

### Listing photos

The board's **Listings** tab is where photos are managed. Open a listing, choose images, and they upload. Admins can
reorder (◀ ▶) and delete; viewers can only look. Up to 10 photos per listing, JPEG, PNG or WebP, at most 5 MB each. The
browser shrinks every image to 1600 pixels and re-encodes it, which also removes location data from phone photos; the server
then checks the file really is an image.

In Telegram, a listing with photos is sent as its first photo with the property details as the caption. A second row of
buttons, ◀ 2/5 ▶, swaps the picture in place, so the card works as a carousel. Listings without photos stay as text cards.
If Telegram cannot fetch a photo, the card is sent as text instead. Photos are public links, because customers see them.

## Staying truthful

Every factual statement the assistant makes must trace to its context: the listing data, what the customer said, their
saved profile, an answer an owner approved, or a fixed policy line. Anything else it must not state.

How that is enforced, from strongest to weakest:

1. **Code answers what code can know.** Availability, stock counts, business hours, listing details such as parking or
   floor, comparisons, and "no match" replies are written from the database, not by the model. Suggested areas come from
   the inventory.
2. **Questions we cannot answer are saved, not guessed.** "Does it have parking?" for a listing that does not say, or
   "is there a good school nearby?", gets a plain "I do not have that" and is saved as a **knowledge gap** with the
   customer's request as JSON.
3. **Owners fill the gaps.** The board's **Knowledge** tab lists open gaps, grouped by what was asked and how often. An
   admin writes the answer once; it becomes an approved answer, and the next customer who asks gets it. An answer can be
   for one property, for an area, or for everyone. Approved answers are also given to the model as facts.
4. **Checks on what the model still writes** remove offers of things we cannot do ("I'll ask the seller", "I can send
   the brochure"), general knowledge about areas, and place names that did not come from the data or the customer.
5. **The model's prompt** lists what it knows, what it can do and what it cannot, and bans guessing.

`TEAM_CONFIRM_LINE` is the sentence used when a detail is missing. Keep the default only if your team really can confirm
details at a site visit.

Measure it with the audits:

```bash
node evals/grounding.js                # 41 questions the assistant has no data for, judged by a second model
npm run eval -- --all --judge          # the 50 normal conversations, judged the same way
```

The judge is a model too and is noisy, so read what it flags. Each new feature should add questions to these before it ships.

## Privacy

The privacy notice and the settings behind it are a **draft that a lawyer should review before real customers use the
bot.** India's data protection law expects clear notice, consent, access and deletion; this implements those, but it is
not legal advice.

- **Consent first.** A new customer is asked to tap **I agree** before anything else. Until they do, the bot holds only their
  Telegram id: no name, no username, no messages saved, nothing sent to the AI. A campaign code from a `/start` link is held
  aside and stored only after they agree.
- **Their commands.** `/privacy` shows the notice, `/mydata` lists exactly what is held, and `/forget` deletes the profile,
  shortlist, messages, history and unanswered questions after a confirmation. A deletion leaves only a one-way hash as proof.
- **Retention.** Messages are deleted after `CHAT_RETENTION_HOURS` (default 30 days) and real leads idle for
  `LEAD_RETENTION_HOURS` (default 12 months). Test leads are never deleted. The server runs this every six hours;
  `npm run retention` runs it now.
- **Staff.** Viewers cannot see phone numbers or conversations. Admins can, where `BOARD_SHOW_CONVERSATIONS` allows, and each
  time one does it is recorded in the board's **Access log** tab (once per staff member per lead per 30 minutes).
- **Logs** never carry message text; a test checks this.
- **Set `BUSINESS_NAME` and `PRIVACY_CONTACT`** so the notice names the business and says how to reach it.
- Alerts already sent to the Sales desk chat are not removed by `/forget`; the notice says so, and the team must delete them.

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
- Photo uploads are admin-only, checked by their real bytes (not the label), size-limited, and stored under generated names.
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
