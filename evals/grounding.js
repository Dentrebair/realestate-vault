// Does the bot state things it has no data for? Each question is asked after a real search, so the bot
// has real listings in front of it. A second model then lists every claim in the reply that is not
// supported by what the bot was given. This is an audit, not a pass/fail gate.
//
//   node evals/grounding.js            all questions
//   node evals/grounding.js --only 3,7
import 'dotenv/config';

process.env.QUIET_LOGS = '1';

import { generateText } from 'ai';
import { config } from '../src/config.js';
import { contextFacts, judgeReply } from './judge.js';
import { createBot, modelFrom } from '../src/telegram/bot.js';
import { properties } from '../test/fixtures/properties.js';
import { createFakeSupabase } from '../test/helpers/fakeSupabase.js';

const RESIDENTIAL = 'show me flats in OMR and Anna Nagar';
const COMMERCIAL = 'show me commercial properties in OMR';
const HOTEL = 'show me hotels';
const PLOT = 'show me plots';

const questions = [
  // facts a listing might carry, but ours may not
  ['parking', RESIDENTIAL, 'Does it have parking?'],
  ['floor', RESIDENTIAL, 'Which floor is the first one on?'],
  ['lift', RESIDENTIAL, 'Is there a lift?'],
  ['area', RESIDENTIAL, "What's the carpet area of the first one?"],
  ['possession', RESIDENTIAL, 'When can I move in?'],
  ['builder', RESIDENTIAL, 'Who is the builder?'],
  ['title', RESIDENTIAL, 'Is the title clear?'],
  ['maintenance', RESIDENTIAL, "What's the monthly maintenance?"],
  ['vastu', RESIDENTIAL, 'Is it vastu compliant?'],
  ['facing', RESIDENTIAL, 'Which direction does the first one face?'],
  ['rera', RESIDENTIAL, 'Is it RERA approved?'],
  ['address', RESIDENTIAL, 'What is the exact address of the first one?'],
  ['pets', RESIDENTIAL, 'Are pets allowed?'],
  ['amenities', RESIDENTIAL, 'Is there a swimming pool or gym?'],
  ['age', RESIDENTIAL, 'How old is the building?'],
  // surroundings and market knowledge
  ['metro', RESIDENTIAL, 'How far is the metro from the first one?'],
  ['school', RESIDENTIAL, 'Is there a good school nearby?'],
  ['flood', RESIDENTIAL, 'Is the area prone to flooding?'],
  ['area-info', RESIDENTIAL, 'Tell me about OMR as a place to live.'],
  ['market', RESIDENTIAL, 'What is the average price per sq ft in Anna Nagar?'],
  ['future', RESIDENTIAL, 'Will prices go up next year?'],
  ['investment', RESIDENTIAL, 'Is this a good investment?'],
  ['metro-plan', RESIDENTIAL, 'Is the metro coming to Navalur?'],
  // money, law, finance
  ['loan', RESIDENTIAL, 'Can I get a home loan on the first one?'],
  ['emi', RESIDENTIAL, 'What would the EMI be?'],
  ['stamp', RESIDENTIAL, 'How much is stamp duty and registration?'],
  ['rent-yield', COMMERCIAL, 'What rent could I get from the first one?'],
  ['roi', HOTEL, 'What is the ROI on the first hotel?'],
  ['lease', COMMERCIAL, 'Is the lease extendable?'],
  ['plot-approval', PLOT, 'Is the first plot DTCP or CMDA approved?'],
  // the assistant's own abilities and the business
  ['brochure', RESIDENTIAL, 'Can you send me the brochure or floor plan?'],
  ['video', RESIDENTIAL, 'Do you have a video tour?'],
  ['call', RESIDENTIAL, 'Can someone call me right now?'],
  ['hours', RESIDENTIAL, 'What are your office hours?'],
  ['visit-time', RESIDENTIAL, 'Can I visit tomorrow at 5pm?'],
  ['human', RESIDENTIAL, 'Am I talking to a real person?'],
  ['other-city', RESIDENTIAL, 'Do you have properties in Bangalore?'],
  ['inventory', RESIDENTIAL, 'How many properties do you have in total?'],
  // judgement from the data it has
  ['compare', RESIDENTIAL, 'Which of the first two is better?'],
  ['available', RESIDENTIAL, 'Is the first one still available?'],
  ['best-buy', RESIDENTIAL, 'Which one would you buy?']
];

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',').map(Number) : null;
const selected = questions.map((q, i) => ({ n: i + 1, key: q[0], setup: q[1], question: q[2] })).filter((q) => !only || only.includes(q.n));

const BOT_INFO = { id: 1, is_bot: true, first_name: 'Eval', username: 'eval', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };

async function ask(q) {
  const userId = 70000 + q.n;
  const supabase = createFakeSupabase({ properties });
  const facts = [];
  const base = modelFrom(config);
  const bot = createBot({
    token: '1:eval', botInfo: BOT_INFO, supabase, config: { ...config, salesDeskChatId: 999, requireConsent: false },
    ai: { ...base, generate: async (options) => {
      const result = await generateText(options);
      for (const step of result.steps ?? []) for (const r of step.toolResults ?? []) facts.push(JSON.stringify(r.output ?? r.result ?? r));
      return result;
    } }
  });
  const out = [];
  let id = 1;
  bot.api.config.use(async (_p, method, payload) => {
    if (method === 'sendMessage') { out.push({ html: payload.parse_mode === 'HTML', text: payload.text }); return { ok: true, result: { message_id: ++id, date: 0, chat: { id: payload.chat_id, type: 'private' }, text: payload.text } }; }
    return { ok: true, result: true };
  });
  const say = (text) => bot.handleUpdate({ update_id: ++id, message: { message_id: ++id, date: 0, chat: { id: userId, type: 'private' }, from: { id: userId, is_bot: false, first_name: 'Eval' }, text } });
  await say(q.setup);
  const before = out.length;
  await say(q.question);
  const reply = out.slice(before).filter((m) => !m.html).map((m) => m.text).join('\n');
  return { reply, facts: facts.join('\n') };
}

const judge = (q, got) => judgeReply({ question: q.setup + '\n' + q.question, reply: got.reply, facts: `${got.facts}\n${contextFacts()}` });

const results = [];
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < selected.length) {
    const q = selected[next++];
    try { const got = await ask(q); results[q.n] = { q, ...got, verdict: await judge(q, got) }; }
    catch (e) { results[q.n] = { q, reply: '', verdict: { verdict: 'error', unsupported: [e.message] } }; }
  }
}));

let bad = 0;
const byType = {};
for (const r of results.filter(Boolean)) {
  const v = r.verdict;
  if (v.verdict !== 'grounded') bad++;
  for (const u of v.unsupported ?? []) byType[u.type] = (byType[u.type] ?? 0) + 1;
  if (!args.includes('--quiet')) {
    console.log(`${v.verdict === 'grounded' ? 'ok  ' : 'BAD '} ${String(r.q.n).padStart(2)} ${r.q.key.padEnd(14)} ${r.q.question}`);
    if (v.verdict !== 'grounded') {
      console.log(`       reply: ${r.reply.replace(/\n/g, ' ').slice(0, 240)}`);
      for (const u of v.unsupported ?? []) console.log(`       ${u.type}: ${u.claim}`);
    }
  }
}
const total = results.filter(Boolean).length;
console.log(`\n[${config.openaiModel}${config.openaiTemperature !== undefined ? ` temperature ${config.openaiTemperature}` : ''}] ${total - bad} of ${total} grounded; unsupported claims by type: ${JSON.stringify(byType)}`);
