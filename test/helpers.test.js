import assert from 'node:assert/strict';
import test from 'node:test';
import { formatInr, parseAmount, parseBudgetRange, priceDisplay, toInr } from '../src/money.js';
import { areaDistance, locateProperty, resolveArea } from '../src/microMarkets.js';
import { detectSubtypes, normalizeCategory } from '../src/propertyTypes.js';
import { canTransition } from '../src/stages.js';

test('formatInr writes prices the way brokers say them', () => {
  assert.equal(formatInr(62e5), '₹62 L');
  assert.equal(formatInr(4.8e7), '₹4.8 Cr');
  assert.equal(formatInr(1.35e7), '₹1.35 Cr');
  assert.equal(formatInr(24.5e7), '₹24.5 Cr');
  assert.equal(formatInr(1.6e9), '₹160 Cr');
  assert.equal(formatInr(75000), '₹75,000');
  assert.equal(formatInr(null), null);
});

test('a missing price is always Price on Request', () => {
  assert.equal(priceDisplay(null), 'Price on Request (POR)');
  assert.equal(priceDisplay(undefined), 'Price on Request (POR)');
  assert.equal(priceDisplay(8.4e6), '₹84 L');
});

test('toInr converts amount and unit', () => {
  assert.equal(toInr(1.5, 'crore'), 15000000);
  assert.equal(toInr(150, 'lakh'), 15000000);
  assert.equal(toInr(80, 'L'), 8000000);
  assert.throws(() => toInr(1, 'dollars'));
});

test('parseAmount reads shorthand and flags a missing unit', () => {
  assert.deepEqual(parseAmount('1.5C'), { value: 15000000, unitKnown: true });
  assert.deepEqual(parseAmount('150L'), { value: 15000000, unitKnown: true });
  assert.deepEqual(parseAmount('1.5 crore'), { value: 15000000, unitKnown: true });
  assert.deepEqual(parseAmount('₹75,00,000'), { value: 7500000, unitKnown: true });
  assert.deepEqual(parseAmount('budget is around 80'), { value: 80, unitKnown: false });
  assert.equal(parseAmount('no number here'), null);
});

test('parseBudgetRange handles ranges, limits and inverted ranges', () => {
  assert.deepEqual(parseBudgetRange('150L to 2 crore'), { min: 15000000, max: 20000000, unitKnown: true, inverted: false });
  assert.deepEqual(parseBudgetRange('80 to 90 lakhs'), { min: 8000000, max: 9000000, unitKnown: true, inverted: false });
  assert.equal(parseBudgetRange('budget 2 crore to 1 crore').inverted, true);
  assert.deepEqual(parseBudgetRange('under 1.5C'), { max: 15000000, unitKnown: true });
  assert.deepEqual(parseBudgetRange('above 50 lakh'), { min: 5000000, unitKnown: true });
  assert.equal(parseBudgetRange('around 80 lakh').approximate, true);
  assert.equal(parseBudgetRange('budget around 80').unitKnown, false);
});

test('categories and types come from everyday words', () => {
  assert.deepEqual(normalizeCategory('flat'), ['residential']);
  assert.deepEqual(normalizeCategory('villa plot'), ['plot']);
  assert.deepEqual(normalizeCategory('land'), ['plot', 'farmland']);
  assert.deepEqual(normalizeCategory('cloud kitchen'), ['commercial']);
  assert.deepEqual(normalizeCategory('cold storage'), ['industrial']);
  assert.deepEqual(normalizeCategory('commercial redevelopment'), ['commercial_redevelopment']);
  assert.deepEqual(normalizeCategory('commercial_redevelopment'), ['commercial_redevelopment']);
  assert.deepEqual(normalizeCategory('apartment'), ['residential']);
  assert.deepEqual(normalizeCategory(''), []);
  assert.ok(detectSubtypes('F&B Approved Cloud Kitchen Facility').has('kitchen'));
  assert.ok(detectSubtypes('Exclusive Rooftop Penthouse with Ocean Vista').has('apartment'));
  assert.ok(detectSubtypes('Sea-Facing 5BHK Independent Villa').has('house'));
});

test('areas resolve from names, corridors and landmarks', () => {
  assert.equal(resolveArea('OMR').name, 'OMR');
  assert.equal(resolveArea('near Tidel Park').name, 'OMR');
  assert.equal(resolveArea('Old Mahabalipuram Road').name, 'OMR');
  assert.equal(resolveArea('T Nagar').name, 'T. Nagar');
  assert.equal(resolveArea('Tambaram').kind, 'area');
  assert.ok(resolveArea('Tambaram').members.includes('East Tambaram'));
  assert.equal(resolveArea('East Tambaram').kind, 'locality');
  assert.equal(resolveArea('Anna Nagar, Chennai').name, 'Anna Nagar');
  assert.equal(resolveArea('somewhere unknown'), null);
});

test('a listing is placed by its locality even when the text is messy', () => {
  assert.equal(locateProperty('Navalur, OMR, Chennai').locality.name, 'Navalur');
  assert.equal(locateProperty('Anna Nagar West, Chennai').locality.name, 'Anna Nagar West');
  assert.equal(locateProperty('Poonamallee High Road, Chennai').locality.name, 'Poonamallee');
  assert.equal(locateProperty('Nowhere Known').locality, null);
});

test('distance tiers: same area, near, far', () => {
  const omr = resolveArea('OMR');
  assert.equal(areaDistance(omr, locateProperty('Navalur, OMR, Chennai')).tier, 0);
  assert.equal(areaDistance(omr, locateProperty('Perungudi, Chennai')).tier, 0);
  assert.equal(areaDistance(omr, locateProperty('Velachery, Chennai')).tier, 1);
  assert.equal(areaDistance(omr, locateProperty('Anna Nagar West, Chennai')).tier, 2);
  assert.equal(areaDistance(resolveArea('Tambaram'), locateProperty('East Tambaram, Chennai')).tier, 0);
  assert.equal(areaDistance(resolveArea('Mylapore'), locateProperty('Alwarpet, Chennai')).tier, 1);
});

test('stage rules: who may move a lead where', () => {
  assert.equal(canTransition('initiated', 'interested', 'system').ok, true);
  assert.equal(canTransition('interested', 'negotiating', 'model').ok, true);
  assert.equal(canTransition('negotiating', 'not_interested', 'model').ok, true);
  assert.equal(canTransition('interested', 'site_visit_ready', 'button').ok, true);

  // the model can never create a hot lead or close a deal
  assert.equal(canTransition('interested', 'site_visit_ready', 'model').ok, false);
  assert.equal(canTransition('site_visit_ready', 'closed', 'model').ok, false);

  // no going backwards, except by a person on the board
  assert.equal(canTransition('negotiating', 'interested', 'system').ok, false);
  assert.equal(canTransition('site_visit_ready', 'interested', 'model').ok, false);
  assert.equal(canTransition('site_visit_ready', 'interested', 'board').ok, true);
  assert.equal(canTransition('interested', 'closed', 'board').ok, true);

  // opting out, and coming back
  assert.equal(canTransition('not_interested', 'interested', 'system').ok, true);
  assert.equal(canTransition('not_interested', 'negotiating', 'model').ok, false);

  assert.equal(canTransition('interested', 'interested', 'system').noop, true);
  assert.equal(canTransition('initiated', 'nonsense', 'system').ok, false);
  assert.equal(canTransition('initiated', 'interested', 'stranger').ok, false);
});
