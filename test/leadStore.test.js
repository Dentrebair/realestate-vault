import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addToShortlist,
  getLead,
  leadMemorySchema,
  removeFromShortlist,
  setStage,
  upsertLeadMemory
} from '../src/leadMemory.js';
import { searchProperties } from '../src/propertySearch.js';
import { Cr, properties } from './fixtures/properties.js';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

const ID = 'telegram:1001';
const events = (db) => db.tables.lead_events ?? [];

test('a new lead starts at initiated and the creation is recorded', async () => {
  const db = createFakeSupabase();
  const { lead } = await upsertLeadMemory(db, { customerId: ID, displayName: 'Asha' });

  assert.equal(lead.leadStage, 'initiated');
  assert.equal(lead.displayName, 'Asha');
  assert.deepEqual(events(db).map((e) => e.event_type), ['lead_created']);
});

test('the first usable requirement moves initiated to interested, by the system', async () => {
  const db = createFakeSupabase();
  const { lead, stage } = await upsertLeadMemory(db, { customerId: ID, preferredLocations: ['OMR'] });

  assert.equal(lead.leadStage, 'interested');
  assert.equal(stage.changed, true);
  const moved = events(db).find((e) => e.event_type === 'stage_changed');
  assert.equal(moved.from_stage, 'initiated');
  assert.equal(moved.to_stage, 'interested');
  assert.equal(moved.note, 'requirements captured');
});

test('a second upsert keeps the stage, the shortlist and every field that was not sent', async () => {
  const db = createFakeSupabase();
  await upsertLeadMemory(db, { customerId: ID, budgetMax: Cr(2), preferredLocations: ['OMR'], mustHaves: ['parking'] });
  await addToShortlist(db, ID, 'p04');
  await setStage(db, ID, 'negotiating', { actor: 'model', reason: 'asked for a discount' });

  const { lead } = await upsertLeadMemory(db, { customerId: ID, urgency: '3 months' });

  assert.equal(lead.leadStage, 'negotiating');
  assert.deepEqual(lead.shortlistedPropertyIds, ['p04']);
  assert.deepEqual(lead.preferredLocations, ['OMR']);
  assert.deepEqual(lead.mustHaves, ['parking']);
  assert.equal(lead.budgetMax, Cr(2));
  assert.equal(lead.urgency, '3 months');
});

test('null means "not mentioned", so nothing is erased', async () => {
  const parsed = leadMemorySchema.safeParse({ customerId: ID, budgetMax: null, urgency: null, mustHaves: null });
  assert.equal(parsed.success, true);
  assert.deepEqual(Object.keys(parsed.data), ['customerId']);
});

test('list fields are replaced when sent; key points accumulate; shortlist ids only grow', async () => {
  const db = createFakeSupabase();
  await upsertLeadMemory(db, {
    customerId: ID,
    mustHaves: ['parking', 'gated'],
    keyPoints: [{ type: 'requirement', text: 'wants sea view', confidence: 0.9 }],
    shortlistedPropertyIds: ['p03']
  });
  const { lead } = await upsertLeadMemory(db, {
    customerId: ID,
    mustHaves: ['parking'],
    keyPoints: [
      { type: 'requirement', text: 'wants sea view', confidence: 0.9 },
      { type: 'urgency', text: 'moving in June', confidence: 0.8 }
    ],
    shortlistedPropertyIds: ['p04']
  });

  assert.deepEqual(lead.mustHaves, ['parking']);
  assert.equal(lead.keyPoints.length, 2);
  assert.deepEqual(lead.shortlistedPropertyIds, ['p03', 'p04']);
});

test('the model can reach negotiating but can never create a hot lead', async () => {
  const db = createFakeSupabase();
  await upsertLeadMemory(db, { customerId: ID, budgetMax: Cr(1) });

  const blocked = await upsertLeadMemory(db, { customerId: ID, leadStage: 'site_visit_ready' }, { actor: 'model' });
  assert.equal(blocked.stage.changed, false);
  assert.match(blocked.stage.reason, /model cannot set site_visit_ready/);
  assert.equal(blocked.lead.leadStage, 'interested');

  const allowed = await upsertLeadMemory(
    db,
    { customerId: ID, leadStage: 'negotiating', stageReason: 'asked for 10% off' },
    { actor: 'model' }
  );
  assert.equal(allowed.stage.changed, true);
  assert.equal(allowed.lead.leadStage, 'negotiating');
  assert.equal(events(db).at(-1).note, 'asked for 10% off');
});

test('a button tap sets site_visit_ready and records the property', async () => {
  const db = createFakeSupabase();
  await upsertLeadMemory(db, { customerId: ID, budgetMax: Cr(1) });
  const result = await setStage(db, ID, 'site_visit_ready', { actor: 'button', propertyId: 'p04' });

  assert.equal(result.changed, true);
  const event = events(db).at(-1);
  assert.equal(event.to_stage, 'site_visit_ready');
  assert.equal(event.property_id, 'p04');
});

test('stages do not move backwards, and only the board can undo a move', async () => {
  const db = createFakeSupabase();
  await upsertLeadMemory(db, { customerId: ID, budgetMax: Cr(1) });
  await setStage(db, ID, 'site_visit_ready', { actor: 'button' });

  assert.equal((await setStage(db, ID, 'interested', { actor: 'system' })).changed, false);
  assert.equal((await setStage(db, ID, 'interested', { actor: 'model' })).changed, false);
  assert.equal((await setStage(db, ID, 'interested', { actor: 'board' })).changed, true);
});

test('a stage change loses to a newer write instead of overwriting it', async () => {
  const db = createFakeSupabase();
  await upsertLeadMemory(db, { customerId: ID, budgetMax: Cr(1) });

  // Someone else moves the lead between our read and our write.
  const realFrom = db.from;
  let first = true;
  db.from = (name) => {
    const api = realFrom(name);
    if (name === 'customer_leads' && first) {
      const update = api.update.bind(api);
      api.update = (patch) => {
        if (patch.lead_stage && first) {
          first = false;
          db.tables.customer_leads[0].lead_stage = 'negotiating';
        }
        return update(patch);
      };
    }
    return api;
  };

  const result = await setStage(db, ID, 'not_interested', { actor: 'model' });
  assert.equal(result.changed, false);
  assert.match(result.reason, /changed by someone else/);
  assert.equal((await getLead(db, ID)).leadStage, 'negotiating');
});

test('shortlisting records an event, is idempotent, and moves the lead to interested', async () => {
  const db = createFakeSupabase();
  await upsertLeadMemory(db, { customerId: ID });

  const first = await addToShortlist(db, ID, 'p09');
  assert.deepEqual(first.lead.shortlistedPropertyIds, ['p09']);
  assert.equal(first.lead.leadStage, 'interested');

  await addToShortlist(db, ID, 'p09');
  assert.equal(events(db).filter((e) => e.event_type === 'shortlisted').length, 1);

  const removed = await removeFromShortlist(db, ID, 'p09');
  assert.deepEqual(removed.lead.shortlistedPropertyIds, []);
  assert.equal(events(db).at(-1).event_type, 'unshortlisted');
});

test('operations on a lead that does not exist report 404', async () => {
  const db = createFakeSupabase();
  await assert.rejects(addToShortlist(db, 'telegram:nobody', 'p01'), (e) => e.statusCode === 404);
  await assert.rejects(setStage(db, 'telegram:nobody', 'interested', { actor: 'system' }), (e) => e.statusCode === 404);
  assert.equal(await getLead(db, 'telegram:nobody'), null);
});

test('a search with no exact match is recorded as unmet demand when a lead id is given', async () => {
  const db = createFakeSupabase({ properties });
  await upsertLeadMemory(db, { customerId: ID });

  await searchProperties(db, {
    customerId: ID, location: 'OMR', category: 'residential', bedrooms: 3, maxBudget: Cr(1.5), limit: 5, offset: 0
  });
  const event = events(db).find((e) => e.event_type === 'zero_result');
  assert.ok(event);
  assert.equal(event.payload.outcome, 'recommendations');
  assert.match(event.note, /3 bedroom residential in OMR up to ₹1.5 Cr/);

  // An exact match records nothing.
  await searchProperties(db, { customerId: ID, location: 'OMR', category: 'residential', bedrooms: 2, maxBudget: Cr(1), limit: 5, offset: 0 });
  assert.equal(events(db).filter((e) => e.event_type === 'zero_result').length, 1);
});
