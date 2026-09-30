# Telegram Real Estate Agent: Prototype Plan (v3)

Branch: `telegram` (the WhatsApp version stays on `main`).
Requirements source: `telegram agent for real estate.pdf` (the PRD). Where this plan and the PRD differ, this plan wins.
Vocabulary: [CONTEXT.md](../CONTEXT.md).

## Goal of version 1

Show the client a workable prototype that does two things well:

1. **Match and recommend.** Pick properties that fit what the Lead asks for. When nothing fits, recommend the closest few and say exactly how each one differs.
2. **Track the pipeline.** Store every Lead by stage (`initiated → interested → negotiating → site_visit_ready → closed`, with `not_interested` as an exit) and let the client see it.

Everything else is Phase 2. The prototype runs on test leads only.

## What the client will see (demo script)

| Scene | What happens | Proves |
|---|---|---|
| 1 | New person says "I need a house". Bot asks one question and shows a few homes straight away | Conversation feels natural, value first |
| 2 | "3BHK in OMR under 1.5 Cr". No exact match. Bot shows the nearest options, each labelled ("2 bedrooms, not 3; under construction") | Recommendations with honest differences |
| 3 | Ask the price of the Alwarpet bungalow. Bot says "Price on Request" and never guesses | Trust |
| 4 | Tap ⭐ Shortlist. The lead board moves the Lead to **interested** | Stage tracking |
| 5 | "Can you give a 10% discount?" Bot hands pricing to the sales team. Board shows **negotiating** | The bot never negotiates |
| 6 | Tap 📅 Book Site Visit. The Sales desk group gets an alert; board shows **site visit ready** | Hand-off |
| 7 | Chat as test lead 043 ("show me something cheaper"). Bot already knows the area and budget | Memory |

## What the prototype includes and leaves out

| Included | Left for Phase 2 |
|---|---|
| Natural-language search with micro-market aliases, budget units, bedroom rules | Semantic (pgvector) search |
| Matches plus labelled recommendations | New-listing alerts to Leads |
| Code-rendered property cards with Shortlist and Book Site Visit buttons | Listing photos |
| Stage pipeline, stage history, lead board with manual stage change | Sales relay / Telegram Business Mode |
| Conversation memory and saved requirements | Database inbox, alert retries, load and failure testing |
| Sales desk alert on site visit | Legal review, privacy commands, retention jobs |
| Off-topic first-message guard, simple per-lead rate limit | Separate dev and prod environments |
| Webhook secret check, bearer token required in production | Voice notes, Tamil and Tanglish replies, time slots, CRM sync |
| 50 test leads and an eval set built from them | Monitoring dashboards, cost reports |

## Decisions recorded

| Topic | Decision |
|---|---|
| Stage vocabulary | The client's: `initiated`, `interested`, `negotiating`, `site_visit_ready`, `closed`, `not_interested`. Column is `lead_stage`. The old seven `lead_status` values stay on `main` only |
| Who sets a stage | Code moves `initiated → interested` (first usable requirement, matches shown, or a shortlist tap). The model may move a Lead to `negotiating` or `not_interested` and must give a one-line reason, stored in `lead_events`. Only a button tap (or a confirmed request) sets `site_visit_ready`. `closed` is set from the lead board |
| Stage direction | Forward only, except `not_interested` from any stage. A Lead who returns after `not_interested` and asks for properties goes back to `interested` |
| Cards | Code renders them from search results (HTML parse mode). The model writes only short plain text. Prices and POR are enforced in code |
| Hidden listings | `sold` and `reserved` are never shown. `under_construction` is shown and labelled |
| Deal-breakers | Honoured, never relaxed into a recommendation |
| Recommendations | When there is no Match, show at least 1 and at most 3 close options, ranked by how few requirements they miss, each with a plain list of differences. Show none only if nothing in inventory is even close (then say so and offer to note the requirement) |
| Customer ID | The gateway sets `telegram:<id>`; the model never sees or supplies it |
| Architecture | `src/telegram/` inside this Express app, JavaScript, one Railway instance |
| Language | English replies |
| Phone number | May be stored when the Lead shares it; needs a consent line before real leads |
| Test data | In the current Supabase project. Every test row has `is_test = true` and an id starting `test:` so one command removes them |

## Matching and recommendation rules

A **Match** passes every stated requirement: category and type (flat, villa, office, shop…), area (through the micro-market alias table), budget, bedrooms, deal-breakers, and status available or under construction. A listing with no price cannot be confirmed against a budget, so it is never a clean Match; it can appear as a Recommendation marked Price on Request.

**Ranking is location first.** Candidates are sorted by distance from the requested area (same area, then near, at most 8 km, then far), and only then by how few other requirements they miss.

1. Never shown: sold and reserved listings, deal-breakers (for example under construction), a different category, a price more than 2× the budget, or more than 2 bedrooms off.
2. Same area first, then near, then far.
3. Within the same distance, fewest gaps first: related category, different type, budget (% over), bedrooms off or not listed, under construction.
4. A **far** option is shown only if it would be a full Match except for its area. Otherwise the bot says nothing fits near the requested area and asks whether to widen the area or change the budget.

When there is no Match the bot shows 1 to 3 Recommendations, each with its own differences list ("about 4 km from OMR", "₹1.8 Cr over your budget", "1 bedroom fewer", "under construction"). When there are none, the answer says which of three things is true: nothing in the area, properties in the area but above budget, or nothing fits. The response also lists sold or reserved properties that would have fitted, so the bot can say "that one is sold". Zero-result searches are recorded as `lead_events` so the client can see unmet demand.

---

## Sprint P0: Setup (you, with help from me)

- [ ] Run [sql/001_prototype_schema.sql](../sql/001_prototype_schema.sql) in the Supabase SQL editor (creates `customer_leads`, `lead_events`, `chat_messages`, with row-level security on).
- [ ] Tell me when it's done. I run `node scripts/seed-test-leads.js` to insert the 50 test leads.
- [ ] Create the bot with @BotFather; put the token in `.env` as `TELEGRAM_BOT_TOKEN`.
- [ ] Put `OPENAI_API_KEY` and `OPENAI_MODEL` in `.env` yourself.
- [ ] Create a Telegram group for the Sales desk (even just you), add the bot, and give me the chat ID.
- [ ] Create the Railway project. Until then the demo can run locally.

**Done when:** the three tables exist, 50 test leads are visible in Supabase, and `.env` has the bot token and OpenAI settings.

## Sprint P1: Matching engine and stages (all testable without Telegram)

Status: built and verified on 2026-10-01, except the public-key check below. 57 tests pass.

- [x] Rename `lead_status` to `lead_stage` everywhere (code, OpenAPI, tool schemas) with the six stages.
- [x] Stage rules in one place ([src/stages.js](../src/stages.js)): allowed moves, who may make them, each move written to `lead_events`.
- [x] Upsert is a true partial update. It never resets the stage or wipes lists; key points accumulate and shortlist ids only grow.
- [x] `getLead`, `addToShortlist`, `removeFromShortlist`, `setStage` (a stage change loses to a newer write instead of overwriting it).
- [x] Search: sold and reserved never returned; explicit columns instead of `*`; category and type words normalised (flat, villa, office, cloud kitchen…); [src/microMarkets.js](../src/microMarkets.js) with about 45 localities and approximate coordinates (OMR, ECR, GST Road, Tambaram, Anna Nagar, airport, Tidel Park…); `minBedrooms`; `offset` for Show more.
- [x] Budget parsing (`1.5C`, `150L`, ranges, missing units, inverted ranges) and `formatInr`. `priceDisplay` returns "Price on Request (POR)" for any null price.
- [x] Matching and Recommendation engine ([src/matching.js](../src/matching.js)): location first, at most 3 recommendations each with `differences[]`, one far option only when nothing is near, sold or reserved near-misses reported, unmet demand recorded as `zero_result` events.
- [x] Tests with a fake Supabase client. A table-driven test runs 22 of the 50 test leads against a snapshot of the 20 live listings, plus stage, lead-store and money tests.
- [x] Live check on the seeded data: fixture cases give the expected answers; a scratch lead kept its stage, shortlist and fields across a second upsert; the model could not create a hot lead.
- [x] Old `sql/customer_leads.sql` removed.
- [ ] Confirm the public (anon) Supabase key cannot read the three lead tables. Needs `SUPABASE_ANON_KEY` added to `.env` (Supabase dashboard, Settings, API).

**Done when:** tests pass; the fixture cases return the expected matches and recommendations; sold and reserved listings never appear; a second upsert no longer changes the stage or wipes the shortlist. All met.

**Known limits, for later:**
- Matching runs in JavaScript over up to 1,000 listings fetched per search. Fine for 20, and worth rethinking above about 1,000.
- Area centre points are approximate and the near threshold is 8 km straight-line. Tune both against real client feedback.
- Only "under construction" is understood as a deal-breaker; other deal-breakers are stored but not applied to matching.

## Sprint P2: The Telegram bot

- [ ] `grammy`; polling mode for local work, webhook on Railway with a secret header (401 otherwise); in-memory duplicate check; reply 200 fast and process in the background.
- [ ] Private chats only; text and button taps only; one message at a time per chat.
- [ ] `/start`: intro, category quick-pick buttons, one line saying listings are indicative. Creates the Lead at `initiated`.
- [ ] AI layer (`ai` + `@ai-sdk/openai`, model from `OPENAI_MODEL`): `systemPrompt.js` and tools `search_properties`, `get_property`, `save_requirements`, `request_site_visit`. Results first, one question at a time, no legal or investment advice, yields "as stated by seller".
- [ ] Lead hydration and the last 20 messages from `chat_messages`; a record of the properties last shown, so "tell me about the second one" works.
- [ ] Cards: Match cards say "✅ Matches your requirements"; Recommendation cards say "💡 Close option" and list the differences. Buttons: 📅 Book Site Visit, ⭐ Shortlist (toggles), Show more.
- [ ] Button taps run without the model: re-check the property is still available, update the stage, record the event.
- [ ] Sales desk alert on site visit: Lead name, handle, budget, area, property.
- [ ] Offer a "Share my number" button when a visit is requested.
- [ ] Off-topic guard on the first message (one polite line, then silence; greetings count as on-topic; if the check fails, treat as on-topic). Per-lead limit of 20 messages per hour and 1,000 characters.
- [ ] Output guard: amounts in the model's text must come from tool results or the Lead's own message.
- [ ] 10-second model timeout with the PRD's fallback message.
- [ ] Production safety: refuse to start in production without the bearer token; turn the WhatsApp tool routes off by default; remove open CORS; do not return upstream error text.
- [ ] Deploy to Railway, register the webhook.
- [ ] Tests with a mocked model; a first eval set of about 20 of the 50 test leads, asserting on tool calls and forbidden content, not on exact wording.

**Done when (live):** scenes 1 to 3 and 6 of the demo work on the real bot; the Triplicane and "1.5C" cases call the search with the right arguments; a stored budget is reused later in the chat; no null-price listing ever shows a number.

## Sprint P3: Lead board and demo polish

- [ ] Read-only **lead board** at `/admin`, protected by `ADMIN_TOKEN`: six columns by stage, each card showing name, requirement summary, shortlist, last activity, and a detail view with the event timeline.
- [ ] Stage change from the board (forward moves, `closed`, `not_interested`), recorded in `lead_events`.
- [ ] Filter to show or hide test leads.
- [ ] Full eval run across all 50 test leads; fix prompt problems in `systemPrompt.js` or a test, not by coaching in chat.
- [ ] Demo script rehearsal with `--adopt` (chat as a chosen test lead); reset with `--clean` and reseed.
- [ ] README: setup, environment variables, seed commands, how to run the demo.

**Done when:** scenes 1 to 7 work end to end, the board shows stage movements made in the chat within a few seconds, and the eval set passes.

---

## Test leads

[test/fixtures/testLeads.js](../test/fixtures/testLeads.js) holds 50 leads written against the live inventory. Each has a saved profile, the messages that person would type, and what a good reply looks like.

| Group | Leads | Tests |
|---|---|---|
| Clean matches | 001–010 | Right property found, stage and shortlist shown |
| Near misses | 011–020 | Recommendations with honest differences, sold and reserved hidden |
| Gaps | 021–028 | One clarifying question, no form; 028 tries to extract other leads' data |
| Unclear instructions | 029–036 | Shorthand (1.5C, 150L), vague areas, missing units |
| Conflicts | 037–042 | Impossible or contradictory requirements, inverted budget |
| Memory and special cases | 043–050 | Profile reuse, area change, saved list with a sold item, rental request, POR trap, discount request, Tanglish |

Stage spread: initiated 23, interested 15, negotiating 5, site visit ready 4, not interested 2, closed 1.

Commands (after P0):

| Command | Effect |
|---|---|
| `node scripts/seed-test-leads.js --dry` | Check the fixture against the live inventory; write nothing |
| `node scripts/seed-test-leads.js` | Insert or refresh all 50 (safe to re-run) |
| `node scripts/seed-test-leads.js --adopt 016 <your Telegram ID>` | Give your account that test lead's profile, then type its message to the bot |
| `node scripts/seed-test-leads.js --clean` | Delete every test lead |

---

## Phase 2 (after the client demo)

**Before real leads**
- Legal review of the consent text and retention periods (India's DPDP Act expects notice and consent for personal data). `/privacy` and `/forget` commands. Retention jobs: chat messages 30 days, leads per the agreed period.
- Separate dev and prod bots and databases.

**Reliability**
- Database inbox for updates (survives restarts and overlapping deploys, re-drives unfinished updates); persisted Sales desk alerts with a retry job and `alerted_at`; graceful shutdown; rate limit counted from the database.
- Load and failure testing (OpenAI down, Supabase down, Telegram retries), a PII audit of logs, a runbook, a one-week soft launch.

**Handoff**
- Choose between Telegram Business Mode (needs a Premium account) and a group relay where a sales executive replies to an alert and the bot forwards it. Adds PRD criterion 5 (30-minute human cooldown).

**Growth ideas, by my guess at value**
1. New-listing alerts for Leads with stored requirements (turns zero-result searches into future leads).
2. Listing photos. 3. Voice notes. 4. Semantic search once there are more than about 100 listings or more than 30% of searches return nothing.
5. Tamil and Tanglish replies. 6. Site-visit time slots and round-robin across sales executives.
7. Inventory admin tool and sync from wherever listings come from. 8. CRM sync through an n8n webhook on `lead_events`. 9. WhatsApp parity.

## Risks for the prototype

| Risk | Mitigation |
|---|---|
| Only 20 listings, so demos can look thin | The 50 test leads include many near misses that exercise Recommendations; add more listings in Supabase if the client wants a fuller demo |
| The model invents a price or a stage | Code-rendered cards, output guard, stage rules in code, evals |
| A stale card is tapped after a listing sells | Every tap re-checks the property |
| Public bot costs money | Rate limit, length cap, step cap; set an OpenAI spend limit |
| Test data mixes with real data later | `is_test` flag and `test:` prefix; `--clean` removes it |
| Two branches drift | Changes to `lead_stage` and search live on `telegram` for now; reconcile with `main` when WhatsApp resumes |

## Open questions

1. Who will update listing statuses and add listings after the demo? (Not needed for the demo itself.)
2. Sales desk staffing, business hours and response time. (Deferred.)
3. Expected lead volume. (Deferred.)
4. Who reviews consent and retention text? (Before real leads.)

## Change log

| Date | Change |
|---|---|
| 2026-09-30 | v1 from the design review of the PRD. |
| 2026-09-30 | v2 after the architecture review: live-data findings, code-rendered cards, privacy and security work, risk register. |
| 2026-09-30 | v3 rescoped to a client prototype: match-and-recommend plus stage pipeline; client stage names; lead board; 50 test leads; hardening moved to Phase 2. |
