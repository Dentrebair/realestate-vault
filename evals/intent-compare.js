// Who decides "is this customer negotiating?": hand-written rules, or the model? Both are run on the same messages.
// A property (High-Rise 2BHK Apartment near Tech Parks, listed at ₹62 L) has just been shown in every case.
import 'dotenv/config';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { config } from '../src/config.js';
import { isNegotiation, isPriceOffer } from '../src/telegram/intent.js';

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

const model = createOpenAI({ apiKey: config.openaiApiKey })(config.openaiModel);
const property = shown[0];

async function askModel(message) {
  const started = Date.now();
  const { text } = await generateText({
    model,
    providerOptions: { openai: { reasoningEffort: 'minimal' } },
    instructions:
      'You route messages for a real-estate chat assistant. A property was just shown to the customer: ' +
      `"${property.title}" in ${property.location}, listed at ${property.priceDisplay}.\n` +
      'Decide whether the customer\'s message means they are NEGOTIATING: trying to pay less than the listed price, asking for a discount or a better price, ' +
      'making an offer, comparing with another seller\'s price, or asking whether the price can change. ' +
      'It is NOT negotiating if they ask the price, accept it, set a budget for a new search, ask for cheaper properties to look at, or ask anything else. ' +
      'The customer may write in English, Tamil, or Tamil in English letters. Reply with JSON only: {"negotiating": true|false}',
    prompt: message
  });
  let value = false;
  try { value = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).negotiating === true; } catch { /* counts as a miss */ }
  return { value, ms: Date.now() - started };
}

const rows = [];
let next = 0;
await Promise.all(Array.from({ length: 5 }, async () => {
  while (next < cases.length) {
    const i = next++;
    const [message, truth] = cases[i];
    const rules = isNegotiation(message) || isPriceOffer(message, shown);
    const llm = await askModel(message).catch(() => ({ value: null, ms: 0 }));
    rows[i] = { message, truth, rules, llm: llm.value, ms: llm.ms };
  }
}));

const score = (key) => rows.filter((r) => r[key] === r.truth).length;
const wrong = (key) => rows.filter((r) => r[key] !== r.truth);
console.log(`Messages: ${rows.length} (${rows.filter((r) => r.truth).length} should move to negotiating)\n`);
console.log(`Hand-written rules : ${score('rules')} of ${rows.length} right`);
for (const r of wrong('rules')) console.log(`   ${r.truth ? 'MISSED  ' : 'FALSE+  '} ${r.message}`);
console.log(`\nThe model deciding : ${score('llm')} of ${rows.length} right   (median ${[...rows.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(rows.length / 2)]} ms each)`);
for (const r of wrong('llm')) console.log(`   ${r.truth ? 'MISSED  ' : 'FALSE+  '} ${r.message}`);
const both = rows.filter((r) => (r.rules || r.llm) === r.truth).length;
console.log(`\nEither one says yes : ${both} of ${rows.length} right`);
