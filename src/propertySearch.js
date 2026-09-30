import { z } from 'zod';
import { config, isSupabaseConfigured } from './config.js';

export const propertySearchSchema = z
  .object({
    location: z.string().trim().min(1).optional(),
    query: z.string().trim().min(1).optional(),
    category: z.string().trim().min(1).optional(),
    status: z.string().trim().min(1).optional(),
    bedrooms: z.coerce.number().int().positive().optional(),
    bathrooms: z.coerce.number().int().positive().optional(),
    minBudget: z.coerce.number().nonnegative().optional(),
    maxBudget: z.coerce.number().positive().optional(),
    limit: z.coerce.number().int().min(1).max(25).default(10)
  })
  .refine(
    (value) =>
      value.minBudget === undefined ||
      value.maxBudget === undefined ||
      value.minBudget <= value.maxBudget,
    {
      message: 'minBudget must be less than or equal to maxBudget',
      path: ['minBudget']
    }
  );

export async function searchProperties(supabase, filters) {
  if (!isSupabaseConfigured || !supabase) {
    return {
      configured: false,
      results: [],
      message: 'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
    };
  }

  let query = supabase
    .from(config.propertiesTable)
    .select('*')
    .limit(filters.limit);

  if (config.orderColumn) {
    query = query.order(config.orderColumn, { ascending: false, nullsFirst: false });
  }

  if (filters.location) {
    query = addTextSearch(query, [filters.location]);
  }

  if (filters.query) {
    query = addTextSearch(query, tokenize(filters.query));
  }

  if (filters.category) {
    query = query.ilike('category', `%${filters.category}%`);
  }

  if (filters.status) {
    query = query.ilike('status', `%${filters.status}%`);
  }

  if (filters.bedrooms) {
    query = query.eq('metadata->>bedrooms', String(filters.bedrooms));
  }

  if (filters.bathrooms) {
    query = query.eq('metadata->>bathrooms', String(filters.bathrooms));
  }

  if (filters.minBudget !== undefined) {
    query = query.gte('price_inr', filters.minBudget);
  }

  if (filters.maxBudget !== undefined) {
    query = query.lte('price_inr', filters.maxBudget);
  }

  const { data, error } = await query;

  if (error) {
    error.statusCode = 502;
    throw error;
  }

  return {
    configured: true,
    count: data.length,
    results: data.map(toPropertyResult)
  };
}

function toPropertyResult(row) {
  const metadata = row.metadata ?? row.details ?? {};

  return {
    id: row.property_id ?? row.id,
    title: row.title ?? metadata.title ?? null,
    location: row.location ?? row.locality ?? metadata.location ?? null,
    category: row.category ?? metadata.category ?? null,
    bedrooms: row.bedrooms ?? metadata.bedrooms ?? null,
    bathrooms: row.bathrooms ?? metadata.bathrooms ?? null,
    price: row.price ?? row.price_inr ?? metadata.price ?? null,
    availability: row.availability ?? row.status ?? metadata.availability ?? null,
    configuration: row.configuration ?? metadata.configuration ?? metadata ?? null,
    source: row.source ?? metadata.source ?? null
  };
}

function addTextSearch(query, terms) {
  for (const term of terms) {
    const textFilters = config.searchColumns
      .map((column) => `${column}.ilike.%${escapeFilter(term)}%`)
      .join(',');
    query = query.or(textFilters);
  }

  return query;
}

function tokenize(value) {
  return value
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3)
    .slice(0, 8);
}

function escapeFilter(value) {
  return value.replaceAll(',', '\\,').replaceAll('%', '\\%');
}
