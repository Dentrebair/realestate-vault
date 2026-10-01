// Checks on what the model writes. Each removes the sentences that say something the context cannot support.
// The context is: the listing data it was given, what the customer said, their saved profile, and our fixed policy.
import { knownPlaceNames, normalize } from '../microMarkets.js';

export function sentencesOf(text) {
  return String(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const keep = (reply, test) => sentencesOf(reply).filter((s) => !test(s)).join(' ').trim();

const REFUSAL = /\b(can'?t|cannot|can not|unable|don'?t|do not|not able|no way)\b/i;
const HANDOFF = /\b(our|the) (sales )?team\b/i;
const VISIT = /\b(site visit|visit|viewing)\b/i;

// Offers of things this assistant cannot do: ask the seller, check with a bank, send a brochure, calculate an EMI.
const IMPOSSIBLE = new RegExp(
  [
    '\\b(ask|contact|call|phone|e-?mail|message|whatsapp|text|reach out to) (the |a |your )?(seller|owner|builder|developer|agent|broker|landlord|bank|sub-?registrar)',
    '\\b(check|confirm|verify) (this |that |it |the )?(with|availability|status|records|title|approvals?)',
    '\\b(request|ask for|get|obtain|pull) (more |further |the )?(info|information|details|documents|papers|records)',
    '\\b(send|share|forward|e-?mail) (you |me )?(the |a |an |your |these |those )?(seller|owner|builder|contact|brochures?|floor ?plans?|plans?|videos?|photos?|documents?|pdf|number|details|link)',
    '\\b(calculate|compute|estimate|work out|figure out) (the |your |that |this |it |an? )?(emi|loan|price|per sq|rate|stamp|registration|tax|returns?|yield|average|that|this|it)\\b',
    '\\bconnect you (with|to) (the )?(seller|owner|builder|developer|bank)',
    '\\bput you in touch\\b',
    '\\bget back to you\\b',
    '\\bfind out (from|for|if|whether)\\b',
    '\\bcheck nearby (schools?|hospitals?|amenities|facilities|metro|stations?)'
  ].join('|'),
  'i'
);

export function withoutImpossibleOffers(reply) {
  return keep(reply, (s) => IMPOSSIBLE.test(s) && !REFUSAL.test(s) && !HANDOFF.test(s));
}

// General knowledge about areas, markets and futures. We have none, so a sentence that sounds like it is removed.
const KNOWLEDGE = new RegExp(
  [
    'typically', 'generally', 'usually', 'commonly', 'known for', 'popular (for|with|among)', 'well[- ]connected',
    'good for (professionals|families|investors|students|working|young)', 'great for', 'booming', 'up-and-coming', 'upcoming',
    'appreciat\\w+', 'infrastructure', 'traffic', 'safe (area|neighbou?rhood|locality)', 'posh', 'sought[- ]after',
    'high demand', 'rising (prices?|values?|demand)', 'growing (area|demand|market)', 'developing (area|locality)',
    '(IT|tech) (hub|corridor|belt)', 'quiet(er)? (suburbs?|areas?|neighbou?rhoods?)', 'established (neighbou?rhoods?|areas?)',
    'commute'
  ].map((p) => `\\b${p}\\b`).join('|'),
  'i'
);

export function withoutKnowledgeClaims(reply) {
  return keep(reply, (s) => KNOWLEDGE.test(s) && !REFUSAL.test(s));
}

// A place name in the reply that the data never gave it and the customer never said.
let placePatterns;
function placeNames() {
  placePatterns ??= knownPlaceNames().map((name) => ({ name, re: new RegExp(`(^| )${name}( |$)`) }));
  return placePatterns;
}

export function placesIn(text) {
  const n = normalize(text);
  return placeNames().filter(({ re }) => re.test(n)).map(({ name }) => name);
}

export function withoutUnlistedPlaces(reply, allowedText) {
  const allowed = normalize(allowedText);
  return keep(reply, (s) => placesIn(s).some((name) => !allowed.includes(name)));
}

// One pass over a model reply with every check above. `allowedText` is everything the reply may draw on.
export function truthful(reply, allowedText) {
  return withoutUnlistedPlaces(withoutKnowledgeClaims(withoutImpossibleOffers(reply)), allowedText);
}
