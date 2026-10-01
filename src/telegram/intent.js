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
