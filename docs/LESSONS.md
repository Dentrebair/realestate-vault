# Lessons from building the Telegram assistant

A review written on 2026-10-06 of what went wrong while building this, why it happened, and what we did about it. It is meant for whoever works on this next, so the same mistakes are not made twice.

Each entry says what happened, why, and the fix. "Fixed" means the fix is in the code and covered by a test or an eval.

## 1. How wrong answers were found

| How | What it caught |
|---|---|
| **The owner testing by hand**, with screenshots and pasted conversations | Most of the serious ones: the claim of images that did not exist, the price question that showed the same card, the fake "(Updating lead stage…)" note, stamp duty answered with a price, cards before the explanation, `/reset` not working |
| **Behaviour evals** (`npm run eval`): 50 test leads through the real model | Whether the bot searched, offered a button, moved a stage, stayed polite |
| **Truth audit** (`evals/grounding.js`): 41 off-script questions, judged by a second model that lists every statement the data cannot back up | Invented facts. Grounded replies went from 15 to 38 of 41 as the fixes landed |
| **Labelled message sets**: 40 for negotiation (`npm run eval:negotiation`), 115 for message routing (`npm run eval:router`) | Where keyword rules fail against the model |
| **Live replays** through the real model, and **reads of the live database** | Problems the fakes hide: wrong ids, missing tables, requirements never saved |
| **A full audit** of the whole build on 2026-10-06 | Nine defects, listed in section 4 |

The judge is itself a model. It is noisy (35 to 37 of 41 on identical code), it nitpicks fixed replies, and it did not know about features added after it was written. Treat it as an alarm, not a verdict.

## 2. The assistant said things that were not true

**Claimed listings had images when none did.** The model was never told whether photos existed, so it guessed. The rule lived in the prompt, not in data. Fixed: code reads the photo count and writes the answer; photo claims are filtered out of the model's text.

**Invented facts more broadly.** The prompt let the model answer anything it lacked data for. Fixed with a layered defence: a gateway that answers from data before the model is asked; replies for "no match" written by code; filters on made-up amounts, places and abilities; a closed-world prompt; and unanswered questions saved for the owner to fill in (Knowledge tab).

**Our evals did not catch it.** They checked behaviour ("did it search?"), not whether each statement was true. Fixed: the truth audit and the judge.

**Wrote internal notes to the customer**, such as "(Updating lead stage to negotiating…)", without doing the work. Fixed: negotiation is detected in code, and notes like this are stripped.

**Told the customer to tap a Confirm button that was never sent.** Fixed: the visit tool is forced and retried, and if no button can be sent the sentence is removed.

**Said "searching now" and stopped.** Fixed: the turn is retried with a tool call required.

**A price question showed the same card again, and a price offer did not move the lead.** This one was caused by an instruction I added to the prompt: "do not repeat prices in your text". It left the model with nothing to say, and no rule answered "price of X". Fixed: code answers price questions and price offers directly, states the listed price from the database, and moves the stage.

## 3. About temperature, top_p and the other model settings

The owner pasted four suggested defences against wrong answers and asked for them to be checked before building. The result:

- **Code gateway and strict prompt rules:** implemented. They did most of the work.
- **Temperature and top_p:** not tuned. `gpt-5-mini` is a reasoning model and its API rejects both settings, so there was nothing to adjust. `OPENAI_TEMPERATURE` exists as an optional setting for non-reasoning models only and is off by default. No head-to-head comparison was run on another model. The reasoning for not pursuing it: temperature changes how random the wording is, not whether the model has the fact. The wrong answers came from missing data, and a lower temperature would only make a wrong guess more consistent.
- **Reasoning effort:** `minimal` from the start, chosen for speed and cost. It was never compared against higher levels with the evals, so it is not known to be the best setting.
- **Keyword output validator:** rejected after measuring. It would have discarded 18 of 22 correct "no match" replies.

So the fix for wrong answers was never a parameter. It was moving each answer to code that reads the data, or checking the model's text against the data before sending it. If parameters are ever tested, do it on a non-reasoning model with the 41-question audit and the 50 leads, and record the numbers here.

## 4. Rules written without real data

**Keyword rules missed paraphrases and local language.** On 40 negotiation messages the rules scored 32 and the model 40. On 115 mixed messages, 88 against 112. Fixed: the model decides what a message is about and code decides what happens next; the old rules remain as the fallback if the model call fails. Both measurements are permanent checks.

**A listing named "Multi-Family Rental House" was treated as a rental request.** The rental rule was written without checking it against real listing titles. Found by the audit. Fixed: naming a real listing is not a rental request.

**"How much is stamp duty" got the property price.** "How much" plus a question mark matched the price rule. Found by the owner. Fixed: charges and taxes are excluded, and the router handles it.

**"Site visit" was read as a search for a plot of land.** In Indian property talk "site" means a plot. Fixed: the phrase is removed before checking what is being searched for.

**"3 BHK" was read as money, and "150L" was over-questioned.** Sizes and money were not told apart. Fixed: a small reader of money ignores sizes and units.

**A visit-time label took over "schedule a visit to the Guindy hotel", so no button was sent.** Caught by the eval. Fixed: a visit label is used only when a property on screen can be acted on.

**A new line in the prompt made one eval case flaky.** Lead 047 (a rental request) failed in about 2 runs of 12 after a wording change, against none in 20 before. Fixed: the prompt change was reverted and the rule moved into code. Prompt changes are measured with repeated runs.

## 5. Flow and data gaps

- **Cards arrived before the explanation.** Cards are now held back and sent after the reply, and are still sent if the reply fails.
- **"Anything else" showed the same card.** There was no way to exclude what had been shown. It now does, and says so when nothing else fits.
- **`/reset` and `/start` did not move a lead back.** Stages only go forward by design, and `/start` was labelled "Start over". Fixed: `/reset` is a real restart with the earlier stage kept in the history; `/start` is relabelled.
- **Searches did not save requirements.** They were saved only if the model remembered to call the tool, so the board showed empty profiles. Fixed: code saves area, kind, size, budget and a summary from every search.
- **"Already asked to visit" was said when the team had never been told.** Fixed: it is said only if the alert was sent; otherwise the alert is sent now.
- **The assistant did not know what the team had written**, so a customer's "yes, Saturday works" meant nothing to it. Fixed: team messages are saved in the conversation, count as a trusted source, and a short reply gets a fixed acknowledgement.
- **Request threads were not covered by retention or `/mydata`, and `/mydata` printed bedrooms twice.** Fixed.
- **Refusals about loans, tax and brochures also said "passed to our team".** Fixed: refusals do not raise a request.
- **A reply to the team's alert could fall through as a customer message** if the database lookup failed. Fixed: the team is told it did not work.
- **The sign-in limiter could lock out the admin behind Railway's proxy**, because every visitor looked like the same address. Fixed: one proxy hop is trusted in production.
- **Requests could sit unanswered forever.** Fixed: a wait timer on the board, red when overdue (30 minutes for a visit, 2 hours for the rest), reminders to the team inside business hours, and one notice to the customer after 24 hours.
- **The grounding judge flagged "passed to our team" as invented** (9 of 41), because it did not know about handoff. Fixed: it knows now (38 of 41).

## 6. Reliability and operations

- **A deploy or crash could lose a message being answered.** The service said "received" first and then worked, and nothing waited for the work. Fixed: each update is saved before it is answered, unfinished ones are retried, shutdown waits for replies in progress, and Telegram's "too fast" error is retried.
- **Railway crashed on Node 20.** The Node version was not pinned before the first deploy. Fixed: Node 22 in `engines` and `.nvmrc`.
- **`PUBLIC_BASE_URL` lacked `https://` and crashed with an unclear error.** Fixed: addresses are tidied, and configuration errors are one clear line.
- **The Redeploy button reran the old build**, so `/reset` looked broken. Fixed: `/health` shows the running commit.
- **`SALES_DESK_CHAT_ID` was missing in Railway, so no alert had ever been sent.** It failed silently. Fixed: `/health` reports whether team alerts are configured, and the service warns at start.
- **SQL for `004` and `007` was run in a different Supabase project** from the one the bot uses. Fixed by checking the live database and giving the exact project address. Always check with a real read.
- **A bot token was pasted into chat.** It had to be rotated. Secrets go in Railway variables, never in chat.

## 7. Mistakes in how we worked

- **A check of mine wrongly said tables existed.** A head-only request does not reveal a missing table, so I reported `004`, `005` and `006` as present when they were not. Re-checked with real reads.
- **I committed before reading an eval result**, by chaining commands in a way that hid a failure. The eval is now run and read on its own.
- **A broken edit meant a test measured nothing.** The identical result gave it away. Confirm an edit applied before trusting a run.
- **One file overwrite emptied `src/knowledge.js`.** The tests caught it at once.
- **Tests were green while live behaviour was wrong.** Fixtures use ids like `p04`, live uses UUIDs, and fakes do not fail the way Telegram does. The audit therefore read the live database and used the real model.

## 8. What to do differently

1. **A passing test is not proof it works.** Check live data, run the real model, and look at the real page.
2. **Test rules against real data before trusting them**, with a labelled set of real messages, including local phrasing.
3. **Let the model understand, let code decide.** The model labels a message; code writes the answer, enforces the rules, and keeps the facts true.
4. **Treat prompt changes as risky.** Measure with repeated runs, and prefer a code guard to another line of instruction.
5. **Make failures visible.** Missing settings, swallowed errors and unsent alerts must show up in `/health`, a warning, or a message to the team.
6. **Keep the evals up to date** whenever a feature changes what the bot may truthfully say.
7. **Verify with a real read** before saying something is in place.
