# Chennai Real Estate Lead Assistant

A chat assistant that helps prospective property buyers in Chennai find listings and moves them through a sales pipeline to a site visit. It runs on WhatsApp (branch `main`) and Telegram (branch `telegram`).

## Language

**Lead**:
A prospective buyer together with the profile we have saved about them (requirements, stage, shortlist). Identified by a channel-prefixed id such as `telegram:<id>` or `whatsapp:+91…`.
_Avoid_: Customer, buyer, client, user

**Lead stage**:
Where a Lead is in the sales pipeline, in order: `initiated`, `interested`, `negotiating`, `site_visit_ready`, `closed`. `not_interested` is the exit from any stage. A Lead never moves backwards except to `not_interested`, and except when the Sales desk corrects a stage by hand from the lead board. An opted-out Lead who asks for properties again returns to `interested`.
_Avoid_: Lead status, funnel stage, pipeline status

**Initiated**:
The Lead has made first contact and we know little or nothing about their requirements.

**Interested**:
The Lead has given usable requirements, been shown matching Properties, or shortlisted one.

**Negotiating**:
The Lead is discussing price or terms, comparing options, or raising objections. The assistant never negotiates; it hands pricing to the Sales desk.

**Site visit ready**:
The Lead has asked to see a specific Property in person. Only a button tap or an explicit request sets this, and it alerts the Sales desk.
_Avoid_: Booked, scheduled (no time slot is fixed)

**Shortlist**:
The set of Properties a Lead has chosen to keep.
_Avoid_: Saved, favourites, wishlist

**Property**:
A single listing in inventory that can be searched and shown to a Lead. Categories: residential, plot, farmland, commercial, commercial_redevelopment, hospitality, industrial. Statuses: available, under_construction, reserved, sold.
_Avoid_: Listing, unit, asset

**Match**:
A Property that satisfies every requirement the Lead has stated.
_Avoid_: Result, hit

**Recommendation**:
A Property offered when there is no Match, always shown with what differs from the requirement (over budget by how much, fewer bedrooms, different area).
_Avoid_: Suggestion, alternative, fallback

**Price on Request (POR)**:
How a Property with no recorded price is presented. The assistant never states or estimates a number for it.
_Avoid_: TBD, negotiable

**Sales desk**:
The human sales team that receives alerts when a Lead becomes site visit ready.
_Avoid_: Escalation channel, brokers

**Micro-market**:
A named Chennai area used to describe where a Lead wants to buy, such as OMR, ECR or Anna Nagar. One micro-market covers several localities.
_Avoid_: Locality, neighbourhood, region

**Test lead**:
A made-up Lead used for testing and demos, marked `is_test` with an id starting `test:`. Never shown to the Sales desk as real.
_Avoid_: Dummy, fake lead

**Knowledge gap**:
A question the assistant could not answer from data, saved with the customer's request so an owner can answer it. Closed when answered or dismissed.
_Avoid_: Unanswered query, missing FAQ

**Approved answer**:
An answer an owner wrote for a Knowledge gap, for one Property, one area, or everyone. It is served the next time the question is asked.
_Avoid_: FAQ entry, canned response

**Consent**:
A customer's agreement to the privacy notice, recorded with the date and the notice version. Without it the assistant keeps only their Telegram id.
_Avoid_: Opt-in, terms acceptance
