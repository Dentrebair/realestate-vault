import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { addToShortlist, getLead, upsertLeadMemory } from '../src/leadMemory.js';
import { describePeriod, eraseCustomer, runRetention } from '../src/privacy.js';
import { createBot } from '../src/telegram/bot.js';
import { properties } from './fixtures/properties.js';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

const USER = 5151;
const ID = `telegram:${USER}`;
let counter = 5000;
const next = () => ++counter;
const person = { id: USER, is_bot: false, first_name: 'Meera', username: 'meera_k' };
const chat = { id: USER, type: 'private' };

const say = (text) => ({
  update_id: next(),
  message: {
    message_id: next(), date: 0, chat, from: person, text,
    ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {})
  }
});
const tap = (data) => ({ update_id: next(), callback_query: { id: String(next()), from: person, chat_instance: 'x', data, message: { message_id: 9, date: 0, chat, text: 'x' } } });

const BOT_INFO = { id: 1, is_bot: true, first_name: 'Bot', username: 'b', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };

function harness({ tables = {}, config = {} } = {}) {
  const supabase = createFakeSupabase({ properties, ...tables });
  const calls = [];
  let modelCalls = 0;
  const bot = createBot({
    token: '1:t', botInfo: BOT_INFO, supabase,
    config: {
      requireConsent: true, businessName: 'Acme Homes', privacyContact: 'privacy@acme.example', consentVersion: 'v1',
      chatRetentionHours: 24, leadRetentionHours: 24 * 365, businessHours: 'Mon to Sat', salesDeskChatId: 999, agentTimeoutMs: 5000, ...config
    },
    ai: { generate: async () => (modelCalls++, { text: 'Happy to help.' }), model: {}, providerOptions: undefined }
  });
  bot.api.config.use(async (_p, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: method === 'sendMessage' ? { message_id: next(), date: 0, chat, text: payload.text } : true };
  });
  return {
    supabase, calls,
    send: (u) => bot.handleUpdate(u),
    replies: () => calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === USER).map((c) => c.payload),
    answers: () => calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.payload),
    modelCalls: () => modelCalls,
    rows: (t) => supabase.tables[t] ?? []
  };
}

const buttons = (payload) => payload.reply_markup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];

// ---- consent ----------------------------------------------------------------------------------

test('before agreeing, nothing is kept and nothing goes to the AI', async () => {
  const h = harness();
  await h.send(say('3BHK in OMR under 1.5 crore, my number is 9876543210'));

  assert.equal(h.modelCalls(), 0);
  const [prompt] = h.replies();
  assert.match(prompt.text, /^Before we start: Acme Homes keeps what you tell this assistant/);
  assert.deepEqual(buttons(prompt), ['action:consent:yes', 'action:privacy']);

  const lead = h.rows('customer_leads')[0];
  assert.equal(lead.customer_id, ID);
  assert.equal(lead.display_name, undefined, 'no name');
  assert.equal(lead.handle, undefined, 'no username');
  assert.equal(lead.consent_at, undefined);
  assert.equal(h.rows('chat_messages').length, 0, 'the message was not saved');
  assert.ok(!JSON.stringify(h.rows('customer_leads')).includes('9876543210'));
});

test('/start asks for consent, holds the campaign code, and stores it only after agreeing', async () => {
  const h = harness();
  await h.send(say('/start omr_ad1'));
  assert.match(h.replies()[0].text, /^Before we start/);
  let lead = h.rows('customer_leads')[0];
  assert.equal(lead.source, undefined);
  assert.equal(lead.bot_state.pendingSource, 'omr_ad1');
  assert.equal(lead.display_name, undefined);

  await h.send(tap('action:consent:yes'));
  lead = await getLead(h.supabase, ID);
  assert.ok(lead.consentAt);
  assert.equal(lead.consentVersion, 'v1');
  assert.equal(lead.displayName, 'Meera');
  assert.equal(lead.handle, 'meera_k');
  assert.equal(lead.source, 'omr_ad1');
  assert.equal(lead.botState.pendingSource, null);
  assert.match(h.replies().at(-1).text, /^Hi Meera!/);
  assert.ok(h.rows('lead_events').some((e) => e.event_type === 'consent_given'));

  await h.send(say('hello there'));
  assert.equal(h.modelCalls(), 1, 'after agreeing the conversation works');
  assert.equal(h.rows('chat_messages').length, 2);
});

test('buttons and commands that use a profile wait for consent; the notice and /forget do not', async () => {
  const h = harness();
  await h.send(tap('action:save:p09'));
  assert.equal(h.answers()[0].show_alert, true);
  assert.match(h.answers()[0].text, /tap "I agree" first/);
  assert.match(h.replies().at(-1).text, /^Before we start/);
  assert.deepEqual(h.rows('customer_leads')[0].shortlisted_property_ids, []);

  await h.send(say('/saved'));
  await h.send(say('/reset'));
  assert.equal(h.replies().filter((r) => /^Before we start/.test(r.text)).length, 3);

  await h.send(tap('action:privacy'));
  assert.match(h.replies().at(-1).text, /^Privacy notice/);
  await h.send(say('/privacy'));
  assert.match(h.replies().at(-1).text, /^Privacy notice/);
  await h.send(say('/forget'));
  assert.match(h.replies().at(-1).text, /^This deletes your profile/);
});

test('a lead who existed before consent was required is asked once', async () => {
  const h = harness();
  await upsertLeadMemory(h.supabase, { customerId: ID, displayName: 'Meera', budgetMax: 1e7 }, { actor: 'system' });
  await h.send(say('show me flats'));
  assert.match(h.replies()[0].text, /^Before we start/);
  assert.equal(h.modelCalls(), 0);
  await h.send(tap('action:consent:yes'));
  await h.send(say('show me flats'));
  assert.equal(h.modelCalls(), 1);
});

test('consent can be switched off for development and tests', async () => {
  const h = harness({ config: { requireConsent: false } });
  await h.send(say('hello'));
  assert.equal(h.modelCalls(), 1);
  assert.equal((await getLead(h.supabase, ID)).displayName, 'Meera');
});

// ---- the notice, /mydata and /forget -----------------------------------------------------------

test('the privacy notice names the business, how to reach it, and how long data is kept', async () => {
  const h = harness();
  await h.send(say('/privacy'));
  const text = h.replies()[0].text;
  assert.match(text, /Acme Homes uses this assistant/);
  assert.match(text, /contact privacy@acme\.example/);
  assert.match(text, /messages are deleted after 24 hours, and your profile after 12 months/);
  assert.match(text, /\/mydata shows what we hold about you\. \/forget deletes it all/);
  assert.match(text, /not removed automatically/);

  const bare = harness({ config: { privacyContact: undefined, chatRetentionHours: 720 } });
  await bare.send(say('/privacy'));
  assert.match(bare.replies()[0].text, /contact the team that shared this assistant with you/);
  assert.match(bare.replies()[0].text, /deleted after 30 days/);
});

test('describePeriod speaks in hours, days, months and years', () => {
  assert.equal(describePeriod(24), '24 hours');
  assert.equal(describePeriod(720), '30 days');
  assert.equal(describePeriod(8760), '12 months');
  assert.equal(describePeriod(17520), '2 years');
});

test('/mydata lists exactly what is held', async () => {
  const h = harness();
  await h.send(say('/mydata'));
  assert.match(h.replies()[0].text, /hold only your Telegram id and nothing else/);

  await h.send(tap('action:consent:yes'));
  await upsertLeadMemory(h.supabase, { customerId: ID, phone: '+919800000001', budgetMax: 15000000, preferredLocations: ['OMR'], bedrooms: 3 }, { actor: 'system' });
  await addToShortlist(h.supabase, ID, 'p04');
  await h.send(say('hello there'));
  await h.send(say('/mydata'));

  const text = h.replies().at(-1).text;
  assert.match(text, /Name shown on Telegram: Meera/);
  assert.match(text, /Telegram username: @meera_k/);
  assert.match(text, /Phone number: \+919800000001/);
  assert.match(text, /3 bedrooms, in OMR, budget ₹1.5 Cr/);
  assert.match(text, /Shortlisted: High-Rise 2BHK Apartment near Tech Parks/);
  assert.match(text, /Messages we hold: 2/);
  assert.match(text, /Send \/forget to delete it all/);
});

test('/forget asks first, deletes everything on confirmation, and keeps only a hash as proof', async () => {
  const h = harness();
  await h.send(tap('action:consent:yes'));
  await h.send(say('hello there'));
  await addToShortlist(h.supabase, ID, 'p04');
  h.supabase.tables.knowledge_gaps = [
    { id: 1, customer_id: ID, question: 'Is there parking?', kind: 'other', group_key: 'k', status: 'open' },
    { id: 2, customer_id: 'telegram:other', question: 'Is there a lift?', kind: 'other', group_key: 'k2', status: 'open' }
  ];

  await h.send(say('/forget'));
  assert.deepEqual(buttons(h.replies().at(-1)), ['action:forget:yes', 'action:forget:no']);
  assert.ok(h.rows('customer_leads').length === 1, 'asking deletes nothing');

  await h.send(tap('action:forget:no'));
  assert.match(h.replies().at(-1).text, /Nothing was deleted/);
  assert.equal(h.rows('customer_leads').length, 1);

  await h.send(tap('action:forget:yes'));
  assert.match(h.replies().at(-1).text, /Everything we held about you has been deleted/);
  assert.equal(h.rows('customer_leads').length, 0);
  assert.equal(h.rows('chat_messages').length, 0);
  assert.equal(h.rows('lead_events').length, 0);
  assert.deepEqual(h.rows('knowledge_gaps').map((g) => g.customer_id), ['telegram:other'], 'only this customer\'s gaps go');

  const [log] = h.rows('deletion_log');
  assert.equal(log.reason, 'customer_request');
  assert.equal(log.customer_ref, createHash('sha256').update(ID).digest('hex'));
  assert.ok(!JSON.stringify(log).includes(String(USER)), 'the log does not hold who it was');
  assert.ok(log.removed.messages >= 2);

  // A stranger again.
  await h.send(say('hello again'));
  assert.match(h.replies().at(-1).text, /^Before we start/);
  assert.equal(h.rows('customer_leads')[0].display_name, undefined);
});

// ---- retention --------------------------------------------------------------------------------

test('retention deletes old messages and idle real leads, and never touches test leads', async () => {
  const db = createFakeSupabase();
  const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
  db.tables.customer_leads = [
    { customer_id: 'telegram:old', is_test: false, last_contacted_at: hoursAgo(48), lead_stage: 'interested' },
    { customer_id: 'telegram:fresh', is_test: false, last_contacted_at: hoursAgo(2), lead_stage: 'interested' },
    { customer_id: 'test:old', is_test: true, last_contacted_at: hoursAgo(500), lead_stage: 'interested' }
  ];
  db.tables.chat_messages = [
    { id: 1, customer_id: 'telegram:old', role: 'user', content: 'a', created_at: hoursAgo(48) },
    { id: 2, customer_id: 'telegram:fresh', role: 'user', content: 'b', created_at: hoursAgo(30) },
    { id: 3, customer_id: 'telegram:fresh', role: 'user', content: 'c', created_at: hoursAgo(1) }
  ];
  db.tables.lead_events = [{ customer_id: 'telegram:old', event_type: 'lead_created' }];
  db.tables.knowledge_gaps = [{ id: 1, customer_id: 'telegram:old', question: 'q', kind: 'other', group_key: 'g' }];

  const done = await runRetention(db, { chatHours: 24, leadHours: 24 });
  assert.equal(done.leads, 1);
  assert.deepEqual(db.tables.customer_leads.map((l) => l.customer_id).sort(), ['telegram:fresh', 'test:old']);
  assert.deepEqual(db.tables.chat_messages.map((m) => m.id), [3], 'messages older than 24 hours are gone, recent ones stay');
  assert.equal(db.tables.knowledge_gaps.length, 0);
  assert.equal(db.tables.deletion_log[0].reason, 'retention');
  assert.equal(done.messages, 2);

  // Nothing more to do on a second run.
  assert.deepEqual(await runRetention(db, { chatHours: 24, leadHours: 24 }), { messages: 0, leads: 0 });
});

test('erasing a customer that does not exist is harmless', async () => {
  const db = createFakeSupabase();
  const removed = await eraseCustomer(db, 'telegram:ghost', { reason: 'customer_request' });
  assert.deepEqual(removed, { messages: 0, events: 0, knowledgeGaps: 0 });
});

test('log lines never carry what a customer typed', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../src/telegram/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    for (const call of source.matchAll(/\blog\(\s*'[a-z_]+'\s*,\s*\{([^}]*)\}/g)) {
      assert.doesNotMatch(call[1], /\b(text|content|message|question|reply)\s*[:,}]/, `${file}: ${call[0]}`);
    }
  }
});

test('agreeing works before sql/005 adds the consent_version column', async () => {
  const h = harness();
  await h.send(say('/start'));
  const realFrom = h.supabase.from;
  h.supabase.from = (name) => {
    const api = realFrom(name);
    if (name !== 'customer_leads') return api;
    const update = api.update.bind(api);
    api.update = (patch) => {
      if ('consent_version' in patch) {
        const chain = { eq: () => chain, then: (resolve) => resolve({ data: null, error: { message: "Could not find the 'consent_version' column of 'customer_leads' in the schema cache" } }) };
        return chain;
      }
      return update(patch);
    };
    return api;
  };
  await h.send(tap('action:consent:yes'));
  const lead = await getLead(h.supabase, ID);
  assert.ok(lead.consentAt, 'consent was recorded without the version');
  assert.equal(lead.displayName, 'Meera');
  assert.match(h.replies().at(-1).text, /^Hi Meera!/);
});
