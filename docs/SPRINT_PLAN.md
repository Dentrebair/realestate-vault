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

Status: built and verified on 2026-10-01 on a laptop. Railway deploy moved to after P3. 92 tests pass; the eval set passes 49 to 50 of 50 leads per run (149 of 150 over three runs).

- [x] `grammy`; polling mode for local work, webhook on Railway with a constant-time secret check (401 otherwise); duplicate-update check; answers 200 at once and processes afterwards.
- [x] Private chats only; text and button taps only; one message at a time per chat (taps on their own lane).
- [x] `/start` with category quick-pick buttons and a one-line "indicative" notice; creates the Lead at `initiated`; records a campaign code from a deep link. Also `/help`, `/saved`, `/reset`.
- [x] AI layer (`ai` v7 + `@ai-sdk/openai`, `gpt-5-mini`, reasoning effort minimal): `search_properties`, `get_property`, `save_requirements`, `request_site_visit`. Customer id is bound by code.
- [x] Lead hydration, last 20 messages from `chat_messages`, and what was last shown, so "the second one" works.
- [x] Cards built in code: Match cards, Close option cards with differences, Shortlist and Book Site Visit buttons, Show more.
- [x] Button taps run without the model: re-check the property, update the stage, record the event, answer the callback.
- [x] Sales desk alert on site visit, to `SALES_DESK_CHAT_ID` (your own Telegram account for the demo), marked sent on success.
- [x] Share-my-number button after a visit request; only the customer's own number is accepted.
- [x] Off-topic guard on a brand-new lead's first message (one polite line, then silence). Known leads are never silenced. Rate limit of 20 messages per hour and 1,000 characters.
- [x] Output guards: every amount in a reply must come from a tool result, the customer's words or their saved budget; no em or en dashes; a sold or reserved match is always named; "searching" with no search triggers a retry that forces a tool call.
- [x] Money is read by code (`150L`, `1.5C`, ranges, missing units) and handed to the model as a fact.
- [x] Production safety: tool routes off by default in production; refuses to start in production without the bearer token; no open CORS; upstream error text hidden.
- [x] Eval harness (`npm run eval`, see below).
- [ ] Deploy to Railway and register the webhook. Moved to the very end, after Phase 2 work.
- [ ] Known gap: the model timeout is 25 seconds, not the PRD's 10, because a tool turn cannot reliably finish in 10.

**Done when (live):** scenes 1 to 3 and 6 of the demo work on the real bot. Met on a laptop; the live Telegram test of scenes 1 to 6 passed on 2026-10-01.

**Evals.** `npm run eval` runs test leads through the real model on an in-memory copy of the inventory and checks behaviour, not wording: tool arguments, cards shown or hidden, stages, forbidden content (invented prices, discounts, photos, dashes, leaked ids). `--all` runs all 50, `--lead 011,014` chosen ones, `--tag near-miss` a group, `--verbose` prints conversations. Failures always print the conversation. It costs about 230,000 tokens (a few cents) per full run.

## Sprint P3: Lead board and demo polish

Status: built 2026-10-01. One step is waiting on you (creating the first staff account). 110 tests pass.

- [x] Lead board at `/admin/` ([src/admin/](../src/admin/)): six stage columns with counts, cards with requirement summary, saved count, number-shared flag, campaign source and last activity; refreshes every 5 seconds; test leads can be hidden.
- [x] Real staff accounts: Supabase Auth email and password, checked by the server. Tokens live in HttpOnly, SameSite=Strict cookies and renew themselves; a `staff` allowlist table decides who may enter and whether they are an admin or a viewer; sign-ups can be switched off; repeated wrong passwords are throttled; login needs JSON, so a cross-site form cannot post it.
- [x] Lead detail panel: requirements, noted facts, shortlist with property names and prices, history (who moved it and why), and the conversation where policy allows. Deep links: `/admin/#lead=<id>`.
- [x] Stage change from the board (admins only): any stage, including corrections backwards, recorded as a board move with who made it and a reason.
- [x] "Asked for, but not fully available": zero-result searches grouped by what was asked, most asked first.
- [x] Conversation policy (`BOARD_SHOW_CONVERSATIONS`: `test`, `all` or `none`), default test leads only. To be decided for real customers before launch.
- [x] Customer text is only ever shown as plain text (a test guards against `innerHTML` and similar).
- [x] `npm run demo:reset`; `--adopt` now also clears the old conversation and history so a demo starts clean.
- [x] README, demo script ([docs/DEMO.md](DEMO.md)), updated `.env.example`.
- [x] Full eval run across all 50 leads: done in Sprint P2 (149 of 150 lead-runs passed).
- [ ] **You:** run `sql/002_admin.sql`, create your account in Supabase Auth, run `npm run add-staff -- you@email.com admin`, then sign in and rehearse [docs/DEMO.md](DEMO.md). Until then the sign-in has only been tested against a stand-in for Supabase Auth, not the real one.
- [ ] Rehearsal of scenes 4 to 7 on the bot running on your laptop (scenes 1 to 3 and the discount and visit steps were tried live earlier). The rehearsal on a deployed bot moves to the very end with the Railway deploy.

**Done when:** scenes 1 to 7 work end to end and the board shows stage changes from the chat within a few seconds.

**Choices worth knowing about**
- The board is served by the same app as the bot, so one deploy covers both.
- Phone numbers are shown only in a lead's detail panel, never on the cards.
- The board shows stage history, not a live chat. Nothing on the board can send a message to a customer.

---

## Add-on: property photos

Status: built 2026-10-01. Needs `sql/003_photos.sql` run, and photos uploaded by you.

- [x] Storage: a public `property-photos` bucket and a `property_photos` table; the `properties` table is not altered.
- [x] Admin panel **Listings** tab: search, thumbnails, photo manager with multi-upload, reorder and delete. Admins change, viewers look.
- [x] Upload safety: admin-only, one raw image per request, type read from the file's bytes, 5 MB and 10-photo limits, generated file names, browser-side shrink to 1600 px that also strips phone location data, page allowed to load images only from Supabase Storage.
- [x] Telegram cards: cover photo with the details as the caption, and a ◀ 2/5 ▶ row that swaps the photo in place. Text card if a listing has no photos, or if Telegram cannot fetch one. Shortlist and Saved keep the gallery row.
- [x] Checked against the real Telegram API: photo send with formatting and buttons, in-place swap with the caption kept, long captions, and a bad URL refused cleanly. The upload flow was exercised in a real browser (upload, reorder, delete).
- [ ] **You:** run `sql/003_photos.sql`, then upload photos for a few listings from the Listings tab.
- Later: a Telegram Mini App gallery with true finger-swipe, once the bot is deployed (needs a public HTTPS address).

---

## Add-on: truthfulness

Status: built 2026-10-01. Needs `sql/004_knowledge.sql` run. Triggered by the bot saying listings had images when none did.

The goal is that every factual statement is true to its context: listing data, the customer's words, their saved profile, an approved answer, or a fixed policy line.

Measured with two audits and the same judge before and after (gpt-5-mini):

| | Before | After |
|---|---|---|
| 41 off-script questions fully grounded | 15 | 38 |
| Unsupported claims in those replies | 37 | 5 |
| 50 normal conversations fully grounded | 34 | 46 |
| Behaviour evals | 50 of 50 | 50 of 50 |

- [x] A question gateway answers from data before the model: photos, availability, stock counts, hours, identity, other cities, visit times, comparisons, and listing details (parking, floor, facing, size, possession, approvals, amenities, distances, and more). It never takes over a search request; a test checks all 50 test leads' own messages.
- [x] "No match" replies are written by code; suggested areas come only from the inventory.
- [x] Knowledge gaps and approved answers: stored with the customer's request as JSON, grouped in a Knowledge tab on the board, answered once by an admin and served from then on. Property, area and general scope.
- [x] Filters on the model's text: offers of abilities we lack, general knowledge, and place names the data did not give.
- [x] Closed-world prompt, owner-approved answers handed to the model as facts, and the pricing wording made neutral.
- [x] Audit tools: `evals/grounding.js`, `--judge` on the evals.
- Checked and rejected: temperature 0 and top_p (rejected by the model's API; no gain on a model that accepts them), and a keyword-based output validator (would have discarded 18 of 22 correct no-match replies).
- [ ] **You:** run `sql/004_knowledge.sql`, then confirm the `TEAM_CONFIRM_LINE` wording is true for your team.
- Later: a second, cheap verifier pass on a sample of live replies; owners can add areas to the place dictionary from the board.

---

## Add-on: the model decides what a message is about

Status: built 2026-10-02. No new SQL. Triggered by a price offer ("can i get for 54L") that did not move the lead to negotiating, and by hand-written keyword rules missing paraphrases, Tamil and Tanglish.

The principle: **the model decides what a message means; code decides what happens next.** The model only returns a label. Every reply is still written by code from the data, and stage rules, the no-agreed-price reply and the fact filters are unchanged.

- [x] **Negotiation judge** ([src/telegram/negotiation.js](../src/telegram/negotiation.js)): reads price-like messages when a property is on screen and returns whether the customer is negotiating and any amount offered. A search that only mentions money ("under 54L") is never an offer; a unit the model guessed is accepted only when the amount is believable for the listing.
- [x] **Router** ([src/telegram/router.js](../src/telegram/router.js)): one label per message. Routed by the model so far: hours, "are you a bot", total count, availability, other city, price question, rental, visit time. A visit-time label is used only when a property on screen can be acted on; otherwise the main agent offers the button.
- [x] Fallback: if the model call fails or takes over 4 seconds, the keyword rules decide, as before. Rental keeps its keyword rule as a floor because it has had no false alarms.
- [x] Rental and lease requests get a fixed "we only sell" reply and no search. Questions about a listing's rental income or yield are left alone.
- [x] "Anything else / apart from this" leaves out what was just shown (`excludeShown`). If nothing else fits, the reply says the one shown is the only match and does not count it as unmet demand.
- [x] The reply text is sent before the property cards, so the customer reads it first. Cards are still sent if the reply fails.
- [x] Questions about stamp duty, registration, tax and similar charges are not answered with the price of the property on screen.
- [x] `/reset` is a real fresh start: the lead goes back to `initiated` (the earlier stage stays in its history). `/start` does not change the stage.

Measured with the real model on labelled messages:

| | Keyword rules | Model |
|---|---|---|
| Negotiation, 40 messages ([evals/intent-compare.js](../evals/intent-compare.js)) | 32 | 40 |
| All message types, 115 messages ([evals/router.js](../evals/router.js)) | 88 | 112 |

Both are permanent checks: `npm run eval:negotiation` fails below 38 of 40 or on any clear-cut message; `npm run eval:router` reports the rules and the model side by side, with `-- --repeat 3` for consistency. When a real message is misjudged, add it to the list.

- Still on keyword rules (they were right on most of these): photos, comparing, and the specific-detail topics such as parking and RERA.
- Known limits: one label per message, so "is this a bot? also show me 2BHK in OMR" handles only one part; one extra model call (about 1.3 seconds) on most messages, run beside the negotiation judge.

---

## Phase 2, sprint 1: before real customers (privacy)

Status: built 2026-10-01. Needs `sql/005_privacy.sql` run (and `sql/004_knowledge.sql` from the last add-on, which is still missing from the database).

- [x] Consent at first contact with an **I agree** button. Before it, only the Telegram id is held; no name, username or messages, and nothing goes to the AI. Buttons and commands that use a profile wait for it. Customers who existed before get asked once.
- [x] `/privacy`, `/mydata`, `/forget` (with confirmation). Erasure removes the lead, messages, history and unanswered questions and keeps only a one-way hash.
- [x] Retention as settings: messages and idle real leads, test leads exempt, run every six hours and with `npm run retention`. Demo values in `.env`: 24 hours for both.
- [x] Viewers cannot see phone numbers or conversations. Admins can, where the conversation policy allows, and every such view lands in an **Access log** (admin tab), once per staff member per lead per 30 minutes.
- [x] Log lines never carry message text (a test checks the source).
- [x] Agreeing works even before `sql/005_privacy.sql` is run.
- [ ] **You:** run `sql/005_privacy.sql` and `sql/004_knowledge.sql`; set `BUSINESS_NAME` and `PRIVACY_CONTACT`; have a lawyer review the notice in `src/telegram/consent.js` and the retention periods before real customers.
- [ ] Decide `BOARD_SHOW_CONVERSATIONS` for real customers (currently test leads only).
- Not done: removing alerts already sent to the Sales desk chat when a customer asks to be forgotten (the notice says the team must do it).

Remaining Phase 2: growth ideas (human handoff is built, next section). Reliability is built (next section). **Deferred to the very end by the owner:** the privacy and legal work (`sql/005_privacy.sql`, `BUSINESS_NAME`, `PRIVACY_CONTACT`, the lawyer's review of the notice and retention periods).

---

## Phase 2, sprint 2: reliability

Status: built 2026-10-03. Optional `sql/006_reliability.sql`; without it the bot behaves as before.

- [x] **Durable updates.** Each webhook update is written to `telegram_updates` before the bot answers "received". If the write fails the bot returns 500 and Telegram sends the update again. The update number is the primary key, so a repeat is recognised after a restart.
- [x] **Recovery.** Updates that were accepted but not finished are processed again within a few minutes. If the service is killed after a reply but before the update is marked done, the customer can see that reply twice.
- [x] **Privacy.** The message text is kept only while the update waits; once done it is cleared, and the update number is deleted after 7 days.
- [x] **Graceful deploys.** Shutdown waits up to 12 seconds for replies in progress.
- [x] **Sales desk alerts retried.** A visit request whose alert failed is resent every minute for up to a day, using the existing `alerted_at` column. Alerts under 2 minutes old are left alone.
- [x] **Telegram 429 ("too fast").** Telegram refuses a message when a bot sends too quickly, and says how long to wait. The call waits that long (at most 5 seconds) and retries, up to 3 attempts. Only 429 is retried: it means nothing was sent. Other failures are not repeated, because the message may already have gone out and the customer would see it twice.
- [ ] **You:** run `sql/006_reliability.sql`, then redeploy.
- Left out on purpose: a rate limit counted from the database. It still resets on restart; it only guards against someone abusing the bot, and a database check on every message adds cost and delay for little gain at one copy.

### Scaling: what holds and what does not

- A copy of the bot is not tied to a user. One copy serves many customers at once, because it mostly waits on OpenAI and Telegram. Several copies share the same Supabase database and the same Telegram webhook, and each message goes to whichever copy is free.
- **Supabase handles the load.** It is Postgres behind an HTTP API; many copies and users reading and writing together is normal for it. The limits to watch are the plan's size and rate limits.
- **Supabase does not make one customer's two messages safe.** The code reads the saved profile, changes it and writes it back. Two quick messages from the same customer on different copies can overwrite each other. The stage change is protected (it only updates if the stage is still what was read); other fields such as saved requirements and what was last shown are not.
- Today the one-message-at-a-time queue, the duplicate check and the rate limit live in memory, which is correct for **one copy** (Railway replicas = 1). The duplicate check is now also in the database.
- **Before running more than one copy:** add a per-customer lock in the database (or make the profile writes atomic), and count the rate limit from the database. Until then, a bigger single copy is the safer way to get more capacity.

---

## Phase 2, sprint 3: human handoff

Status: built 2026-10-03. Needs `sql/007_handoffs.sql`; without it the alert still goes to Telegram as before, with no board entry and no reply thread.

Decisions (owner, 2026-10-03): the team is one person for now (the Sales desk chat); the bot keeps answering while a request is open; all four triggers create a request.

- [x] **A request is raised** on a site visit, on a request for a call back or to talk to someone, on a price offer or a question about a discount, and when the assistant has to say "I do not have that". A customer who makes several offers on one property, or asks several unanswered questions, is one conversation, not many alerts: later messages appear under the first alert.
- [x] **The alert** names the customer, their number if shared, the property and what they asked, and ends with "Reply to this message to answer the customer." It has a **Mark resolved** button.
- [x] **The team replies on Telegram** by replying to the alert (or to a forwarded customer message). The bot sends the text to the customer as "Message from our team" and confirms to the team. A plain message that is not a reply is treated as an ordinary message, so the owner can also test as a customer from the same account.
- [x] **The customer's answer comes back** to the team on the same thread, one message at a time: after the team writes, the customer's next message is forwarded and the request goes back to "Needs the team"; the bot also answers it as usual.
- [x] **The board has a Requests tab** (admins): a list with status (needs the team, waiting for the customer, resolved), the full thread with who wrote each line and whether it came from Telegram, the board or the bot, a reply box, and mark resolved or reopen. A reply from the board is delivered to the customer and shown to the team on Telegram; a reply from Telegram appears on the board.
- [x] **Safeguards.** Only listed team accounts (`STAFF_TELEGRAM_IDS`, or the Sales desk chat when it is a person) can reply through an alert. Opening a thread is written to the access log. Requests and threads belong to the customer and are deleted with them (`/forget`, retention). Replies to test leads are saved but never sent. Viewers cannot see the tab.
- [x] **The assistant knows what the team said.** The team's message is saved in the customer's conversation (as "Message from our team: …"), so a later "yes, Saturday works" has a meaning, and the assistant may repeat an amount or a time the team gave. A short reply to the team (12 words or fewer, no question, no search, no offer) gets a fixed "Thanks, I have passed that to our team. They will confirm here." and goes to the team; anything else is handled normally.
- [x] The customer is only told "I have passed this to our team" when the team really was told (a request was saved or the alert was sent).
- [ ] **You:** run `sql/007_handoffs.sql`, optionally set `STAFF_TELEGRAM_IDS`, redeploy.
- Not done: more than one team member answering with their own names (the thread shows the Telegram id), assigning a request to a person, a reminder when a request has waited too long, saving a team answer as an approved answer in one click, and a group chat for the team.

---

## Audit, 2026-10-06

A review of everything built, against the live database and the real model.

**Fixed**
- A listing named "Multi-Family Rental House" made the bot answer "we only sell" to a customer asking about it. Naming a listing is no longer a rental request.
- A search did not save what the customer asked for unless the model remembered to call the save tool, so the board showed empty profiles and "initiated" for people who had searched. Area, kind, size, budget and a one-line summary are now saved by code.
- `/mydata` printed the bedrooms twice, and did not mention requests.
- Retention did not cover request threads, which hold the customer's words. They now follow the conversation's clock and are counted in `/forget`.
- Behind Railway's proxy every visitor looked like the same address, so the sign-in limiter could lock out the admin for everyone. One proxy hop is now trusted in production.
- A failed lookup of which request a team reply belongs to made the reply fall through as a customer message. The team is now told it did not work.
- Refusals about loans, tax, brochures and videos no longer also raise a team request ("ask a bank" and "passed to our team" contradicted each other).
- The grounding audit did not know about the handoff, so it flagged "passed to our team" as invented (9 of 41). It does now (38 of 41).
- A repeat Book Site Visit tap said "already asked" even when the team had never been alerted. It now alerts them.

**Open**
- A customer's two quick messages can overwrite each other's profile changes once there is more than one copy of the bot. Keep one copy.
- A model outage sends the team one failure alert per failed message. Throttle it.
- Every unanswered question alerts the team at once. A curious customer can produce many pings; consider batching or a per-customer limit.
- No automated test run on push (no CI), and Railway does not deploy from GitHub by itself.
- Nothing watches the service from outside; add an uptime check on `/health`.
- The board reads at most 1000 leads and search reads at most 1000 listings, silently.
- "Book a site visit for the first one" after a search with no results repeats the no-match message instead of asking which property.
- Inventory data: only 3 of 20 listings have photos; two residential listings have no bedroom count (the heritage bungalow and the multi-family house).
- The owner's own account is flagged as a test lead, so its data is exempt from retention and its alerts say [TEST]. Real customers are unaffected.
- Not done, by decision: `sql/005_privacy.sql`, `BUSINESS_NAME`, `PRIVACY_CONTACT`, the legal review.

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

**Reliability** (the inbox, alert retries, graceful shutdown and the Telegram retry are built; see the sprint above)
- Still open: a rate limit counted from the database and a per-customer lock before running several copies.
- Load and failure testing (OpenAI down, Supabase down, Telegram retries), a PII audit of logs, a runbook, a one-week soft launch.

**Handoff** (built as a reply-to-alert relay; see the sprint above)
- Still open: a staff group chat with several named people, assignment, reminders, and the PRD's 30-minute cooldown where the bot goes quiet (the owner chose to keep the bot answering for now).

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
| More than one copy of the bot running | Keep Railway replicas at 1; see the scaling notes before changing it |
| A deploy that did not pick up the latest code | `/health` shows the running commit; use "deploy latest commit", not "Redeploy" on an old deployment |
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
| 2026-10-02 | Model-decided routing: negotiation judge and a message router, rental and "anything else" handling, reply before cards, `/reset` returns a lead to initiated. |
| 2026-10-03 | Reliability sprint: durable updates, recovery, graceful deploys, retried visit alerts, Telegram 429 retry. Scaling notes added. Privacy and legal work deferred to the end by the owner. |
| 2026-10-03 | Human handoff: requests on the board and Telegram alerts the team can reply to; the thread is shared between Telegram and the board. |
| 2026-10-06 | Audit of the whole build; nine fixes and an open list (see the Audit section). |
