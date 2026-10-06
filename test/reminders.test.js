import assert from 'node:assert/strict';
import test from 'node:test';
import { inBusinessHours } from '../src/businessHours.js';
import { config } from '../src/config.js';
import { formatWait, waitingSince } from '../src/handoff.js';
import { sendReminders } from '../src/telegram/reminders.js';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

process.env.QUIET_LOGS = '1';
const SALES = 999;
const HOURS = { businessDays: [1, 2, 3, 4, 5, 6], businessOpenHour: 10, businessCloseHour: 19, businessTimeZone: 'Asia/Kolkata' };
const CONFIG = { ...config, ...HOURS, salesDeskChatId: SALES, visitReplyMinutes: 30, requestReplyMinutes: 120, holdingNoticeHours: 24, businessHours: 'Mon to Sat, 10am to 7pm IST' };

// Wednesday 7 October 2026, 12:00 in India.
const NOON = Date.parse('2026-10-07T06:30:00.000Z');
const minutesBefore = (minutes, from = NOON) => new Date(from - minutes * 60000).toISOString();

function setup({ kind = 'offer', status = 'open', messages }) {
  const supabase = createFakeSupabase({
    customer_leads: [{ customer_id: 'telegram:7', display_name: 'Asha', is_test: false }],
    handoffs: [{ id: 1, customer_id: 'telegram:7', kind, status, summary: 'Offered ₹54 L', alert_chat_id: SALES, alert_message_id: 50, created_at: messages[0].at, updated_at: messages[0].at }],
    handoff_messages: messages.map((m, i) => ({ id: i + 1, handoff_id: 1, direction: m.direction ?? 'customer', via: 'bot', text: 'x', created_at: m.at }))
  });
  const sent = [];
  const api = { sendMessage: async (chat, text, options) => { sent.push({ chat, text, options }); return { message_id: 70 + sent.length, chat: { id: chat } }; } };
  return { supabase, api, sent };
}
const run = (s, now = NOON) => sendReminders({ supabase: s.supabase, api: s.api, config: CONFIG, now: new Date(now) });

test('the wait runs from the customer\'s first unanswered message, and restarts when the customer answers the team', () => {
  const at = (n) => `2026-10-07T0${n}:00:00.000Z`;
  assert.equal(waitingSince([{ direction: 'customer', createdAt: at(1) }, { direction: 'customer', createdAt: at(2) }]), at(1), 'a second message does not reset the clock');
  assert.equal(waitingSince([{ direction: 'customer', createdAt: at(1) }, { direction: 'staff', createdAt: at(2) }]), null, 'the team has answered: nobody is waiting');
  assert.equal(waitingSince([{ direction: 'customer', createdAt: at(1) }, { direction: 'staff', createdAt: at(2) }, { direction: 'customer', createdAt: at(3) }]), at(3), 'a new wait begins');
});

test('the wait reads the way the board shows it', () => {
  assert.equal(formatWait(141), '2 hrs 21 mins');
  assert.equal(formatWait(120), '2 hrs');
  assert.equal(formatWait(61), '1 hr 1 min');
  assert.equal(formatWait(45), '45 mins');
  assert.equal(formatWait(0.4), 'less than a min');
});

test('business hours are Monday to Saturday, 10am to 7pm India time', () => {
  assert.equal(inBusinessHours(new Date('2026-10-07T06:30:00Z'), HOURS), true, 'Wednesday noon');
  assert.equal(inBusinessHours(new Date('2026-10-07T04:00:00Z'), HOURS), false, 'Wednesday 9:30am');
  assert.equal(inBusinessHours(new Date('2026-10-07T13:30:00Z'), HOURS), false, 'Wednesday 7pm');
  assert.equal(inBusinessHours(new Date('2026-10-04T06:30:00Z'), HOURS), false, 'Sunday noon');
  assert.equal(inBusinessHours(new Date('2026-10-03T06:30:00Z'), HOURS), true, 'Saturday noon');
});

test('a visit is reminded after 30 minutes, an offer after 2 hours, and not a minute earlier', async () => {
  const early = setup({ kind: 'visit', messages: [{ at: minutesBefore(29) }] });
  assert.equal((await run(early)).reminded, 0);

  const visit = setup({ kind: 'visit', messages: [{ at: minutesBefore(31) }] });
  assert.equal((await run(visit)).reminded, 1);
  assert.match(visit.sent[0].text, /Customer waiting 31 mins/);
  assert.equal(visit.sent[0].options.reply_parameters.message_id, 50, 'shown under the original alert');

  const offerSoon = setup({ kind: 'offer', messages: [{ at: minutesBefore(90) }] });
  assert.equal((await run(offerSoon)).reminded, 0);
  const offer = setup({ kind: 'offer', messages: [{ at: minutesBefore(125) }] });
  assert.equal((await run(offer)).reminded, 1);
  assert.match(offer.sent[0].text, /2 hrs 5 mins/);
});

test('the same wait is reminded once, not every minute', async () => {
  const s = setup({ kind: 'visit', messages: [{ at: minutesBefore(40) }] });
  assert.equal((await run(s)).reminded, 1);
  assert.equal((await run(s, NOON + 60000)).reminded, 0);
  assert.equal((await run(s, NOON + 5 * 60000)).reminded, 0);
});

test('nothing is sent outside business hours, and the reminder comes when they open', async () => {
  const sunday = Date.parse('2026-10-04T06:30:00.000Z');
  const s = setup({ kind: 'visit', messages: [{ at: minutesBefore(600, sunday) }] });
  assert.equal((await run(s, sunday)).reminded, 0);
  const monday = Date.parse('2026-10-05T04:31:00.000Z'); // 10:01 in India
  assert.equal((await run(s, monday)).reminded, 1);
});

test('a request that is waiting for the customer, or resolved, is not reminded', async () => {
  for (const status of ['waiting_customer', 'resolved']) {
    const s = setup({ kind: 'visit', status, messages: [{ at: minutesBefore(500) }] });
    assert.equal((await run(s)).reminded, 0, status);
  }
});

test('when the team has answered and the customer replies, a new wait starts and is reminded again', async () => {
  const s = setup({
    kind: 'offer',
    messages: [{ at: minutesBefore(600) }, { at: minutesBefore(500), direction: 'staff' }, { at: minutesBefore(130) }]
  });
  assert.equal((await run(s)).reminded, 1);
  assert.match(s.sent[0].text, /2 hrs 10 mins/, 'counted from the customer\'s latest unanswered message');
});

test('after a day the team is reminded again and the customer is told once, honestly', async () => {
  const s = setup({ kind: 'offer', messages: [{ at: minutesBefore(25 * 60) }] });
  const first = await run(s);
  assert.deepEqual(first, { reminded: 1, notified: 1 });
  const toCustomer = s.sent.find((m) => m.chat === 7);
  assert.equal(toCustomer.text, 'Our team has not replied yet. They are available Mon to Sat, 10am to 7pm IST. Your request is still open.');
  assert.ok(s.supabase.tables.chat_messages?.some((m) => m.customer_id === 'telegram:7' && /not replied yet/.test(m.content)), 'the assistant knows it said this');

  assert.deepEqual(await run(s, NOON + 3600000), { reminded: 0, notified: 0 }, 'not again');
});

test('a test lead gets the team reminder but no message to a chat that does not exist', async () => {
  const s = setup({ kind: 'offer', messages: [{ at: minutesBefore(25 * 60) }] });
  s.supabase.tables.customer_leads[0].customer_id = 'test:007';
  s.supabase.tables.handoffs[0].customer_id = 'test:007';
  const result = await run(s);
  assert.equal(result.reminded, 1);
  assert.equal(result.notified, 0);
});

test('with no Sales desk chat set, nothing is attempted', async () => {
  const s = setup({ kind: 'visit', messages: [{ at: minutesBefore(500) }] });
  const result = await sendReminders({ supabase: s.supabase, api: s.api, config: { ...CONFIG, salesDeskChatId: undefined }, now: new Date(NOON) });
  assert.deepEqual(result, { reminded: 0, notified: 0 });
  assert.equal(s.sent.length, 0);
});
