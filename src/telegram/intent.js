import { resolveArea } from '../microMarkets.js';
import { parseBudgetRange } from '../money.js';
import { normalizeCategory } from '../propertyTypes.js';

// Things in a customer's message that are clear enough for code to act on, without asking the model.

// Asking for a lower price is negotiation. "cheaper" on its own is a search, so it is not in this list.
const NEGOTIATION =
  /\b(discounts?|negotiat\w*|negotiab\w*|bargain\w*|haggl\w*|best price|final price|lowest price|reduce(?:d)? (?:the )?(?:price|rate|cost)|lower (?:the )?(?:price|rate|cost)|(?:come|go|bring|get) (?:it |the price |this )?down|can you match|match (?:the |that |their |this )?(?:price|offer)|\d{1,2}\s?% (?:off|discount|less|reduction|lower))\b/i;

export function isNegotiation(text) {
  return NEGOTIATION.test(String(text ?? ''));
}

// Asking about photos is answered from the real data by code. The model is never asked to guess what exists.
const PHOTOS = /\b(photos?|images?|pictures?|pics?|gallery|galleries)\b/i;

export function asksAboutPhotos(text) {
  return PHOTOS.test(String(text ?? ''));
}

// "can i get for 54L", "will you take 55 lakh", "how about 58L for it": an offer on a property already in play.
// Not a search: it names no kind of property, no area and no size, and the amount has a unit.
const OFFER_PHRASE =
  /\b(can|could|will|would)\s+(i|you|we)\b|\bhow about\b|\bwhat about\b|\boffer(ing)?\b|\b(for|at)\s+(rs\.?\s*|₹\s*)?\d|\bfinal\b|\blast price\b|\btake\b|\bdeal\b|\bpay\b|\bsettle\b/i;

export function isPriceOffer(text, shown = []) {
  if (!shown.length) return false;
  const t = String(text ?? '');
  const money = parseBudgetRange(t);
  if (!money || !money.unitKnown || money.inverted) return false;
  if (normalizeCategory(t).length || resolveArea(t) || /\b\d\s*\+?\s*-?\s*(bhk|bedrooms?)\b/i.test(t)) return false;
  if (/\b(under|below|upto|up to|within|maximum|max|budget|less than|at most|around)\b/i.test(t)) return false;
  return OFFER_PHRASE.test(t) || t.trim().split(/\s+/).length <= 5;
}

// The amount offered, in rupees.
export function offeredAmount(text) {
  const money = parseBudgetRange(String(text ?? ''));
  if (!money) return null;
  // "how about 58L" reads as "about 58L", a 15% band around it. The offer is the middle of the band.
  if (money.approximate) return Math.round((money.min + money.max) / 2);
  return money.max ?? money.min ?? null;
}
