import assert from 'node:assert/strict';
import test from 'node:test';
import { bedroomsFromText, findMatches } from '../src/matching.js';
import { searchProperties } from '../src/propertySearch.js';
import { Cr, L, properties } from './fixtures/properties.js';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

const ids = (list) => list.map((p) => p.id);

// Each case is a test lead from test/fixtures/testLeads.js, turned into search arguments.
// `matches` and `recs` are the expected property ids, in order. `absent` must appear in neither.
const cases = [
  {
    lead: '011 3BHK in OMR under 1.5 Cr',
    filters: { location: 'OMR', category: 'residential', bedrooms: 3, maxBudget: Cr(1.5) },
    outcome: 'recommendations',
    recs: ['p04'],
    absent: ['p03', 'p06', 'p19'],
    differences: { p04: ['1 bedroom fewer (2 instead of 3)', 'under construction'] }
  },
  {
    lead: '012 3BHK in Anna Nagar within 3 Cr',
    filters: { location: 'Anna Nagar', category: 'residential', bedrooms: 3, maxBudget: Cr(3) },
    outcome: 'recommendations',
    recs: ['p03'],
    differences: { p03: ['₹1.8 Cr over your budget', '1 bedroom more (4 instead of 3)'] }
  },
  {
    lead: '013 2BHK in Tambaram under 25 lakh',
    filters: { location: 'Tambaram', category: 'residential', bedrooms: 2, maxBudget: L(25) },
    outcome: 'recommendations',
    recs: ['p16'],
    differences: { p16: ['₹3 L over your budget', '1 bedroom fewer (1 instead of 2)'] }
  },
  {
    lead: '014 residential flats in Triplicane under 2 Cr (PRD test)',
    filters: { location: 'Triplicane', category: 'residential', maxBudget: Cr(2) },
    outcome: 'recommendations',
    recs: ['p05'],
    absent: ['p19', 'p01'],
    differences: { p05: ["Price on Request, so your budget can't be confirmed"] }
  },
  {
    lead: '016 penthouse in Besant Nagar, 4BHK, up to 7 Cr (sold)',
    filters: { location: 'Besant Nagar', category: 'residential', query: 'penthouse', bedrooms: 4, maxBudget: Cr(7) },
    outcome: 'recommendations',
    recs: ['p03'],
    absent: ['p19'],
    unavailable: ['p19']
  },
  {
    lead: '017 4BHK in Anna Nagar, 3.5 Cr max',
    filters: { location: 'Anna Nagar', category: 'residential', bedrooms: 4, maxBudget: Cr(3.5) },
    outcome: 'recommendations',
    recs: ['p03'],
    differences: { p03: ['₹1.3 Cr over your budget'] }
  },
  {
    lead: '018 retail shop in T Nagar under 5 Cr (showroom reserved)',
    filters: { location: 'T Nagar', category: 'commercial', query: 'retail shop', maxBudget: Cr(5) },
    outcome: 'recommendations',
    recs: ['p09'],
    absent: ['p12'],
    unavailable: ['p12']
  },
  {
    lead: '019 beach resort in Mamallapuram under 50 Cr',
    filters: { location: 'Mamallapuram', category: 'hospitality', maxBudget: Cr(50) },
    outcome: 'recommendations',
    recs: ['p13'],
    absent: ['p02']
  },
  {
    lead: '020 office on OMR under 5 Cr',
    filters: { location: 'OMR', category: 'commercial', query: 'office space', maxBudget: Cr(5) },
    outcome: 'recommendations',
    recs: ['p20'],
    differences: { p20: ['cloud kitchen instead of office'] },
    overBudget: ['p08']
  },
  {
    lead: '002 2BHK apartment in OMR under 70 lakh',
    filters: { location: 'OMR', category: 'residential', bedrooms: 2, maxBudget: L(70) },
    outcome: 'matches',
    matches: ['p04']
  },
  {
    lead: '003 1BHK near Tambaram, max 30 lakh',
    filters: { location: 'Tambaram', category: 'residential', bedrooms: 1, maxBudget: L(30) },
    outcome: 'matches',
    matches: ['p16']
  },
  {
    lead: '006 cloud kitchen on OMR, around 1.4 crore',
    filters: { location: 'OMR', category: 'commercial', query: 'cloud kitchen', minBudget: Cr(1.19), maxBudget: Cr(1.61) },
    outcome: 'matches',
    matches: ['p20']
  },
  {
    lead: '030 flat near Tidel Park, about 70 lakh',
    filters: { location: 'near Tidel Park', category: 'residential', query: 'flat', maxBudget: L(70) },
    outcome: 'matches',
    matches: ['p04']
  },
  {
    lead: '021 I need a house',
    filters: { category: 'residential', query: 'house' },
    outcome: 'matches',
    matchSet: ['p05', 'p06', 'p18']
  },
  {
    lead: '022 budget 1 crore and nothing else',
    filters: { maxBudget: Cr(1) },
    outcome: 'matches',
    matches: ['p16', 'p04', 'p11']
  },
  {
    lead: '023 anything in OMR',
    filters: { location: 'OMR' },
    outcome: 'matches',
    matchSet: ['p04', 'p08', 'p20']
  },
  {
    lead: '025 need 3 BHK, nothing else',
    filters: { bedrooms: 3 },
    outcome: 'recommendations',
    recs: ['p03', 'p04', 'p18'],
    absent: ['p19']
  },
  {
    lead: '039 cheap penthouse in Besant Nagar (sold and far above budget)',
    filters: { location: 'Besant Nagar', category: 'residential', query: 'penthouse', maxBudget: Cr(1) },
    absent: ['p19'],
    unavailable: ['p19']
  },
  {
    lead: '040 ready-to-move 2BHK in OMR under 70 lakh, no under-construction',
    filters: { location: 'OMR', category: 'residential', bedrooms: 2, maxBudget: L(70), dealBreakers: ['under construction'] },
    outcome: 'nothing_in_area',
    recs: [],
    absent: ['p04'],
    heldBack: ['p04'],
    nearest: 'p16'
  },
  {
    lead: '042 flat in Ambattur (no residential there)',
    filters: { location: 'Ambattur', category: 'residential' },
    outcome: 'recommendations',
    recs: ['p03'],
    differences: { p03: ['about 6 km from Ambattur'] }
  },
  {
    lead: '044 residential on ECR under 1 Cr',
    filters: { location: 'ECR', category: 'residential', maxBudget: Cr(1) },
    outcome: 'recommendations',
    absent: ['p06'],
    overBudget: ['p06']
  },
  {
    lead: '050 3BHK in Anna Nagar, 2 crore (Tanglish)',
    filters: { location: 'Anna Nagar', category: 'residential', bedrooms: 3, maxBudget: Cr(2) },
    outcome: 'nothing_in_budget',
    recs: [],
    overBudget: ['p03']
  }
];

for (const c of cases) {
  test(`matching: ${c.lead}`, () => {
    const found = findMatches(properties, c.filters);

    if (c.outcome) assert.equal(found.outcome, c.outcome);
    if (c.matches) assert.deepEqual(ids(found.matches), c.matches);
    if (c.matchSet) assert.deepEqual(ids(found.matches).sort(), c.matchSet);
    if (c.recs) assert.deepEqual(ids(found.recommendations), c.recs);

    const shown = [...ids(found.matches), ...ids(found.recommendations)];
    for (const id of c.absent ?? []) assert.ok(!shown.includes(id), `${id} must not be shown`);

    for (const [id, expected] of Object.entries(c.differences ?? {})) {
      const rec = found.recommendations.find((r) => r.id === id);
      assert.ok(rec, `${id} should be recommended`);
      for (const text of expected) {
        assert.ok(rec.differences.includes(text), `${id} differences ${JSON.stringify(rec.differences)} should include "${text}"`);
      }
    }
    if (c.unavailable) assert.deepEqual(ids(found.unavailable), c.unavailable);
    if (c.overBudget) assert.deepEqual(ids(found.droppedOverBudget), c.overBudget);
    if (c.heldBack) assert.deepEqual(ids(found.excludedByDealBreaker), c.heldBack);
    if (c.nearest) assert.equal(found.nearestElsewhere?.id, c.nearest);
  });
}

test('sold and reserved listings are never returned, whatever is asked', () => {
  for (const filters of [{}, { category: 'residential' }, { location: 'T. Nagar' }, { query: 'penthouse' }]) {
    const found = findMatches(properties, filters);
    const shown = [...found.matches, ...found.recommendations];
    assert.ok(shown.every((p) => ['available', 'under_construction'].includes(p.status)));
  }
});

test('a listing with no price is never stated with a number', () => {
  const found = findMatches(properties, { category: 'residential', query: 'bungalow' });
  const bungalow = found.matches.find((p) => p.id === 'p05');
  assert.equal(bungalow.priceDisplay, 'Price on Request (POR)');
  assert.equal(bungalow.price, null);
});

test('far options appear only when nothing is near, and only the nearest one', () => {
  const found = findMatches(properties, { location: 'Mamallapuram', category: 'hospitality', maxBudget: Cr(50) });
  assert.equal(found.recommendations.length, 1);
  assert.match(found.recommendations[0].differences[0], /^about \d+ km away from Mamallapuram$/);
});

test('there is never more than 3 recommendations', () => {
  const found = findMatches(properties, { bedrooms: 7 });
  assert.ok(found.recommendations.length <= 3);
});

test('an unknown area falls back to matching the typed words', () => {
  const found = findMatches(properties, { location: 'Mylapore' });
  assert.deepEqual(ids(found.matches), ['p09']);
  const unknown = findMatches(properties, { location: 'Narnia' });
  assert.equal(unknown.outcome, 'nothing_in_area');
  assert.equal(unknown.criteria.areaRecognised, false);
});

test('searchProperties pages the matches and leaves the sold ones out', async () => {
  const supabase = createFakeSupabase({ properties });
  const first = await searchProperties(supabase, { maxBudget: Cr(100), limit: 3, offset: 0 });
  assert.equal(first.configured, true);
  assert.equal(first.count, 3);
  assert.ok(first.totalMatches > 3);
  assert.equal(first.nextOffset, 3);

  const second = await searchProperties(supabase, { maxBudget: Cr(100), limit: 3, offset: 3 });
  assert.ok(!ids(first.results).some((id) => ids(second.results).includes(id)));
});

test('BHK typed into the free-text field still counts as a bedroom requirement', () => {
  assert.deepEqual(bedroomsFromText('3 BHK'), { exact: 3, atLeast: null });
  assert.deepEqual(bedroomsFromText('3bhk flat'), { exact: 3, atLeast: null });
  assert.deepEqual(bedroomsFromText('3+ bhk'), { exact: null, atLeast: 3 });
  assert.deepEqual(bedroomsFromText('sea facing'), { exact: null, atLeast: null });

  const typed = findMatches(properties, { location: 'Anna Nagar', query: '3 BHK', maxBudget: Cr(2) });
  const given = findMatches(properties, { location: 'Anna Nagar', category: 'residential', bedrooms: 3, maxBudget: Cr(2) });
  assert.equal(typed.outcome, given.outcome);
  assert.deepEqual(typed.criteria.bedrooms, 3);
  assert.deepEqual(typed.criteria.categories, ['residential']);
});

test('a vague area such as "not far from the city" is no area at all', () => {
  for (const vague of ['near the city', 'not far from the city', 'anywhere in Chennai', 'central Chennai']) {
    const found = findMatches(properties, { location: vague, category: 'plot' });
    assert.equal(found.criteria.area, null, vague);
    assert.ok(found.matches.length > 0, vague);
  }
  assert.equal(findMatches(properties, { location: 'OMR' }).criteria.area, 'OMR');
});
