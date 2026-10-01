import { z } from 'zod';
import { config } from './config.js';
import { recordEvent, stripNulls } from './leadMemory.js';
import { findMatches } from './matching.js';
import { toPropertyView } from './propertyView.js';

// Explicit columns: never `select *`, so large columns (embeddings) are not pulled on every search.
const COLUMNS = 'property_id,title,category,location,status,price_inr,metadata,raw_listing_text';
const FETCH_LIMIT = 1000;

const text = z.string().trim().min(1);

const searchBase = z.object({
  location: text.optional(),
  query: text.optional(),
  category: text.optional(),
  status: text.optional(),
  bedrooms: z.coerce.number().int().positive().optional(),
  minBedrooms: z.coerce.number().int().positive().optional(),
  bathrooms: z.coerce.number().int().positive().optional(),
  minBudget: z.coerce.number().nonnegative().optional(),
  maxBudget: z.coerce.number().positive().optional(),
  readyToMove: z.boolean().optional(),
  dealBreakers: z.array(text).max(30).optional(),
  mustHaves: z.array(text).max(30).optional(),
  customerId: text.optional(),
  limit: z.coerce.number().int().min(1).max(25).default(5),
  offset: z.coerce.number().int().min(0).default(0)
});

export const propertySearchSchema = z.preprocess(
  stripNulls,
  searchBase.refine(
    (v) => v.minBudget === undefined || v.maxBudget === undefined || v.minBudget <= v.maxBudget,
    { message: 'minBudget must be less than or equal to maxBudget', path: ['minBudget'] }
  )
);

export async function searchProperties(supabase, filters) {
  if (!supabase) {
    return {
      configured: false,
      results: [],
      message: 'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
    };
  }

  const { data, error } = await supabase
    .from(config.propertiesTable)
    .select(COLUMNS)
    .limit(FETCH_LIMIT);

  if (error) {
    error.statusCode = 502;
    throw error;
  }

  const found = findMatches(data, filters);
  const page = found.matches.slice(filters.offset, filters.offset + filters.limit);
  const next = filters.offset + filters.limit;

  if (filters.customerId && found.outcome !== 'matches') {
    await recordUnmetDemand(supabase, filters.customerId, found);
  }

  return {
    configured: true,
    outcome: found.outcome,
    guidance: found.guidance,
    criteria: found.criteria,
    count: page.length,
    totalMatches: found.matches.length,
    nextOffset: next < found.matches.length ? next : null,
    results: page,
    recommendations: found.recommendations,
    unavailable: found.unavailable,
    droppedOverBudget: found.droppedOverBudget,
    excludedByDealBreaker: found.excludedByDealBreaker,
    nearestElsewhere: found.nearestElsewhere,
    suggestions: found.suggestions
  };
}

// Searches that found no exact match are the client's unmet demand. Never fail a search over it.
async function recordUnmetDemand(supabase, customerId, found) {
  try {
    await recordEvent(supabase, customerId, 'zero_result', {
      note: found.criteria.summary,
      payload: { outcome: found.outcome, criteria: found.criteria }
    });
  } catch (error) {
    console.error('Could not record zero_result event:', error.message);
  }
}

// One listing by id, for "tell me more about that one" and for re-checking a card that was tapped.
export async function getProperty(supabase, propertyId) {
  const { data, error } = await supabase
    .from(config.propertiesTable)
    .select(COLUMNS)
    .eq('property_id', propertyId)
    .maybeSingle();
  if (error) {
    error.statusCode = 502;
    throw error;
  }
  return data ? { row: data, view: toPropertyView(data) } : null;
}
