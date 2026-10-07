// Does the model read a customer's wish for a visit date and time correctly? Real model, fixed "today".
//   npm run eval:visit-time
import 'dotenv/config';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { config } from '../src/config.js';
import { readPreferredTime } from '../src/telegram/visitTime.js';

// Thursday 8 Oct 2026, 11:00.
const TODAY = { today: '2026-10-08', weekday: 'Thu', now: '11:00' };
const deps = { generate: generateText, model: createOpenAI({ apiKey: config.openaiApiKey })('gpt-5-mini'), providerOptions: { openai: { reasoningEffort: 'minimal' } } };

const cases = [
  ['tomorrow 11am', { date: '2026-10-09', time: '11:00' }],
  ['this saturday at 10:30', { date: '2026-10-10', time: '10:30' }],
  ['saturday 10 am works', { date: '2026-10-10', time: '10:00' }],
  ['next monday 4pm', { date: '2026-10-12', time: '16:00' }],
  ['12 Oct at 3 pm', { date: '2026-10-12', time: '15:00' }],
  ['sunday morning', { date: '2026-10-11', time: null }],
  ['tomorrow', { date: '2026-10-09', time: null }],
  ['11am', { date: null, time: '11:00' }],
  ['naalaiku kaalai 10 manikku', { date: '2026-10-09', time: '10:00' }],
  ['saturday evening 5', { date: '2026-10-10', time: '17:00' }],
  ['never mind', { cancel: true }],
  ['not interested anymore', { cancel: true }],
  ['what is the price of this?', { unrelated: true }],
  ['show me villas in ECR', { unrelated: true }],
  ['thanks', { unrelated: true }]
];

let ok = 0;
for (const [text, want] of cases) {
  const got = await readPreferredTime({ text, ...TODAY, deps });
  const good = got && ['date', 'time'].every((k) => want[k] === undefined || got[k] === want[k]) && (!want.cancel || got.cancel) && (!want.unrelated || got.unrelated);
  if (good) ok += 1;
  else console.log(`MISS "${text}": wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
console.log(`${ok} of ${cases.length}`);
process.exit(ok >= cases.length - 1 ? 0 : 1);
