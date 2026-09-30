// Runs test leads through the real model and checks the behaviour, not the wording.
//
//   npm run eval                     the core set (about 30 leads)
//   npm run eval -- --all            all 50
//   npm run eval -- --lead 011,014   chosen leads
//   npm run eval -- --tag near-miss  leads with a tag
//
// Uses an in-memory database seeded with a snapshot of the 20 listings. Nothing is written to Supabase
// and nothing is sent to Telegram. It does call OpenAI, so it costs a few cents per run.
import 'dotenv/config';

process.env.QUIET_LOGS = '1';

import { generateText } from 'ai';
import { config } from '../src/config.js';
import { createBot, modelFrom } from '../src/telegram/bot.js';
import { properties } from '../test/fixtures/properties.js';
import { testLeads } from '../test/fixtures/testLeads.js';
import { createFakeSupabase } from '../test/helpers/fakeSupabase.js';
import { CORE, checksFor } from './cases.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1];
};

if (!config.openaiApiKey) {
  console.error('OPENAI_API_KEY is not set in .env');
  process.exit(1);
}

let selected = testLeads.filter((t) => CORE.includes(t.id.split(':')[1]));
if (args.includes('--all')) selected = testLeads;
if (flag('--lead')) {
  const wanted = flag('--lead').split(',');
  selected = testLeads.filter((t) => wanted.includes(t.id.split(':')[1]));
}
if (flag('--tag')) selected = testLeads.filter((t) => t.tags.includes(flag('--tag')));

const SALES = 999;
const BOT_INFO = { id: 1, is_bot: true, first_name: 'Eval', username: 'eval', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };

async function runLead(t) {
  const n = Number(t.id.split(':')[1]);
  const userId = 50000 + n;
  const supabase = createFakeSupabase({ properties });
  await supabase.from('customer_leads').insert(leadRow(t, userId));

  const toolCalls = [];
  let tokens = 0;
  const base = modelFrom(config);
  const bot = createBot({
    token: '1:eval',
    botInfo: BOT_INFO,
    supabase,
    config: { ...config, salesDeskChatId: SALES },
    ai: {
      ...base,
      generate: async (options) => {
        const result = await generateText(options);
        for (const step of result.steps ?? []) {
          for (const call of step.toolCalls ?? []) toolCalls.push({ name: call.toolName, input: call.input });
        }
        tokens += result.usage?.totalTokens ?? 0;
        return result;
      }
    }
  });

  const out = [];
  let id = 1;
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === 'sendMessage') {
      out.push({
        to: payload.chat_id === SALES ? 'sales' : 'user',
        text: payload.text,
        html: payload.parse_mode === 'HTML',
        buttons: payload.reply_markup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? []
      });
      return { ok: true, result: { message_id: ++id, date: 0, chat: { id: payload.chat_id, type: 'private' }, text: payload.text } };
    }
    return { ok: true, result: true };
  });

  const started = Date.now();
  for (const text of t.messages) {
    await bot.handleUpdate({
      update_id: ++id,
      message: {
        message_id: ++id,
        date: 0,
        chat: { id: userId, type: 'private' },
        from: { id: userId, is_bot: false, first_name: t.name.split(' ')[0], username: `eval${n}` },
        text,
        ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {})
      }
    });
  }

  const user = out.filter((m) => m.to === 'user');
  const result = {
    lead: t,
    out,
    cards: user.filter((m) => m.html && /💰/.test(m.text)).map((m) => m.text),
    replies: user.filter((m) => !m.html).map((m) => m.text),
    sales: out.filter((m) => m.to === 'sales').map((m) => m.text),
    tools: toolCalls,
    row: supabase.tables.customer_leads[0],
    events: supabase.tables.lead_events ?? [],
    seconds: (Date.now() - started) / 1000,
    tokens
  };
  result.checks = checksFor(n, result);
  return result;
}

function leadRow(t, userId) {
  const p = t.profile;
  const shortlist = p.shortlist
    .map((hint) => properties.find((x) => x.location.toLowerCase().includes(hint.toLowerCase()))?.property_id)
    .filter(Boolean);
  return {
    customer_id: `telegram:${userId}`,
    display_name: t.name.split(' ')[0],
    lead_stage: t.stage,
    intent: p.intent ?? null,
    budget_min: p.budgetMin ?? null,
    budget_max: p.budgetMax ?? null,
    preferred_locations: p.locations,
    property_categories: p.categories,
    bedrooms: p.bedrooms ?? null,
    must_haves: p.mustHaves,
    deal_breakers: p.dealBreakers,
    urgency: p.urgency ?? null,
    financing_status: p.financing ?? null,
    key_points: p.keyPoints,
    shortlisted_property_ids: shortlist,
    last_query_summary: p.lastQuery ?? null,
    next_action: p.nextAction ?? null,
    is_test: true
  };
}

// Four leads at a time keeps this quick without hitting rate limits.
async function pool(items, size, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await task(items[i]).catch((error) => ({ lead: items[i], crashed: error, checks: { fail: [`crashed: ${error.message}`], warn: [] }, seconds: 0, tokens: 0 }));
      }
    })
  );
  return results;
}

console.log(`Running ${selected.length} test leads with ${config.openaiModel} (effort ${config.openaiReasoningEffort})\n`);
const started = Date.now();
const results = await pool(selected, 4, runLead);

let failed = 0;
let warned = 0;
for (const r of results) {
  const { fail, warn } = r.checks;
  const status = fail.length ? 'FAIL' : warn.length ? 'WARN' : 'PASS';
  if (fail.length) failed++;
  else if (warn.length) warned++;
  console.log(`${status}  ${r.lead.id.slice(5)}  ${r.lead.name.padEnd(20)} ${String(r.lead.messages[0]).slice(0, 48).padEnd(48)} ${r.seconds.toFixed(1)}s ${(r.tokens / 1000).toFixed(1)}k tok`);
  for (const f of fail) console.log(`      ✗ ${f}`);
  for (const w of warn) console.log(`      ~ ${w}`);
  if (fail.length || args.includes('--verbose')) {
    for (const m of r.out ?? []) console.log(`        ${m.to}: ${m.text.replace(/\n/g, ' | ').slice(0, 200)}`);
  }
}

const tokens = results.reduce((sum, r) => sum + r.tokens, 0);
console.log(`\n${results.length - failed - warned} passed, ${warned} with warnings, ${failed} failed. ${(tokens / 1000).toFixed(0)}k tokens, ${((Date.now() - started) / 1000).toFixed(0)}s.`);
if (failed) console.log('Re-run a failing lead with: npm run eval -- --lead <id> --verbose');
process.exit(failed ? 1 : 0);
