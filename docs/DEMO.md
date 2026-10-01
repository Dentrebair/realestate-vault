# Demo script

About ten minutes. Two windows: Telegram on a phone or laptop, and the lead board at `/admin/` beside it.

## Before you start

1. `npm run demo:reset` to reload the 50 test leads.
2. `node scripts/seed-test-leads.js --adopt 021 <your Telegram id>` so your account is a brand-new lead with no
   requirements. (Your id is in your lead's id on the board: `telegram:<id>`.)
3. `npm start`, then sign in to the board. Find your lead in **Initiated**.

## Scenes

| # | You do | What to expect | What it shows |
|---|---|---|---|
| 1 | Send `I need a house` | A few houses as cards, one short question at most. Your lead jumps to **Interested** on the board. | Natural, value first, no form |
| 2 | Send `3BHK flat in OMR under 1.5 crore` | "No exact match", then a **Close option** card: Navalur 2BHK, with "1 bedroom fewer; under construction". | Honest recommendations |
| 3 | Send `What does the Alwarpet bungalow cost?` | "Price on Request". No number, ever. | Trust |
| 4 | Tap **⭐ Shortlist** on a card | The button turns to "Saved". Open your lead on the board: shortlist shows the property. | Memory and tracking |
| 5 | Send `Can you give me a 10% discount?` | The bot will not negotiate; it hands pricing to the sales team. Board: **Negotiating**, with the reason. | The bot never negotiates |
| 6 | Tap **📅 Book Site Visit** | "Site visit request noted", a share-your-number button, and an alert in the Sales desk chat. Board: **Ready for site visit**. | Hand-off |
| 7 | `node scripts/seed-test-leads.js --adopt 043 <id>`, then send `show me something cheaper` | It already knows the area and budget and does not ask again. | Memory across conversations |

## Photos (once some are uploaded)

In the board, open **Listings**, pick a property, and add three or four photos. Then in Telegram search for that property
(for example `2BHK in OMR` for the Navalur flat). The card arrives as a photo with its details underneath. Tap **▶** to
flip through the photos in place; the counter shows 📷 2/4. The photo changes but the details and buttons stay.

## Knowledge gaps (the assistant never guesses)

1. Show a few flats in Telegram, then ask `Does the first one have parking?` The assistant says the listing does not
   mention it. It does not invent an answer.
2. On the board, open **Knowledge**. The question is waiting there with the customer's request (expand "Request details").
3. Type `Two covered car parks are included.` and **Save answer**.
4. Ask the same question again in Telegram, in different words if you like (`is there parking?`). It now gets that answer,
   and the board shows how many times it has been served.

## Extras if there is time

- Board: open the lead, read the history (who moved it and why), move a stage by hand.
- Board: the **Asked for, but not fully available** panel fills as customers ask for things we do not have.
- Send `2BHK for rent in Velachery`: the bot says it only sells.
- Send `Show me the penthouse in Besant Nagar`: it says the penthouse is sold and offers alternatives.
- Send `150L to 2 crore`: it reads it as ₹1.5 Cr to ₹2 Cr.

## If something looks off

- No reply: is `npm start` running, and is only one copy running?
- No Sales alert: `SALES_DESK_CHAT_ID` must be your Telegram id, and you must have sent the bot `/start`.
- Board empty or signed out: sign in again; sessions last about an hour and renew themselves while the page is open.
