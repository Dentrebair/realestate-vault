// A second model that checks a reply against what the assistant was actually given.
// Used by the audit and by `npm run eval -- --judge`. It is a model too, so it is noisy: read what it flags.
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { config } from '../src/config.js';
import { properties } from '../test/fixtures/properties.js';

const judgeModel = () => createOpenAI({ apiKey: config.openaiApiKey })('gpt-5-mini');

const CAPABILITIES =
  'The assistant CAN: show property cards from search results; answer from the listing details it was given; keep a shortlist; ' +
  'send a Confirm site visit button (the sales team then confirms a time); say pricing, discounts, loans and legal or tax questions are for the sales team ' +
  'or a professional; say plainly that it does not know. ' +
  'The assistant CANNOT: send brochures, floor plans or videos; call, email or message anyone; contact sellers or builders; check availability with a seller; ' +
  'calculate EMIs or give financial advice; give area guides, neighbourhood descriptions, market data or price forecasts; filter by facts the listings do not carry; ' +
  'promise anything about price or timing.';

// Everything the assistant's code can see besides what the model was handed: the listings, and our fixed policy.
export function contextFacts() {
  const listings = properties.map((p) => ({ id: p.property_id, title: p.title, category: p.category, location: p.location, status: p.status, price_inr: p.price_inr, metadata: p.metadata }));
  return (
    `LISTING DATA (the full inventory):\n${JSON.stringify(listings)}\n` +
    `FIXED POLICY: we only sell property in Chennai; pricing, discounts, loans and legal questions are for the sales team or a professional; ` +
    `site visits are requested with a button and the team confirms a time (${config.businessHours}); photos appear on a card with arrow buttons when a listing has them.`
  );
}

// type: fact (a detail about a property or price not in FACTS), knowledge (general world knowledge about an area, market or law),
//       ability (offers or claims something outside the CAN list), inventory (a claim about how much stock exists that FACTS do not support)
export async function judgeReply({ question, reply, facts }) {
  const { text } = await generateText({
    model: judgeModel(),
    providerOptions: { openai: { reasoningEffort: 'low' } },
    instructions:
      'You audit a real-estate chat assistant for made-up statements. You get FACTS (everything the assistant was told), the customer MESSAGES, and the assistant REPLY.\n' +
      `${CAPABILITIES}\n` +
      'List every statement in the REPLY that is not supported by FACTS or the customer MESSAGES, with a type: fact, knowledge, ability or inventory.\n' +
      'Do NOT list: polite filler; questions the assistant asks; honest "I do not know" or "I cannot" statements that match the CANNOT list; handing pricing, loans or legal questions to the sales team; ' +
      'offering a site visit; describing the cards it just sent; repeating what the customer said.\n' +
      'Answer with JSON only: {"verdict":"grounded"|"ungrounded","unsupported":[{"type":"fact|knowledge|ability|inventory","claim":"short quote"}]}',
    prompt: `FACTS:\n${facts.slice(0, 9000)}\n\nCUSTOMER MESSAGES:\n${question}\n\nREPLY:\n${reply}`
  });
  try {
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    return { verdict: parsed.verdict, unsupported: parsed.unsupported ?? [] };
  } catch {
    return { verdict: 'unknown', unsupported: [{ type: 'fact', claim: text.slice(0, 120) }] };
  }
}

// The keyword check from the suggestion under test: if nothing was found, any money or property word means "hallucinated".
export function naiveValidate(responseText, hasNoResults) {
  if (!hasNoResults) return true;
  const keywords = ['₹', 'crore', 'lakhs', 'bhk', 'sq.ft'];
  return !keywords.some((k) => responseText.toLowerCase().includes(k));
}
