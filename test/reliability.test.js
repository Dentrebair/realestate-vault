import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { retryWhenBusy } from '../src/telegram/bot.js';
import { createInbox } from '../src/telegram/inbox.js';
import { resendVisitAlerts } from '../src/telegram/sales.js';
import { drain, startRecovery } from '../src/telegram/webhook.js';
import { properties } from './fixtures/properties.js';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

process.env.QUIET_LOGS = '1';
const SECRET = 's'.repeat(32);
const post = (app, update) => request(app).post('/telegram/webhook').set('X-Telegram-Bot-Api-Secret-Token', SECRET).send(update);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('an update is written down before the bot says "received", and cleared when it is done', async () => {
  const supabase = createFakeSupabase();
  const seen = [];
  const bot = { handleUpdate: async (u) => { seen.push(u.update_id); } };
  const app = createApp({ supabase: null, telegramBot: bot, telegramSecret: SECRET, inbox: createInbox({ supabase }) });

  await post(app, { update_id: 11, message: { text: 'hello' } }).expect(200);
  await drain(1000);

  assert.deepEqual(seen, [11]);
  const row = supabase.tables.telegram_updates.find((r) => r.update_id === 11);
  assert.equal(row.status, 'done');
  assert.equal(row.payload, null, 'the message text is not kept once the update is done');
});

test('a repeat of an update is recognised, even after a restart, and processed once', async () => {
  const supabase = createFakeSupabase();
  const seen = [];
  const bot = { handleUpdate: async (u) => { seen.push(u.update_id); } };
  const first = createApp({ supabase: null, telegramBot: bot, telegramSecret: SECRET, inbox: createInbox({ supabase }) });
  await post(first, { update_id: 5 }).expect(200);
  await drain(1000);

  // A new process has an empty memory but the same database.
  const second = createApp({ supabase: null, telegramBot: bot, telegramSecret: SECRET, inbox: createInbox({ supabase }) });
  await post(second, { update_id: 5 }).expect(200);
  await drain(1000);

  assert.deepEqual(seen, [5]);
});

test('if the update cannot be written down, Telegram is told to try again', async () => {
  const supabase = createFakeSupabase();
  const realFrom = supabase.from;
  supabase.from = (name) => name === 'telegram_updates'
    ? { insert: () => Promise.resolve({ data: null, error: { code: '57P01', message: 'connection lost' } }) }
    : realFrom(name);
  const seen = [];
  const app = createApp({ supabase: null, telegramBot: { handleUpdate: async (u) => seen.push(u) }, telegramSecret: SECRET, inbox: createInbox({ supabase }) });

  await post(app, { update_id: 9 }).expect(500);
  assert.equal(seen.length, 0);
});

test('before sql/006 is run, the bot still answers as it did before', async () => {
  const supabase = createFakeSupabase();
  const missing = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.telegram_updates' in the schema cache" } };
  const chain = { eq: () => chain, then: (resolve) => resolve(missing) };
  supabase.from = () => ({ insert: () => Promise.resolve(missing), update: () => chain });
  const seen = [];
  const app = createApp({ supabase: null, telegramBot: { handleUpdate: async (u) => seen.push(u.update_id) }, telegramSecret: SECRET, inbox: createInbox({ supabase }) });

  await post(app, { update_id: 3 }).expect(200);
  await drain(1000);
  assert.deepEqual(seen, [3]);
});

test('an update that was accepted but never finished is processed again, once', async () => {
  const supabase = createFakeSupabase({
    telegram_updates: [
      { update_id: 21, status: 'received', payload: { update_id: 21, message: { text: 'lost in a crash' } }, received_at: '2026-01-01T00:00:00.000Z' },
      { update_id: 22, status: 'done', payload: null, received_at: '2026-01-01T00:00:00.000Z', done_at: '2026-01-01T00:00:01.000Z' }
    ]
  });
  const seen = [];
  const bot = { handleUpdate: async (u) => { seen.push(u.update_id); } };
  const recovery = startRecovery(bot, createInbox({ supabase, now: () => Date.parse('2026-01-02T00:00:00.000Z') }), { everyMs: 3600000 });

  await recovery.run();
  await recovery.run();
  recovery.stop();

  assert.deepEqual(seen, [21], 'only the unfinished update, and only once');
  assert.equal(supabase.tables.telegram_updates.find((r) => r.update_id === 21).status, 'done');
});

test('a very recent update is left alone, because it may still be being answered', async () => {
  const supabase = createFakeSupabase({
    telegram_updates: [{ update_id: 31, status: 'received', payload: { update_id: 31 }, received_at: '2026-01-01T00:00:30.000Z' }]
  });
  const seen = [];
  const recovery = startRecovery({ handleUpdate: async (u) => seen.push(u) }, createInbox({ supabase, now: () => Date.parse('2026-01-01T00:01:00.000Z') }), { everyMs: 3600000 });
  await recovery.run();
  recovery.stop();
  assert.equal(seen.length, 0);
});

test('shutting down waits for a reply that is being written', async () => {
  let finished = false;
  const bot = { handleUpdate: async () => { await wait(80); finished = true; } };
  const app = createApp({ supabase: null, telegramBot: bot, telegramSecret: SECRET });
  await post(app, { update_id: 1 }).expect(200);

  assert.equal(finished, false, 'the reply is still being written');
  const left = await drain(2000);
  assert.equal(finished, true);
  assert.equal(left, 0);
});

test('when Telegram says "too fast", the call waits and goes again; other failures are not repeated', async () => {
  const waits = [];
  const retry = retryWhenBusy({ sleep: async (ms) => waits.push(ms) });

  let calls = 0;
  const busyTwice = async () => (++calls < 3 ? { ok: false, error_code: 429, parameters: { retry_after: 2 } } : { ok: true, result: 'sent' });
  assert.deepEqual(await retry(busyTwice, 'sendMessage', {}), { ok: true, result: 'sent' });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 2000]);

  let other = 0;
  const failed = async () => (other++, { ok: false, error_code: 400, description: 'Bad Request' });
  assert.equal((await retry(failed, 'sendMessage', {})).ok, false);
  assert.equal(other, 1, 'a 400 is not retried');

  const alwaysBusy = async () => ({ ok: false, error_code: 429, parameters: { retry_after: 60 } });
  const gaveUp = await retryWhenBusy({ attempts: 2, sleep: async (ms) => waits.push(ms) })(alwaysBusy, 'sendMessage', {});
  assert.equal(gaveUp.ok, false);
  assert.equal(waits.at(-1), 5000, 'a long wait is capped');
});

test('a visit request whose alert failed is sent again, and not sent twice', async () => {
  const lead = { customer_id: 'telegram:1', display_name: 'Asha', handle: null, lead_stage: 'site_visit_ready', is_test: false };
  const make = (alertedAt) => createFakeSupabase({
    properties,
    customer_leads: [lead],
    lead_events: [{ id: 1, customer_id: 'telegram:1', event_type: 'site_visit_requested', property_id: 'p04', alerted_at: alertedAt, created_at: '2026-01-01T00:00:00.000Z' }]
  });
  const now = () => Date.parse('2026-01-01T00:10:00.000Z');
  const sentTo = [];
  const api = { sendMessage: async (chat, text) => { sentTo.push({ chat, text }); } };

  const supabase = make(null);
  assert.equal(await resendVisitAlerts({ supabase, api, chatId: 999, now }), 1);
  assert.match(sentTo[0].text, /Site visit requested/);
  assert.match(sentTo[0].text, /High-Rise 2BHK Apartment/);
  assert.ok(supabase.tables.lead_events[0].alerted_at, 'marked as alerted');

  assert.equal(await resendVisitAlerts({ supabase, api, chatId: 999, now }), 0, 'not sent a second time');
  assert.equal(await resendVisitAlerts({ supabase: make('2026-01-01T00:00:05.000Z'), api, chatId: 999, now }), 0, 'already alerted');
  assert.equal(await resendVisitAlerts({ supabase: make(null), api, chatId: null, now }), 0, 'no Sales desk chat set');
  assert.equal(await resendVisitAlerts({ supabase: make(null), api, chatId: 999, now: () => Date.parse('2026-01-01T00:00:30.000Z') }), 0, 'too recent: the first attempt may still be running');

  const failing = { sendMessage: async () => { throw new Error('chat not found'); } };
  const stillPending = make(null);
  assert.equal(await resendVisitAlerts({ supabase: stillPending, api: failing, chatId: 999, now }), 0);
  assert.equal(stillPending.tables.lead_events[0].alerted_at, null, 'stays pending and is tried again later');
});

test('behind the hosting proxy in production, the visitor\'s address is read from the forwarded header', async () => {
  const { config } = await import('../src/config.js');
  const before = config.nodeEnv;
  config.nodeEnv = 'production';
  try {
    const app = createApp({ supabase: null, enableToolRoutes: false, admin: null });
    assert.equal(app.get('trust proxy'), 1);
  } finally {
    config.nodeEnv = before;
  }
});

// ---- the outside monitor's check ---------------------------------------------------------------

const readyApp = ({ supabase, info, mode = 'webhook' }) =>
  createApp({
    supabase,
    telegramBot: { handleUpdate: async () => {}, api: { getWebhookInfo: async () => { if (info instanceof Error) throw info; return info; } } },
    telegramSecret: SECRET,
    telegramMode: mode,
    enableToolRoutes: false,
    admin: null
  });
const GOOD = { url: 'https://x.up.railway.app/telegram/webhook', pending_update_count: 0 };

test('/health/ready is 200 when the database answers and Telegram can reach us', async () => {
  const response = await request(readyApp({ supabase: createFakeSupabase({ properties }), info: GOOD })).get('/health/ready').expect(200);
  assert.deepEqual(response.body, { ok: true, database: 'ok', webhook: 'ok', pendingUpdates: 0 });
});

test('/health/ready is 503 when the database is down', async () => {
  const supabase = createFakeSupabase({ properties });
  supabase.from = () => ({ select: () => ({ limit: () => Promise.resolve({ data: null, error: { message: 'connection lost' } }) }) });
  const response = await request(readyApp({ supabase, info: GOOD })).get('/health/ready').expect(503);
  assert.equal(response.body.database, 'down');
  assert.equal(response.body.ok, false);
});

test('/health/ready is 503 when Telegram has no address for us, or is failing to deliver', async () => {
  const supabase = createFakeSupabase({ properties });
  assert.equal((await request(readyApp({ supabase, info: { url: '' } })).get('/health/ready').expect(503)).body.webhook, 'missing');

  const failing = { ...GOOD, pending_update_count: 4, last_error_date: Math.floor(Date.now() / 1000) - 60, last_error_message: 'Wrong response from the webhook: 500' };
  const body = (await request(readyApp({ supabase, info: failing })).get('/health/ready').expect(503)).body;
  assert.equal(body.webhook, 'erroring');
  assert.equal(body.pendingUpdates, 4);
  assert.match(body.lastError, /500/);

  assert.equal((await request(readyApp({ supabase, info: new Error('network') })).get('/health/ready').expect(503)).body.webhook, 'unknown');
});

test('an old webhook error is not held against the service, and polling mode skips the webhook check', async () => {
  const supabase = createFakeSupabase({ properties });
  const old = { ...GOOD, last_error_date: Math.floor(Date.now() / 1000) - 3600, last_error_message: 'old' };
  await request(readyApp({ supabase, info: old })).get('/health/ready').expect(200);
  const response = await request(readyApp({ supabase, info: new Error('would fail'), mode: 'polling' })).get('/health/ready').expect(200);
  assert.equal(response.body.webhook, 'skipped');
});

test('the readiness answer is kept for 30 seconds, so the page cannot be used to hammer Telegram', async () => {
  let calls = 0;
  const app = createApp({
    supabase: createFakeSupabase({ properties }),
    telegramBot: { handleUpdate: async () => {}, api: { getWebhookInfo: async () => (calls++, GOOD) } },
    telegramSecret: SECRET, telegramMode: 'webhook', enableToolRoutes: false, admin: null
  });
  for (let i = 0; i < 5; i++) await request(app).get('/health/ready').expect(200);
  assert.equal(calls, 1);
});
