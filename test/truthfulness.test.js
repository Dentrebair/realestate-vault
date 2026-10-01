import assert from 'node:assert/strict';
import test from 'node:test';
import { findMatches } from '../src/matching.js';
import { answerFromData } from '../src/telegram/gateway.js';
import { narrateSearch } from '../src/telegram/narrate.js';
import { withoutImpossibleOffers, withoutKnowledgeClaims, withoutUnlistedPlaces, truthful } from '../src/telegram/truthguard.js';
import { answerGap, dismissGap, findEntry, listGapGroups, recordGap, relevantEntries } from '../src/knowledge.js';
import { searchProperties } from '../src/propertySearch.js';
import { Cr, L, properties } from './fixtures/properties.js';
import { testLeads } from './fixtures/testLeads.js';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

const CONFIG = { businessHours: 'Mon to Sat, 10am to 7pm IST', propertiesTable: 'properties' };
const shownOf = (...ids) => ids.map((id) => {
  const p = properties.find((x) => x.property_id === id);
  return { id, title: p.title, location: p.location, priceDisplay: '₹x', photoCount: 0 };
});
const leadWith = (shown, extra = {}) => ({ customerId: 'telegram:9', isTest: false, leadStage: 'interested', botState: { shown }, ...extra });
const ask = (db, text, shown = shownOf('p03'), lead = leadWith(shown)) => answerFromData({ text, lead, supabase: db, config: CONFIG });

// ---- filters on what the model writes -------------------------------------------------------

test('offers of things we cannot do are removed; refusals and handing over to the team are kept', () => {
  const gone = [
    'I can ask the seller for the maintenance details.',
    'Would you like me to check availability with the seller?',
    'I can send you the brochure.',
    'I can calculate that from the listings I showed.',
    'Would you like me to check nearby schools for this property?',
    'I can connect you with the builder.',
    'I will get back to you with the metro distance.'
  ];
  for (const s of gone) assert.equal(withoutImpossibleOffers(`Here is a flat. ${s}`), 'Here is a flat.', s);

  const kept = [
    'I cannot send brochures or floor plans.',
    'Our team can confirm that at a site visit.',
    'Would you like me to arrange a site visit?',
    'I do not have the exact address.'
  ];
  for (const s of kept) assert.equal(withoutImpossibleOffers(s), s, s);
});

test('general knowledge about areas is removed', () => {
  assert.equal(withoutKnowledgeClaims('Here is one. OMR is a tech corridor with rising infrastructure, but traffic can be heavy.'), 'Here is one.');
  assert.equal(withoutKnowledgeClaims('Typically flats here are cheaper. This one is ₹62 L.'), 'This one is ₹62 L.');
  assert.equal(withoutKnowledgeClaims('This flat is near tech parks, as the listing says.'), 'This flat is near tech parks, as the listing says.');
  assert.equal(withoutKnowledgeClaims('I cannot speak to traffic or safety.'), 'I cannot speak to traffic or safety.');
});

test('a place the data never gave the model and the customer never said is removed', () => {
  const allowed = 'High-Rise 2BHK Apartment Navalur OMR Chennai residential Anna Nagar West';
  assert.equal(withoutUnlistedPlaces('Try Pallavaram or Tiruvottiyur instead.', allowed), '');
  assert.equal(withoutUnlistedPlaces('I found a flat. Would you like to expand to Perungudi and Thoraipakkam?', allowed), 'I found a flat.');
  assert.equal(withoutUnlistedPlaces('This one is in Navalur on OMR.', allowed), 'This one is in Navalur on OMR.');
  assert.equal(withoutUnlistedPlaces('A 4BHK in Anna Nagar.', allowed), 'A 4BHK in Anna Nagar.', 'a part of an allowed name is allowed');
  assert.equal(withoutUnlistedPlaces('Chennai has many options.', allowed), 'Chennai has many options.');
  assert.equal(truthful('I found one. Try Adyar. I can ask the seller. OMR is a tech corridor.', allowed), 'I found one.');
});

// ---- replies when nothing matches are written by code ---------------------------------------

test('no-match replies name only what the data holds', () => {
  const near = narrateSearch({ configured: true, ...findMatches(properties, { location: 'OMR', category: 'residential', bedrooms: 3, maxBudget: Cr(1.5) }) });
  assert.match(near, /^I do not have an exact match for 3 bedroom residential in OMR up to ₹1.5 Cr\. Here is the closest option/);

  const over = narrateSearch({ configured: true, ...findMatches(properties, { location: 'Anna Nagar', category: 'residential', bedrooms: 3, maxBudget: Cr(2) }) });
  assert.match(over, /all are well above your budget: Signature 4BHK Sky Mansion at ₹4.8 Cr/);

  const sold = narrateSearch({ configured: true, ...findMatches(properties, { location: 'Besant Nagar', category: 'residential', query: 'penthouse', bedrooms: 4, maxBudget: Cr(7) }) });
  assert.match(sold, /Exclusive Rooftop Penthouse with Ocean Vista is sold and not available\./);

  const none = narrateSearch({ configured: true, ...findMatches(properties, { location: 'OMR', category: 'residential', bedrooms: 2, maxBudget: L(70), dealBreakers: ['under construction'] }) });
  assert.match(none, /I left out one under construction property in OMR/);

  assert.equal(narrateSearch({ configured: true, ...findMatches(properties, { location: 'OMR', category: 'residential', bedrooms: 2, maxBudget: L(70) }) }), null, 'an exact match is described by the model');

  // Area suggestions come from the data, never from memory.
  const fits = narrateSearch({
    configured: true, outcome: 'nothing_in_area', criteria: { summary: '2 bedroom flat in OMR', area: 'OMR' },
    recommendations: [], unavailable: [], excludedByDealBreaker: [], suggestions: { areasThatFit: [{ name: 'Velachery', count: 1, km: 4 }] }
  });
  assert.match(fits, /in Velachery\. Would you like to see it\?/);
});

test('suggestions are the areas that have a fitting property, nearest first', () => {
  const found = findMatches(properties, { location: 'Mamallapuram', category: 'hospitality', maxBudget: Cr(50) });
  assert.deepEqual(found.suggestions.areasThatFit.map((a) => a.name), ['Guindy']);
  const cheapest = findMatches(properties, { location: 'Anna Nagar', category: 'residential', bedrooms: 3, maxBudget: Cr(2) }).suggestions.cheapestInArea;
  assert.equal(cheapest.priceDisplay, '₹4.8 Cr');
});

// ---- the gateway ----------------------------------------------------------------------------

test('a detail the listing has is answered from the listing; one it lacks is a saved gap', async () => {
  const db = createFakeSupabase({ properties: structuredClone(properties) });
  db.tables.properties.find((p) => p.property_id === 'p03').metadata.car_parks = 2;

  const has = await ask(db, 'Does it have parking?');
  assert.equal(has.reply, 'For Signature 4BHK Sky Mansion: Car parks: 2.');
  assert.equal(has.gapId, undefined);

  const lacks = await ask(db, 'Which direction does it face?');
  assert.equal(lacks.reply, 'The listing for Signature 4BHK Sky Mansion does not mention which way it faces. Our team can confirm it at a site visit.');
  const [gap] = db.tables.knowledge_gaps;
  assert.equal(gap.kind, 'listing_detail');
  assert.equal(gap.topic, 'facing');
  assert.equal(gap.property_id, 'p03');
  assert.equal(gap.status, 'open');
  assert.equal(gap.question, 'Which direction does it face?');
  assert.equal(gap.request.property.title, 'Signature 4BHK Sky Mansion');
  assert.equal(gap.request.assistantReply, lacks.reply);
  assert.deepEqual(gap.request.shown, [{ id: 'p03', title: 'Signature 4BHK Sky Mansion' }]);
});

test('the same customer asking the same thing again adds to the count, not a new row', async () => {
  const db = createFakeSupabase({ properties });
  await ask(db, 'Is there a lift?');
  await ask(db, 'is there a lift in this one?');
  assert.equal(db.tables.knowledge_gaps.length, 1);
  assert.equal(db.tables.knowledge_gaps[0].times, 2);

  await ask(db, 'Is there a lift?', shownOf('p03'), leadWith(shownOf('p03'), { customerId: 'telegram:10' }));
  assert.equal(db.tables.knowledge_gaps.length, 2, 'another customer is a separate row');
  const groups = await listGapGroups(db);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].times, 3);
  assert.equal(groups[0].customers, 2);
});

test('once an owner answers a gap, the next customer who asks is served that answer', async () => {
  const db = createFakeSupabase({ properties });
  await ask(db, 'Does it have parking?');
  const gapId = db.tables.knowledge_gaps[0].id;

  const entry = await answerGap(db, gapId, { answer: 'Two covered car parks are included.', by: 'owner@x.com' });
  assert.equal(entry.scope, 'property');
  assert.equal(entry.property_id, 'p03');
  assert.equal(entry.topic, 'parking');
  assert.equal(db.tables.knowledge_gaps[0].status, 'answered');
  assert.equal(db.tables.knowledge_gaps[0].entry_id, entry.id);

  const served = await ask(db, 'Is there parking?', shownOf('p03'), leadWith(shownOf('p03'), { customerId: 'telegram:11' }));
  assert.equal(served.reply, 'Two covered car parks are included.');
  assert.equal(served.servedEntryId, entry.id);
  assert.equal(db.tables.knowledge_entries[0].served_count, 1);
  assert.equal(db.tables.knowledge_gaps.length, 1, 'no new gap');

  // About a different property it is still a gap.
  const other = await ask(db, 'Does it have parking?', shownOf('p04'), leadWith(shownOf('p04')));
  assert.match(other.reply, /does not mention parking/);
});

test('area and general questions: a fixed reply and a gap, until an owner answers', async () => {
  const db = createFakeSupabase({ properties });
  const shown = shownOf('p04');

  const school = await ask(db, 'Is there a good school nearby?', shown);
  assert.match(school.reply, /^I do not have area guides, market data or forecasts/);
  const gap = db.tables.knowledge_gaps.find((g) => g.topic === 'nearby_places');
  assert.equal(gap.kind, 'area_info');
  assert.equal(gap.area, 'Navalur');

  await answerGap(db, gap.id, { answer: 'Two CBSE schools are within 2 km of Navalur.' });
  const again = await ask(db, 'any schools near here?', shown, leadWith(shown, { customerId: 'telegram:12' }));
  assert.equal(again.reply, 'Two CBSE schools are within 2 km of Navalur.');

  const loan = await ask(db, 'Can I get a home loan on this?', shown);
  assert.match(loan.reply, /^I cannot advise on loans/);
  const loanGap = db.tables.knowledge_gaps.find((g) => g.topic === 'loan');
  assert.equal(loanGap.kind, 'policy');
  const entry = await answerGap(db, loanGap.id, { answer: 'We work with three partner banks. Our team will share details at the visit.' });
  assert.equal(entry.scope, 'general');
  assert.equal((await ask(db, 'What about the EMI?', shown)).reply, entry.answer, 'any loan question now gets the approved answer');
});

test('dismissed gaps leave the open list; an entry can be found by property, then area, then in general', async () => {
  const db = createFakeSupabase({ properties });
  await ask(db, 'Are pets allowed?');
  await dismissGap(db, db.tables.knowledge_gaps[0].id);
  assert.equal((await listGapGroups(db)).length, 0);
  assert.equal((await listGapGroups(db, { status: 'dismissed' })).length, 1);

  db.tables.knowledge_entries = [
    { id: 1, scope: 'general', topic: 'x', answer: 'general', active: true },
    { id: 2, scope: 'area', area: 'Navalur', topic: 'x', answer: 'area', active: true },
    { id: 3, scope: 'property', property_id: 'p04', topic: 'x', answer: 'property', active: true }
  ];
  assert.equal((await findEntry(db, { topic: 'x', propertyId: 'p04', area: 'Navalur' })).answer, 'property');
  assert.equal((await findEntry(db, { topic: 'x', propertyId: 'p05', area: 'Navalur' })).answer, 'area');
  assert.equal((await findEntry(db, { topic: 'x', propertyId: 'p05', area: 'Adyar' })).answer, 'general');
  db.tables.knowledge_entries[2].active = false;
  assert.equal((await findEntry(db, { topic: 'x', propertyId: 'p04', area: 'Navalur' })).answer, 'area');
});

test('with several properties in play, the customer is asked which one; "the first one" resolves it', async () => {
  const db = createFakeSupabase({ properties });
  const shown = shownOf('p03', 'p04');
  const unclear = await ask(db, 'Does it have parking?', shown);
  assert.match(unclear.reply, /^Which one do you mean\? 1\) Signature 4BHK Sky Mansion; 2\) High-Rise 2BHK Apartment near Tech Parks/);
  assert.equal((db.tables.knowledge_gaps ?? []).length, 0, 'asking which one is not a gap');

  const second = await ask(db, 'Does the second one have parking?', shown);
  assert.match(second.reply, /High-Rise 2BHK Apartment near Tech Parks does not mention parking/);
  assert.equal(db.tables.knowledge_gaps[0].property_id, 'p04');

  assert.match((await ask(db, 'Does it have a lift?', [])).reply, /Which property do you mean\?/);
});

test('availability, stock, hours, identity, other cities and visit times come from data and settings', async () => {
  const db = createFakeSupabase({ properties });
  assert.equal((await ask(db, 'Is the first one still available?', shownOf('p03'))).reply, 'Signature 4BHK Sky Mansion is listed as Available.');
  assert.match((await ask(db, 'Is it still available?', shownOf('p19'))).reply, /Sold\. It is no longer available\./);
  assert.match((await ask(db, 'How many properties do you have in total?')).reply, /^We currently have 18 properties listed: 6 residential, 3 industrial, 3 commercial/);
  assert.equal((await ask(db, 'What are your office hours?')).reply, 'Our team confirms site visit requests Mon to Sat, 10am to 7pm IST.');
  assert.match((await ask(db, 'Am I talking to a real person?')).reply, /^I am an automated assistant/);
  assert.match((await ask(db, 'Do you have properties in Bangalore?')).reply, /^We only handle property in Chennai/);

  const visit = await ask(db, 'Can I visit tomorrow at 5pm?', shownOf('p03'));
  assert.match(visit.reply, /I cannot set a time myself\. Request a site visit and our team will confirm a time \(Mon to Sat/);
  assert.equal(visit.visitFor, 'p03');
  assert.equal((db.tables.knowledge_gaps ?? []).length, 0, 'none of these are gaps');
});

test('comparison lists facts and never picks a winner', async () => {
  const db = createFakeSupabase({ properties });
  const compared = await ask(db, 'Which of the first two is better?', shownOf('p03', 'p04'));
  assert.match(compared.reply, /^I cannot say which is better/);
  assert.match(compared.reply, /1\) Signature 4BHK Sky Mansion: ₹4.8 Cr, 4 BHK, Anna Nagar West, Chennai/);
  assert.match(compared.reply, /2\) High-Rise 2BHK Apartment near Tech Parks: ₹62 L, 2 BHK, Navalur, OMR, Chennai, under construction/);
  assert.match((await ask(db, 'Which one would you buy?', shownOf('p03'))).reply, /Tell me what you are looking for/);
});

test('a search request is never mistaken for a question', async () => {
  const db = createFakeSupabase({ properties });
  for (const request of [
    'show me flats near a metro', '3BHK in OMR under 1.5 crore', 'good locality, not too costly, family of 4', 'I need a house',
    'flat with a gym in Anna Nagar', 'sea facing villa on ECR', 'looking for a plot with clear title', 'show hotels', 'show plots with parking'
  ]) {
    assert.equal(await ask(db, request), null, request);
  }
});

test('none of the 50 test leads\' own messages is taken over by the gateway', async () => {
  const db = createFakeSupabase({ properties });
  const intercepted = [];
  for (const lead of testLeads) {
    for (const message of lead.messages) {
      if (message.startsWith('/')) continue;
      // Lead 005 proposes a visit time; the gateway answers that on purpose, with a confirm button.
      if (lead.id === 'test:005') continue;
      if (await ask(db, message, [])) intercepted.push(`${lead.id}: ${message}`);
    }
  }
  assert.deepEqual(intercepted, []);
});

test('the off-script questions are answered by the gateway, not left to the model', async () => {
  const db = createFakeSupabase({ properties });
  const questions = [
    'Does it have parking?', 'Which floor is the first one on?', 'Is there a lift?', "What's the carpet area of the first one?", 'When can I move in?',
    'Who is the builder?', 'Is the title clear?', "What's the monthly maintenance?", 'Which direction does the first one face?', 'Is it RERA approved?',
    'What is the exact address of the first one?', 'Are pets allowed?', 'Is there a swimming pool or gym?', 'How old is the building?',
    'How far is the metro from the first one?', 'Is there a good school nearby?', 'Is the area prone to flooding?', 'Tell me about OMR as a place to live.',
    'What is the average price per sq ft in Anna Nagar?', 'Will prices go up next year?', 'Is this a good investment?', 'Is the metro coming to Navalur?',
    'Can I get a home loan on the first one?', 'What would the EMI be?', 'How much is stamp duty and registration?', 'What rent could I get from the first one?',
    'What is the ROI on the first hotel?', 'Is the lease extendable?', 'Can you send me the brochure or floor plan?', 'Do you have a video tour?',
    'Can someone call me right now?', 'What are your office hours?', 'Can I visit tomorrow at 5pm?', 'Am I talking to a real person?',
    'Do you have properties in Bangalore?', 'How many properties do you have in total?', 'Which of the first two is better?', 'Is the first one still available?', 'Which one would you buy?'
  ];
  const missed = [];
  for (const q of questions) if (!(await ask(db, q, shownOf('p03', 'p04')))) missed.push(q);
  assert.deepEqual(missed, []);
});

test('owner-approved answers that bear on a question reach the model as facts', async () => {
  const db = createFakeSupabase({ properties });
  db.tables.knowledge_entries = [
    { id: 1, scope: 'property', property_id: 'p04', topic: null, keywords: ['pets', 'dogs'], question: 'Are pets allowed?', answer: 'Small pets are allowed in this building.', active: true },
    { id: 2, scope: 'property', property_id: 'p03', topic: null, keywords: ['pets'], question: 'pets?', answer: 'No pets in this one.', active: true },
    { id: 3, scope: 'general', topic: null, keywords: ['weekend'], question: 'weekend visits', answer: 'Weekend visits are possible.', active: true }
  ];
  const picked = await relevantEntries(db, { text: 'are dogs allowed in the building', propertyIds: ['p04'], areas: [] });
  assert.deepEqual(picked.map((e) => e.id), [1], 'only entries about something in play, and only on topic');
  assert.deepEqual((await relevantEntries(db, { text: 'weekend visit?', propertyIds: [], areas: [] })).map((e) => e.id), [3]);
  assert.deepEqual(await relevantEntries(db, { text: 'what is the weather', propertyIds: ['p04'], areas: [] }), []);

  const rec = await recordGap(db, { customerId: 'c', question: 'q', kind: 'other', request: {} });
  assert.ok(rec);
  assert.ok(await searchProperties(db, { limit: 1, offset: 0 }));
});

test('a listing whose title names the topic is not described as silent about it', async () => {
  const db = createFakeSupabase({ properties });
  const reply = (await ask(db, 'Is the first plot DTCP or CMDA approved?', shownOf('p11'))).reply;
  assert.match(reply, /^The listing title says "CMDA & RERA Approved Residential Villa Plot"\. It gives no further detail on approvals and title\./);
  assert.equal((db.tables.knowledge_gaps ?? []).length, 0, 'the listing did say something, so this is not a gap');
});

test('before the knowledge tables exist, questions still get the standard reply', async () => {
  const db = createFakeSupabase({ properties });
  const realFrom = db.from;
  db.from = (name) => {
    if (!name.startsWith('knowledge_')) return realFrom(name);
    const failing = { error: { message: `relation "${name}" does not exist` } };
    const chain = { select: () => chain, eq: () => chain, in: () => chain, limit: () => chain, order: () => chain, update: () => chain, insert: () => chain, single: () => chain, maybeSingle: () => chain, then: (resolve) => resolve({ data: null, ...failing }) };
    return chain;
  };
  const listing = await ask(db, 'Does it have parking?');
  assert.match(listing.reply, /does not mention parking/);
  const area = await ask(db, 'Is there a good school nearby?', shownOf('p04'));
  assert.match(area.reply, /^I do not have area guides/);
  assert.equal(area.gapId, null, 'the gap could not be saved, and that did not break the reply');
});

test('the line about what the team can do is a setting, so it only says what is true for the business', async () => {
  const db = createFakeSupabase({ properties });
  const custom = await answerFromData({ text: 'Does it have parking?', lead: leadWith(shownOf('p03')), supabase: db, config: { ...CONFIG, teamConfirmLine: 'Ask us at the sales office.' } });
  assert.equal(custom.reply, 'The listing for Signature 4BHK Sky Mansion does not mention parking. Ask us at the sales office.');
});
