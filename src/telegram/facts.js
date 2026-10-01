// What customers ask that is not a search, and where the answer lives.
//   listing_detail  a fact about one property: look in its data, then in owner-approved answers
//   area_info       about an area or the market: we have no guide, so owner-approved answers only
//   policy          what we can and cannot do: a fixed reply, which an owner may replace
import { parseBudgetRange } from '../money.js';
import { formatValue, humanize, SELLER_STATED_FIELDS } from '../propertyView.js';

export const TOPICS = [
  // about the area, the market or the future. No data of ours covers these.
  { key: 'transport_plans', kind: 'area_info', label: 'transport plans', re: /\b(metro|flyover|bridge|highway|road|airport)\b[^.?!]*\b(coming|planned|plan|upcoming|will be|proposed|expansion|extension)\b|\b(coming|planned|upcoming|proposed)\b[^.?!]*\b(metro|flyover|bridge|highway)\b/i },
  { key: 'investment', kind: 'area_info', label: 'investment outlook', re: /\b(good investment|worth (it|buying|investing)|appreciat\w+|price(s)? (go|rise|increase|grow|fall|drop|come down) (up|down)?\s*(next|in the)|next year|future (price|value)|forecast|resale value|return on investment)\b/i },
  { key: 'market', kind: 'area_info', label: 'market rates', re: /\b(market (rate|price|trend)s?|per sq\.? ?ft|price per sq|average price|rate per sq|going rate|guideline value)\b/i },
  { key: 'safety_traffic', kind: 'area_info', label: 'safety, flooding and traffic', re: /\b(safe|safety|crime|flood\w*|waterlog\w*|traffic|congestion|pollution|noise)\b/i },
  { key: 'nearby_places', kind: 'area_info', label: 'what is nearby', re: /\b(school|college|hospital|mall|supermarket|restaurant|bus stop|bus stand|railway station|park)s?\b[^.?!]*\b(near|nearby|close|around|within)\b|\b(near|nearby|close to|around)\b[^.?!]*\b(school|college|hospital|mall|supermarket)\b|\b(good|best) (school|hospital|college)s?\b/i },
  { key: 'area_guide', kind: 'area_info', label: 'what the area is like', re: /\b(tell me about|what is [^.?!]* like|what's [^.?!]* like|how is|how's|about the (area|locality)|good (area|locality|place|neighbou?rhood)|place to live|neighbou?rhood|locality)\b/i },

  // a fact about one property
  { key: 'parking', kind: 'listing_detail', label: 'parking', re: /\b(parking|car ?parks?|garage)\b/i, fields: ['car_parks', 'car_parking', 'allocated_car_parks', 'car_parking_slots', 'bike_parking'] },
  { key: 'lift', kind: 'listing_detail', label: 'lifts', re: /\b(lifts?|elevators?)\b/i, fields: ['private_elevator', 'two_customer_elevators', 'lift_capacity'] },
  { key: 'floor', kind: 'listing_detail', label: 'which floor it is on', re: /\b(which|what) floor\b|\bfloor (number|level)\b|\bhow many (floors|storeys|stories)\b/i, fields: ['floor', 'total_floors', 'floors'] },
  { key: 'facing', kind: 'listing_detail', label: 'which way it faces', re: /\b(facing|direction|which way)\b|\bface\b/i, fields: ['facing'] },
  { key: 'size', kind: 'listing_detail', label: 'the size', re: /\b(carpet|built[- ]?up|super[- ]?built|area|size|sq\.? ?ft|square feet|extent|dimensions?)\b/i, fields: ['carpet_area_sqft', 'super_builtup_sqft', 'builtup_area_sqft', 'total_builtup_sqft', 'plot_area_sqft', 'chargeable_area_sqft', 'builtup_sqft', 'land_extent', 'land_extent_sqft', 'land_extent_acres', 'land_extent_cents', 'dimensions', 'covered_shed_sqft', 'built_warehouse_sqft'] },
  { key: 'possession', kind: 'listing_detail', label: 'possession', re: /\b(possession|move[- ]in|handover|completion|ready to move)\b|\bwhen (can|will) i (move|get|take)\b/i, fields: ['possession_date', 'stage'] },
  { key: 'approvals', kind: 'listing_detail', label: 'approvals and title', re: /\b(rera|cmda|dtcp|approv\w+|title|encumbrance|occupancy|clear title|noc|legally clear)\b/i, fields: ['rera_id', 'rera_approved', 'cmda_approved', 'approvals', 'title_status', 'encumbrance', 'occupancy_certificate', 'fire_noc_obtained', 'sidco_transferrable'] },
  { key: 'maintenance', kind: 'listing_detail', label: 'maintenance charges', re: /\b(maintenance|society charges)\b/i, fields: ['maintenance_per_sqft'] },
  { key: 'furnishing', kind: 'listing_detail', label: 'furnishing', re: /\b(furnish\w*|flooring)\b/i, fields: ['furnishing', 'flooring'] },
  { key: 'age', kind: 'listing_detail', label: 'the age of the building', re: /\b(how old|age of|years old|construction year|built in)\b/i, fields: ['age_years', 'existing_structure_age_years', 'building_condition'] },
  { key: 'amenities', kind: 'listing_detail', label: 'amenities', re: /\b(amenit\w+|gym|swimming|pool|clubhouse|garden|play ?area|power ?backup|generator|facilities)\b/i, fields: ['facilities', 'gated_community', 'gated_layout', 'private_swimming_pool', 'backup_generators_kva', 'concierge_service'] },
  { key: 'view', kind: 'listing_detail', label: 'the view', re: /\b(view|sea[- ]facing|beach access)\b/i, fields: ['view', 'beach_access', 'distance_to_beach_meters'] },
  { key: 'distances', kind: 'listing_detail', label: 'distances', re: /\b(how far|distance|nearest|close to)\b[^.?!]*\b(metro|airport|beach|temple|station)\b|\b(metro|airport|beach|temple)\b[^.?!]*\b(distance|how far)\b/i, fields: ['distance_to_metro_meters', 'distance_to_airport_km', 'distance_to_beach_meters', 'distance_to_temple_meters', 'nearby_landmarks'] },
  { key: 'rent_yield', kind: 'listing_detail', label: 'rent or returns', re: /\b(rent|rental|yield|roi|returns?|income|tenant|lease)\b/i, fields: ['monthly_rental_current', 'monthly_rental_income_lakhs', 'monthly_rental_collection', 'roi_percentage', 'indicative_monthly_income_lakhs', 'current_tenant', 'lease_status', 'lock_in_years_remaining'] },
  { key: 'builder', kind: 'listing_detail', label: 'who the builder or seller is', re: /\b(builder|developer|promoter|who built|who is selling|seller name)\b/i, fields: [] },
  { key: 'pets', kind: 'listing_detail', label: 'pets', re: /\b(pets?|dogs?|cats?)\b/i, fields: [] },
  { key: 'address', kind: 'listing_detail', label: 'the exact address', re: /\b(exact address|full address|street address|door number|address of)\b/i, fields: [] },

  // what we can and cannot do
  { key: 'loan', kind: 'policy', label: 'loans, taxes and legal paperwork', re: /\b(loan|emi|mortgage|interest rate|stamp duty|registration (fee|cost|charges?)|tax|gst|capital gains|lawyer|advocate|sale deed|legal advice)\b/i },
  { key: 'documents', kind: 'policy', label: 'brochures, plans and videos', re: /\b(brochure|floor ?plans?|video|virtual tour|3d tour|walk-?through|pdf)\b/i },
  { key: 'contact', kind: 'policy', label: 'calls and messages', re: /\b(call me|call back|callback|phone call|ring me|whatsapp me|e-?mail me|contact number|phone number|talk to (someone|a person|an agent|a human)|speak to)\b/i }
];

export const DEFAULT_REPLIES = {
  area_info: (label) => `I do not have area guides, market data or forecasts, so I cannot speak to ${label}. I can show you listings in that area, and our team can talk you through it at a site visit.`,
  loan: () => 'I cannot advise on loans, taxes or legal paperwork. A bank or a professional is the right place for that. I can arrange a site visit request so our team can speak with you.',
  documents: () => 'I cannot send brochures, plans or videos here. I can show listings and arrange a site visit request, and our team will take it from there.',
  contact: () => 'I cannot place calls or messages from here. Request a site visit on a property and our team will be in touch to confirm a time.'
};

// A request to see properties is a search, not a question. Searches go to the search tool.
export function hasSearchIntent(text) {
  const t = String(text ?? '');
  return (
    parseBudgetRange(t) !== null ||
    /\b\d\s*\+?\s*-?\s*(bhk|bedrooms?)\b/i.test(t) ||
    /\b(show|find|search|looking for|look for|i need|i want|i am looking|give me|suggest)\b/i.test(t)
  );
}

export const isQuestion = (text) => /\?|^\s*(is|are|does|do|can|could|will|would|what|which|how|when|where|who|tell me|any)\b/i.test(String(text ?? ''));

// The topic of a question, or null. Only questions that are not searches are considered.
export function topicOf(text) {
  if (!isQuestion(text) || hasSearchIntent(text)) return null;
  return TOPICS.find((t) => t.re.test(text)) ?? null;
}

// What a property's own data says about a topic. Returns lines, or [] if it does not mention it.
export function fieldAnswer(metadata, topic) {
  const lines = [];
  for (const key of topic.fields ?? []) {
    const value = metadata?.[key];
    if (value === null || value === undefined || value === '') continue;
    const note = SELLER_STATED_FIELDS.has(key) ? ' (as stated by the seller)' : '';
    lines.push(`${humanize(key)}: ${formatValue(key, value)}${note}`);
  }
  return lines;
}
