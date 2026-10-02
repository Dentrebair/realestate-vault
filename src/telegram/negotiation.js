// Is this customer negotiating, and if they made an offer, for how much?
//
// The model decides, because people phrase this in endless ways ("can you do 55", "any offers running on this?",
// "54 lakh ku mudiyuma"). Code still guarantees what follows: stage rules, no agreed price, the listed price
// from the database. If the model cannot be reached, the older keyword rules decide instead.
import { parseAmount, parseBudgetRange, toInr } from '../money.js';
import { resolveArea } from '../microMarkets.js';
import { normalizeCategory } from '../propertyTypes.js';
import { isNegotiation, isPriceOffer, offeredAmount } from './intent.js';

const TIMEOUT_MS = 4000;

const instructionsFor = (shown) =>
  'You route messages for a real-estate chat assistant. These properties are on the customer\'s screen:\n' +
  shown.slice(0, 5).map((p, i) => `${i + 1}) "${p.title}" in ${p.location}, listed at ${p.priceDisplay}`).join('\n') +
  '\nDecide whether the customer\'s message means they are NEGOTIATING: trying to pay less than the listed price, asking for a discount or a better price, ' +
  'making an offer, comparing with another seller\'s price, asking whether any offers or discounts are available, or asking whether the price can change. ' +
  'It is NOT negotiating if they ask the price, accept it, set a budget for a new search, ask for cheaper properties to look at, or ask anything else. ' +
  'If they name an amount they would pay, return it as the offer, with the unit as they meant it. ' +
  'The customer may write in English, Tamil, or Tamil in English letters. ' +
  'Reply with JSON only: {"negotiating": true|false, "offer": null | {"amount": <number>, "unit": "rupees"|"lakh"|"crore"}}';

// A message that sets a budget or names a kind of property is a search, unless it also speaks like an offer.
const SEARCH_WORDS = /\b(under|below|upto|up to|within|maximum|max|budget|less than|at most|around)\b/i;
const OFFER_VOICE = /\b(can|could|will|would)\s+(i|you|we)\b|\bhow about\b|\boffer\b|\bdeal\b|\bfinal\b|\btake\b|\bdiscount\b|\bnegotiab\w*/i;

function looksLikeSearch(text) {
  return SEARCH_WORDS.test(text) || /\b\d\s*\+?\s*-?\s*(bhk|bedrooms?)\b/i.test(text) || normalizeCategory(text).length > 0 || Boolean(resolveArea(text));
}

// Messages with no number and no price-ish word cannot be a negotiation, so they never cost a model call.
const PRICE_TALK =
  /\d|₹|\b(price|prices|cost|rate|discount|offer|offers|deal|cheaper|cheap|less|lower|reduce|reduced|reduction|negotiat\w*|bargain|final|best|expensive|costly|afford\w*|budget|lakh|lakhs|lac|crore|crores|flexib\w*|adjust\w*|come down|go down|bring down|beat|match|how about|what about|can you do|will you take|vilai|vila|kammi|kurai\w*|(?:ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)(?:[- ]\w+)?)\b/i;

export function ruleVerdict(text, shown) {
  const offer = isPriceOffer(text, shown) ? offeredAmount(text) : null;
  return { negotiating: isNegotiation(text) || offer !== null, offer, source: 'rules' };
}

export async function judgeNegotiation({ text, shown = [], deps }) {
  const rules = ruleVerdict(text, shown);
  // Nothing that sounds like price talk: no need to ask the model.
  if (!rules.negotiating && !(shown.length && PRICE_TALK.test(text))) return { negotiating: false, offer: null, source: 'skipped' };
  if (!deps?.generate || !deps?.model) return rules;

  let decided;
  try {
    const result = await deps.generate({
      model: deps.model,
      providerOptions: deps.providerOptions,
      ...(deps.temperature !== undefined ? { temperature: deps.temperature } : {}),
      instructions: instructionsFor(shown.length ? shown : [{ title: 'a property', location: 'Chennai', priceDisplay: 'a listed price' }]),
      prompt: String(text).slice(0, 500),
      abortSignal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const raw = result.text ?? '';
    decided = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    if (typeof decided.negotiating !== 'boolean') throw new Error('no verdict');
  } catch {
    return rules;
  }

  let negotiating = decided.negotiating;
  // A search that merely mentions money is not an offer, whatever the model made of it.
  if (negotiating && looksLikeSearch(text) && !OFFER_VOICE.test(text)) negotiating = false;

  return { negotiating, offer: negotiating ? offerFrom(decided.offer, text, shown) : null, source: 'model' };
}

// The offer in rupees. An amount the customer typed with a unit is read by code; a unit the model had to guess
// is accepted only when it is a believable price for what is on screen.
function offerFrom(offer, text, shown) {
  if (!offer || !(offer.amount > 0)) return null;
  const typed = parseBudgetRange(text);
  if (typed?.unitKnown && !typed.inverted) return typed.approximate ? Math.round((typed.min + typed.max) / 2) : (typed.max ?? typed.min);

  let rupees;
  try {
    rupees = toInr(offer.amount, offer.unit ?? 'rupees');
  } catch {
    return null;
  }
  const listed = shown.map((p) => parseAmount(p.priceDisplay)).filter((a) => a?.unitKnown).map((a) => a.value);
  const believable = listed.some((price) => rupees >= price * 0.25 && rupees <= price * 1.5);
  return believable ? rupees : null;
}
