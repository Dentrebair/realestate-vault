// Indian rupee amounts: parsing what people type, and showing prices the way brokers say them.

const UNIT_FACTORS = {
  inr: 1,
  rupee: 1,
  rupees: 1,
  rs: 1,
  lakh: 1e5,
  lakhs: 1e5,
  lac: 1e5,
  lacs: 1e5,
  l: 1e5,
  crore: 1e7,
  crores: 1e7,
  cr: 1e7,
  c: 1e7
};

export const POR_LABEL = 'Price on Request (POR)';

export function toInr(amount, unit = 'inr') {
  const factor = UNIT_FACTORS[String(unit).toLowerCase()];
  if (factor === undefined) {
    throw new Error(`Unknown amount unit: ${unit}`);
  }
  return Math.round(Number(amount) * factor);
}

// "₹62 L", "₹4.8 Cr", "₹75,000". Returns null for a missing price.
export function formatInr(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (n >= 1e7) return `₹${trim(n / 1e7)} Cr`;
  if (n >= 1e5) return `₹${trim(n / 1e5)} L`;
  return `₹${n.toLocaleString('en-IN')}`;
}

export function priceDisplay(value) {
  return value === null || value === undefined ? POR_LABEL : formatInr(value);
}

function trim(x) {
  return String(Math.round(x * 100) / 100);
}

// Reads one amount from text. unitKnown is false for a bare number such as "80".
export function parseAmount(text) {
  const match = String(text ?? '').match(
    /(?:₹|rs\.?\s*|inr\s*)?(\d[\d,]*(?:\.\d+)?)\s*(crores?|cr|c|lakhs?|lacs?|lac|l)?(?![a-z])/i
  );
  if (!match) return null;

  const number = Number(match[1].replace(/,/g, ''));
  const unit = match[2]?.toLowerCase();
  if (unit) return { value: toInr(number, unit), unitKnown: true };
  if (number >= 1e5) return { value: number, unitKnown: true };
  return { value: number, unitKnown: false };
}

// Numbers that describe the property, not the price: "3 BHK", "1200 sq ft", "5 km".
const NOT_MONEY = /\b\d+(?:\.\d+)?\s*\+?\s*-?\s*(?:bhk|bedrooms?|beds?|bathrooms?|baths?|sq\.?\s?ft|sqft|square feet|km|kms|floors?|storeys?|acres?|cents?|grounds?|years?|%|percent)\b/gi;

// "under 1.5C", "150L to 2 crore", "around 80 lakh", "2 crore to 1 crore".
export function parseBudgetRange(text) {
  const source = String(text ?? '').replace(NOT_MONEY, ' ');
  const found = [...source.matchAll(/(?:₹|rs\.?\s*|inr\s*)?\d[\d,]*(?:\.\d+)?\s*(?:crores?|cr|c|lakhs?|lacs?|lac|l)?(?![a-z])/gi)]
    .map((m) => ({ raw: m[0], amount: parseAmount(m[0]) }))
    .filter((m) => m.amount);
  if (!found.length) return null;

  if (found.length >= 2) {
    const [first, second] = found;
    if (!first.amount.unitKnown && second.amount.unitKnown) {
      first.amount = parseAmount(`${first.raw.trim()} ${unitOf(second.raw)}`);
    }
    const unitKnown = first.amount.unitKnown && second.amount.unitKnown;
    return {
      min: first.amount.value,
      max: second.amount.value,
      unitKnown,
      inverted: first.amount.value > second.amount.value
    };
  }

  const { value, unitKnown } = found[0].amount;
  if (/\b(around|about|approx\w*|roughly)\b/i.test(source)) {
    return { min: Math.round(value * 0.85), max: Math.round(value * 1.15), unitKnown, approximate: true };
  }
  if (/\b(above|over|at least|minimum|min)\b/i.test(source)) {
    return { min: value, unitKnown };
  }
  return { max: value, unitKnown };
}

function unitOf(raw) {
  return raw.match(/(crores?|cr|c|lakhs?|lacs?|lac|l)\s*$/i)?.[1] ?? '';
}
