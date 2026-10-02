// Is the negotiation judge right? Runs the real judge (src/telegram/negotiation.js) and the old keyword rules on the
// same labelled messages, with the real model.
//
//   npm run eval:negotiation              one pass
//   npm run eval:negotiation -- --repeat 3   also checks the model gives the same answer each time
//
// Fails (exit 1) if the judge scores under 38 of 40 or gets any of the CLEAR messages wrong.
// When a real customer message is misjudged, add it to the list below.
// A property (High-Rise 2BHK Apartment near Tech Parks, listed at ₹62 L) has just been shown in every case.
import 'dotenv/config';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { config } from '../src/config.js';
import { judgeNegotiation, ruleVerdict } from '../src/telegram/negotiation.js';

const shown = [{ id: 'p04', title: 'High-Rise 2BHK Apartment near Tech Parks', location: 'Navalur, OMR, Chennai', priceDisplay: '₹62 L' }];

// [message, should the lead move to negotiating?]
const cases = [
  ['can i get for 54L', true], ['will you take 55 lakh', true], ['how about 58L', true], ['is 60 lakh ok for it', true],
  ['can you do 55', true], ['Can I get a 10% discount?', true], ['is the price negotiable?', true], ['what is your last price', true],
  ['54L final?', true], ['bhai 54 lakh ku tharuvingala', true], ['54 lakh ku mudiyuma', true], ['can the price come down a bit', true],
  ['the other builder is giving at 58L, can you match', true], ['that is too expensive, anything you can do?', true],
  ["I can pay 55L cash today, deal?", true], ["reduce it to 55 and I'll book a visit", true], ['would the owner accept 56?', true],
  ["I'll take it if you bring it to 58L", true], ['any offers running on this?', true], ['can I get it cheaper if I pay full cash', true],

  ['price of High-Rise 2BHK near omr?', false], ['what is the price', false], ['show me homes under 54L', false], ['budget 54L in OMR', false],
  ['3BHK in OMR for 54L', false], ['what is the maintenance', false], ['under 54L', false], ['is it available', false],
  ['can i visit tomorrow', false], ['too far from my office, show others', false], ['tell me about the second one', false],
  ['I need to think about it', false], ['thanks', false], ['can you show cheaper options', false], ['do you have anything around 55 lakh in OMR', false],
  ["what's the registration cost", false], ['is there parking', false], ["62L is fine for me, I'd like to visit", false],
  ['sounds expensive, show me something cheaper', false], ['how much is the rent in that area', false]
];

const CLEAR = new Set(['can i get for 54L', 'will you take 55 lakh', 'how about 58L', 'what is your last price', 'is the price negotiable?',
  'price of High-Rise 2BHK near omr?', 'show me homes under 54L', 'under 54L', 'thanks', 'is it available']);
const THRESHOLD = 38;
const repeat = Number(process.argv[process.argv.indexOf('--repeat') + 1]) || 1;

const deps = {
  generate: generateText,
  model: createOpenAI({ apiKey: config.openaiApiKey })(config.openaiModel),
  providerOptions: { openai: { reasoningEffort: config.openaiReasoningEffort } }
};

const rows = [];
let next = 0;
await Promise.all(Array.from({ length: 5 }, async () => {
  while (next < cases.length) {
    const i = next++;
    const [message, truth] = cases[i];
    const rules = ruleVerdict(message, shown).negotiating;
    const answers = [];
    for (let n = 0; n < repeat; n++) answers.push((await judgeNegotiation({ text: message, shown, deps })));
    const first = answers[0];
    rows[i] = { message, truth, rules, judge: first.negotiating, source: first.source, stable: answers.every((a) => a.negotiating === first.negotiating) };
  }
}));

const score = (key) => rows.filter((r) => r[key] === r.truth).length;
const wrong = (key) => rows.filter((r) => r[key] !== r.truth);
console.log(`Messages: ${rows.length} (${rows.filter((r) => r.truth).length} should move to negotiating)\n`);
console.log(`Keyword rules only : ${score('rules')} of ${rows.length} right`);
for (const r of wrong('rules')) console.log(`   ${r.truth ? 'MISSED  ' : 'FALSE+  '} ${r.message}`);
console.log(`\nThe real judge     : ${score('judge')} of ${rows.length} right`);
for (const r of wrong('judge')) console.log(`   ${r.truth ? 'MISSED  ' : 'FALSE+  '} ${r.message}  [${r.source}]`);
const fellBack = rows.filter((r) => r.source === 'rules');
if (fellBack.length) console.log(`\n${fellBack.length} messages fell back to the rules (the model call failed)`);
const unstable = rows.filter((r) => !r.stable);
if (repeat > 1) console.log(`\nSame answer on all ${repeat} runs: ${rows.length - unstable.length} of ${rows.length}`);
for (const r of unstable) console.log(`   UNSTABLE ${r.message}`);

const clearWrong = wrong('judge').filter((r) => CLEAR.has(r.message));
const failed = score('judge') < THRESHOLD || clearWrong.length > 0 || unstable.some((r) => CLEAR.has(r.message));
console.log(failed ? `\nFAIL: needs at least ${THRESHOLD} right and every clear message right` : `\nPASS`);
process.exit(failed ? 1 : 0);
