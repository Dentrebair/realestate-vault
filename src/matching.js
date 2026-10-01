// Match and recommend.
//
// A Match satisfies everything the Lead asked for. When there is none, we recommend the
// closest options and say exactly how each one differs. Ranking is location first:
// same area, then near, then far, and only then fewest other gaps.
import { formatInr } from './money.js';
import { areaDistance, locateProperty, resolveArea, textDistance } from './microMarkets.js';
import {
  categoriesFromSubtypes,
  categoryLabel,
  detectSubtypes,
  normalizeCategory,
  relatedCategory,
  subtypeLabel
} from './propertyTypes.js';
import { toPropertyView } from './propertyView.js';

const SHOWABLE = new Set(['available', 'under_construction']);
const MAX_RECOMMENDATIONS = 3;
const MAX_BEDROOM_GAP = 2;
const MAX_OVER_BUDGET_PCT = 100;
const MAX_UNDER_BUDGET_PCT = 50;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'near', 'need', 'want', 'looking', 'show', 'some', 'any', 'under',
  'above', 'below', 'around', 'about', 'property', 'properties', 'chennai', 'good', 'nice'
]);

// "near the city", "anywhere in Chennai": nothing to filter on.
const VAGUE_FILLER = new Set(['near', 'nearby', 'around', 'in', 'the', 'not', 'far', 'from', 'of', 'within', 'any', 'anywhere', 'somewhere', 'a', 'to', 'close', 'city', 'chennai', 'town', 'centre', 'center', 'central', 'main', 'side']);

function isVagueArea(text) {
  const words = String(text ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return words.length > 0 && words.every((w) => VAGUE_FILLER.has(w));
}

// "3 BHK", "3bhk", "3 bedroom" and "3+ bhk" typed into the free-text field still count as a requirement.
export function bedroomsFromText(text) {
  const m = String(text ?? '').match(/(\d+)\s*(\+)?\s*-?\s*(bhk|bedrooms?|bed)\b/i);
  if (!m) return { exact: null, atLeast: null };
  const n = Number(m[1]);
  return m[2] ? { exact: null, atLeast: n } : { exact: n, atLeast: null };
}

function fromTextAny(filters) {
  const t = bedroomsFromText(`${filters.query ?? ''} ${filters.category ?? ''}`);
  return t.exact || t.atLeast;
}

export function buildCriteria(filters = {}) {
  const subtypes = new Set([
    ...detectSubtypes(filters.category),
    ...detectSubtypes(filters.query)
  ]);

  let categories = normalizeCategory(filters.category);
  if (!categories.length) categories = categoriesFromSubtypes(subtypes);
  if (!categories.length && (filters.bedrooms || filters.minBedrooms || fromTextAny(filters))) categories = ['residential'];

  const notes = [...(filters.dealBreakers ?? []), ...(filters.mustHaves ?? [])].join(' ').toLowerCase();
  const readyOnly =
    filters.readyToMove === true ||
    /ready to move|under.?construction/.test(notes) ||
    /ready to move/.test(String(filters.status ?? '').toLowerCase());

  const areaText = isVagueArea(filters.location) ? null : filters.location?.trim() || null;
  const fromText = bedroomsFromText(`${filters.query ?? ''} ${filters.category ?? ''}`);
  const bedrooms = filters.bedrooms ?? (filters.minBedrooms ? null : fromText.exact);
  const minBedrooms = filters.minBedrooms ?? (filters.bedrooms ? null : fromText.atLeast);

  return {
    area: areaText ? { text: areaText, entry: resolveArea(areaText) } : null,
    categories,
    subtypes,
    bedrooms: bedrooms ?? null,
    minBedrooms: minBedrooms ?? null,
    bathrooms: filters.bathrooms ?? null,
    minBudget: filters.minBudget ?? null,
    maxBudget: filters.maxBudget ?? null,
    readyOnly,
    words: tokens(filters.query)
  };
}

export function findMatches(rows, filters = {}) {
  const criteria = buildCriteria(filters);

  const showable = [];
  const unavailableRows = [];
  for (const row of rows) (SHOWABLE.has(row.status) ? showable : unavailableRows).push(row);

  const heldBack = criteria.readyOnly ? showable.filter((r) => r.status === 'under_construction') : [];
  const pool = criteria.readyOnly ? showable.filter((r) => r.status !== 'under_construction') : showable;
  const annotated = pool.map((row) => annotate(row, criteria));

  const matches = annotated
    .filter(isMatch)
    .sort((a, b) => b.hits - a.hits || compareKnownPrice(a, b));

  const recommendations = matches.length ? [] : recommend(annotated);
  const inArea = annotated.filter((a) => a.tier === 0 && a.categoryGap < 2);
  const overBudget = matches.length
    ? []
    : inArea
        .filter((a) => a.overPct > MAX_OVER_BUDGET_PCT)
        .sort(compareKnownPrice)
        .slice(0, 2);

  const result = {
    criteria: describeCriteria(criteria),
    matches: matches.map((a) => view(a, 'match', criteria)),
    recommendations: recommendations.map((a) => view(a, 'recommendation', criteria)),
    unavailable: unavailableNotes(unavailableRows, criteria),
    droppedOverBudget: overBudget.map((a) => ({
      id: a.row.property_id,
      title: a.row.title,
      location: a.row.location,
      priceDisplay: formatInr(a.price)
    })),
    excludedByDealBreaker: heldBack
      .map((row) => annotate(row, criteria))
      .filter((a) => a.tier === 0 && a.categoryGap === 0)
      .map((a) => ({ id: a.row.property_id, title: a.row.title, location: a.row.location })),
    nearestElsewhere: null,
    suggestions: { areasThatFit: [], cheapestInArea: null }
  };

  if (matches.length) {
    result.outcome = 'matches';
  } else if (recommendations.length) {
    result.outcome = 'recommendations';
  } else {
    result.outcome = overBudget.length ? 'nothing_in_budget' : inArea.length ? 'nothing_fits' : 'nothing_in_area';
    result.nearestElsewhere = nearestElsewhere(annotated);
  }

  if (!matches.length) result.suggestions = suggestionsFrom(annotated, inArea, criteria);

  result.guidance = guidanceFor(result);
  return result;
}

// ---- per-property checks ------------------------------------------------------------------

function annotate(row, c) {
  const meta = row.metadata ?? {};
  const price = row.price_inr === null || row.price_inr === undefined ? null : Number(row.price_inr);
  const beds = numberOrNull(meta.bedrooms);
  const baths = numberOrNull(meta.bathrooms);

  let tier = 0;
  let km = 0;
  if (c.area) {
    ({ tier, km } = c.area.entry
      ? areaDistance(c.area.entry, locateProperty(row.location ?? ''))
      : textDistance(c.area.text, row.location ?? ''));
  }

  let categoryGap = 0;
  if (c.categories.length && !c.categories.includes(row.category)) {
    categoryGap = c.categories.some((cat) => relatedCategory(cat, row.category)) ? 1 : 2;
  }

  const ownSubtypes = detectSubtypes(row.title);
  const subtypeGap =
    c.subtypes.size > 0 && ownSubtypes.size > 0 && ![...c.subtypes].some((s) => ownSubtypes.has(s));

  const hasBudget = c.maxBudget !== null || c.minBudget !== null;
  let overPct = 0;
  let underPct = 0;
  if (price !== null) {
    if (c.maxBudget !== null && price > c.maxBudget) overPct = ((price - c.maxBudget) / c.maxBudget) * 100;
    if (c.minBudget !== null && price < c.minBudget) underPct = ((c.minBudget - price) / c.minBudget) * 100;
  }
  const porWithBudget = hasBudget && price === null;

  let bedDiff = null;
  let bedUnknown = false;
  if (c.bedrooms !== null || c.minBedrooms !== null) {
    if (beds === null) bedUnknown = row.category === 'residential';
    else bedDiff = c.bedrooms !== null ? beds - c.bedrooms : Math.min(0, beds - c.minBedrooms);
  }
  const bathShort = c.bathrooms !== null && baths !== null && baths < c.bathrooms;

  const text = `${row.title ?? ''} ${row.raw_listing_text ?? ''}`.toLowerCase();
  const hits = c.words.filter((w) => text.includes(w)).length;

  const penalty =
    categoryGap * 30 +
    (subtypeGap ? 20 : 0) +
    Math.min(overPct, 100) * 0.5 +
    Math.min(underPct, 50) * 0.3 +
    (bedDiff ? Math.abs(bedDiff) * 15 : 0) +
    (bedUnknown ? 20 : 0) +
    (porWithBudget ? 5 : 0) +
    (bathShort ? 5 : 0) +
    (row.status === 'under_construction' ? 3 : 0);

  return {
    row, price, beds, tier, km, categoryGap, subtypeGap, overPct, underPct, porWithBudget,
    bedDiff, bedUnknown, bathShort, hits, penalty, ownSubtypes
  };
}

function fitsExceptArea(a) {
  return (
    a.categoryGap === 0 &&
    !a.subtypeGap &&
    a.overPct === 0 &&
    a.underPct === 0 &&
    !a.porWithBudget &&
    !a.bathShort &&
    !a.bedUnknown &&
    (a.bedDiff === null || a.bedDiff === 0)
  );
}

const isMatch = (a) => a.tier === 0 && fitsExceptArea(a);

// A far option is only worth showing if location is its one shortcoming and we know how far it is.
const onlyAreaDiffers = (a) => a.tier === 2 && a.km !== null && fitsExceptArea(a);

function isDropped(a) {
  return (
    a.categoryGap === 2 ||
    a.overPct > MAX_OVER_BUDGET_PCT ||
    a.underPct > MAX_UNDER_BUDGET_PCT ||
    (a.bedDiff !== null && Math.abs(a.bedDiff) > MAX_BEDROOM_GAP) ||
    // A different type of property, or unknown bedrooms, is only worth offering in the requested area.
    (a.tier > 0 && (a.subtypeGap || a.bedUnknown))
  );
}

// Near options first, closest area first. Far options only when nothing is near, and only the
// single nearest one, because it must fit everything except the location.
function recommend(annotated) {
  const eligible = annotated.filter((a) => !isMatch(a) && !isDropped(a));

  const near = eligible
    .filter((a) => a.tier < 2)
    .sort((a, b) => a.tier - b.tier || a.penalty - b.penalty || compareKnownPrice(a, b))
    .slice(0, MAX_RECOMMENDATIONS);
  if (near.length) return near;

  return eligible
    .filter(onlyAreaDiffers)
    .sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity) || a.penalty - b.penalty)
    .slice(0, 1);
}

function compareKnownPrice(a, b) {
  return (a.price ?? Infinity) - (b.price ?? Infinity);
}

// ---- how each result is described ---------------------------------------------------------

function differencesOf(a, c) {
  const out = [];
  const areaName = c.area?.entry?.name ?? c.area?.text;

  if (c.area && a.tier === 1) out.push(`about ${a.km} km from ${areaName}`);
  if (c.area && a.tier === 2) {
    out.push(a.km === null ? `outside ${areaName}` : `about ${a.km} km away from ${areaName}`);
  }
  if (a.categoryGap === 1) {
    out.push(`${categoryLabel(a.row.category)}, not ${c.categories.map(categoryLabel).join(' or ')}`);
  }
  if (a.subtypeGap) {
    const own = [...a.ownSubtypes].map(subtypeLabel).join(' or ');
    const wanted = [...c.subtypes].map(subtypeLabel).join(' or ');
    out.push(`${own} instead of ${wanted}`);
  }
  if (a.overPct > 0) out.push(`${formatInr(a.price - c.maxBudget)} over your budget`);
  if (a.underPct > 0) out.push('below your budget range');
  if (a.porWithBudget) out.push("Price on Request, so your budget can't be confirmed");
  if (a.bedDiff) out.push(bedroomText(a, c));
  if (a.bedUnknown) out.push('bedrooms not listed');
  if (a.bathShort) out.push('fewer bathrooms than you asked for');
  if (a.row.status === 'under_construction') out.push('under construction');
  return out;
}

function bedroomText(a, c) {
  const wanted = c.bedrooms ?? c.minBedrooms;
  const n = Math.abs(a.bedDiff);
  return `${n} bedroom${n > 1 ? 's' : ''} ${a.bedDiff < 0 ? 'fewer' : 'more'} (${a.beds} instead of ${wanted})`;
}

function view(a, kind, c) {
  return toPropertyView(a.row, {
    kind,
    differences: kind === 'recommendation' ? differencesOf(a, c) : [],
    distanceKm: c.area && a.tier > 0 ? a.km : null
  });
}

// Sold or reserved properties that would have been a good answer, so the bot can say so.
function unavailableNotes(rows, c) {
  return rows
    .map((row) => annotate(row, c))
    .filter((a) => {
      if (a.tier !== 0 || a.categoryGap !== 0 || a.subtypeGap) return false;
      return a.hits > 0 || a.overPct <= 50;
    })
    .map((a) => ({
      id: a.row.property_id,
      title: a.row.title,
      location: a.row.location,
      status: a.row.status
    }));
}

// Where else the Lead could look, using only what is in stock: areas that have a property fitting everything
// except the location, nearest first, and the cheapest property in the requested area.
function suggestionsFrom(annotated, inArea, c) {
  const byArea = new Map();
  for (const a of annotated) {
    if (a.tier === 0 || !fitsExceptArea(a)) continue;
    const place = locateProperty(a.row.location ?? '');
    const name = place.locality?.name ?? String(a.row.location ?? '').split(',')[0].trim();
    if (!name) continue;
    const entry = byArea.get(name) ?? { name, count: 0, km: a.km };
    entry.count += 1;
    if (a.km !== null && (entry.km === null || a.km < entry.km)) entry.km = a.km;
    byArea.set(name, entry);
  }
  const areasThatFit = [...byArea.values()].sort((x, y) => (x.km ?? Infinity) - (y.km ?? Infinity)).slice(0, 3);

  const priced = inArea.filter((a) => a.price !== null && a.categoryGap < 2 && !a.subtypeGap).sort(compareKnownPrice)[0];
  const cheapestInArea = priced
    ? { title: priced.row.title, location: priced.row.location, priceDisplay: formatInr(priced.price) }
    : null;
  return { areasThatFit, cheapestInArea };
}

function nearestElsewhere(annotated) {
  const far = annotated
    .filter((a) => a.tier === 2 && a.km !== null && !isDropped(a))
    .sort((a, b) => a.km - b.km)[0];
  if (!far) return null;
  return {
    id: far.row.property_id,
    title: far.row.title,
    location: far.row.location,
    distanceKm: far.km,
    priceDisplay: formatInr(far.price) ?? 'Price on Request (POR)',
    fitsRequirements: fitsExceptArea(far)
  };
}

function describeCriteria(c) {
  const parts = [];
  if (c.bedrooms) parts.push(`${c.bedrooms} bedroom`);
  else if (c.minBedrooms) parts.push(`${c.minBedrooms}+ bedroom`);
  if (c.subtypes.size) parts.push([...c.subtypes].map(subtypeLabel).join(' or '));
  else if (c.categories.length) parts.push(c.categories.map(categoryLabel).join(' or '));
  else parts.push('property');
  if (c.area) parts.push(`in ${c.area.entry?.name ?? c.area.text}`);
  if (c.minBudget !== null && c.maxBudget !== null) {
    parts.push(`between ${formatInr(c.minBudget)} and ${formatInr(c.maxBudget)}`);
  } else if (c.maxBudget !== null) parts.push(`up to ${formatInr(c.maxBudget)}`);
  else if (c.minBudget !== null) parts.push(`from ${formatInr(c.minBudget)}`);

  return {
    summary: parts.join(' '),
    area: c.area ? (c.area.entry?.name ?? c.area.text) : null,
    areaRecognised: c.area ? Boolean(c.area.entry) : null,
    categories: c.categories,
    subtypes: [...c.subtypes],
    bedrooms: c.bedrooms,
    minBedrooms: c.minBedrooms,
    minBudget: c.minBudget,
    maxBudget: c.maxBudget,
    readyOnly: c.readyOnly
  };
}

function guidanceFor(result) {
  const { summary, area } = result.criteria;
  const where = area ?? 'the requested area';
  const notes = [];

  if (result.unavailable.length) {
    const list = result.unavailable.map((u) => `"${u.title}" (${u.status})`).join(', ');
    notes.push(`Tell the Lead that ${list} is not available.`);
  }
  if (result.excludedByDealBreaker.length) {
    notes.push(
      `${result.excludedByDealBreaker.length} under-construction property in ${where} was left out because of the Lead's deal-breaker. You may mention that once.`
    );
  }

  switch (result.outcome) {
    case 'matches':
      notes.unshift('These properties match. Cards show the details; do not repeat prices in text.');
      break;
    case 'recommendations':
      notes.unshift(
        `No exact match for ${summary}. Present these as close options, not matches, and say briefly how each differs.`
      );
      if (result.droppedOverBudget.length) {
        const list = result.droppedOverBudget.map((p) => `${p.title} at ${p.priceDisplay}`).join('; ');
        notes.push(`Also in ${where}, but far above budget: ${list}.`);
      }
      break;
    case 'nothing_in_area':
      notes.unshift(
        `Nothing in or near ${where} fits ${summary}. Do not show properties from other areas. Ask whether to widen the area or change the budget.`
      );
      break;
    case 'nothing_in_budget': {
      const list = result.droppedOverBudget.map((p) => `${p.title} at ${p.priceDisplay}`).join('; ');
      notes.unshift(
        `There are properties in ${where} but all are far above the budget (${list}). Ask whether the budget can change.`
      );
      break;
    }
    default:
      notes.unshift(`Nothing fits ${summary}. Ask which requirement can change.`);
  }

  if (result.criteria.areaRecognised === false && result.outcome === 'nothing_in_area') {
    notes.push(`"${area}" is not an area we recognise. Ask which part of Chennai they mean.`);
  }

  if (result.nearestElsewhere && result.outcome !== 'matches' && result.outcome !== 'recommendations') {
    const n = result.nearestElsewhere;
    notes.push(
      `For reference only (no card): the closest elsewhere is ${n.title}, about ${n.distanceKm} km away, at ${n.priceDisplay}.`
    );
  }
  return notes.join(' ');
}

function tokens(query) {
  return String(query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .slice(0, 8);
}

function numberOrNull(value) {
  const n = Number(value);
  return value === null || value === undefined || Number.isNaN(n) ? null : n;
}
