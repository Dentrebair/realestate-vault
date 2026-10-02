// Does the model route messages better than the keyword rules? Both run on the same labelled messages with the real
// model. Measures only; nothing in the bot uses the router yet.
//
//   npm run eval:router                 one pass, prints every miss
//   npm run eval:router -- --repeat 3   also checks the model gives the same label each time
import 'dotenv/config';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { config } from '../src/config.js';
import { hasSearchIntent, topicOf } from '../src/telegram/facts.js';
import {
  asksAvailability, asksCount, asksIfHuman, asksHours, asksOtherCity, asksPrice, asksToCompare, proposesVisitTime
} from '../src/telegram/gateway.js';
import { asksAboutPhotos, isNegotiation, isPriceOffer, wantsRental } from '../src/telegram/intent.js';
import { routeMessage } from '../src/telegram/router.js';
import { cases, shown } from './router-cases.js';

// The keyword rules in the order the gateway applies them.
function rulesLabel(t) {
  if (asksAboutPhotos(t)) return 'photos';
  if (wantsRental(t)) return 'rental';
  if (isNegotiation(t) || isPriceOffer(t, shown)) return 'negotiation';
  if (asksPrice(t)) return 'price_question';
  if (asksHours?.(t)) return 'hours';
  if (asksIfHuman(t)) return 'human';
  if (asksOtherCity(t)) return 'other_city';
  if (asksCount(t)) return 'count';
  if (asksAvailability(t)) return 'availability';
  if (proposesVisitTime(t)) return 'visit_time';
  if (asksToCompare(t)) return 'compare';
  const topic = topicOf(t);
  if (topic) return `topic:${topic.key}`;
  return hasSearchIntent(t) ? 'search' : 'other';
}

const repeat = Number(process.argv[process.argv.indexOf('--repeat') + 1]) || 1;
const deps = {
  generate: generateText,
  model: createOpenAI({ apiKey: config.openaiApiKey })(config.openaiModel),
  providerOptions: { openai: { reasoningEffort: config.openaiReasoningEffort } }
};

const rows = [];
let next = 0;
await Promise.all(Array.from({ length: 3 }, async () => {
  while (next < cases.length) {
    const i = next++;
    const [text, truth] = cases[i];
    const started = Date.now();
    const answers = [];
    for (let n = 0; n < repeat; n++) {
      const r = await routeMessage({ text, shown, deps });
      answers.push(r ? (r.label === 'topic' ? `topic:${r.topic}` : r.label) : 'FAILED');
    }
    rows[i] = { text, truth, rules: rulesLabel(text), model: answers[0], stable: answers.every((a) => a === answers[0]), ms: Math.round((Date.now() - started) / repeat) };
  }
}));

const failed = rows.filter((r) => r.model === 'FAILED').length;
const right = (key) => rows.filter((r) => r[key] === r.truth).length;
const wrong = (key) => rows.filter((r) => r[key] !== r.truth);
console.log(`Messages: ${rows.length}\n`);
console.log(`Keyword rules : ${right('rules')} of ${rows.length} right`);
for (const r of wrong('rules')) console.log(`   ${r.truth.padEnd(18)} got ${r.rules.padEnd(18)} ${r.text}`);
const sorted = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log(`\nThe model     : ${right('model')} of ${rows.length} right${failed ? `, ${failed} with no usable answer (timeout or bad format)` : ''}   (median ${sorted[Math.floor(sorted.length / 2)]} ms)`);
for (const r of wrong('model')) console.log(`   ${r.truth.padEnd(18)} got ${r.model.padEnd(18)} ${r.text}`);
if (repeat > 1) {
  const unstable = rows.filter((r) => !r.stable);
  console.log(`\nSame label on all ${repeat} runs: ${rows.length - unstable.length} of ${rows.length}`);
  for (const r of unstable) console.log(`   UNSTABLE ${r.text}`);
}

const byLabel = {};
for (const r of rows) {
  const key = r.truth.startsWith('topic:') ? 'topic' : r.truth;
  byLabel[key] ??= { n: 0, rules: 0, model: 0 };
  byLabel[key].n++;
  if (r.rules === r.truth) byLabel[key].rules++;
  if (r.model === r.truth) byLabel[key].model++;
}
console.log('\nBy label (rules / model out of n):');
for (const [label, v] of Object.entries(byLabel)) console.log(`   ${label.padEnd(16)} ${v.rules} / ${v.model}  of ${v.n}`);
