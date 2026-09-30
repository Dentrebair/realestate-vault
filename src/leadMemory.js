import { z } from 'zod';
import { isSupabaseConfigured } from './config.js';

const leadStatuses = [
  'new',
  'searching',
  'shortlisted',
  'callback_requested',
  'site_visit_requested',
  'not_interested',
  'closed'
];

export const leadMemorySchema = z.object({
  customerId: z.string().trim().min(3),
  displayName: z.string().trim().min(1).optional(),
  leadStatus: z.enum(leadStatuses).default('searching'),
  intent: z.string().trim().min(1).optional(),
  budgetMin: z.coerce.number().int().nonnegative().optional(),
  budgetMax: z.coerce.number().int().positive().optional(),
  preferredLocations: z.array(z.string().trim().min(1)).max(20).default([]),
  propertyCategories: z.array(z.string().trim().min(1)).max(20).default([]),
  bedrooms: z.coerce.number().int().positive().optional(),
  bathrooms: z.coerce.number().int().positive().optional(),
  mustHaves: z.array(z.string().trim().min(1)).max(30).default([]),
  dealBreakers: z.array(z.string().trim().min(1)).max(30).default([]),
  urgency: z.string().trim().min(1).optional(),
  financingStatus: z.string().trim().min(1).optional(),
  keyPoints: z
    .array(
      z.object({
        type: z.string().trim().min(1),
        text: z.string().trim().min(1),
        confidence: z.coerce.number().min(0).max(1).default(0.8)
      })
    )
    .max(30)
    .default([]),
  shortlistedPropertyIds: z.array(z.string().trim().min(1)).max(30).default([]),
  lastQuerySummary: z.string().trim().min(1).optional(),
  nextAction: z.string().trim().min(1).optional()
});

export async function upsertLeadMemory(supabase, payload) {
  if (!isSupabaseConfigured || !supabase) {
    return {
      configured: false,
      message: 'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
    };
  }

  const row = toLeadRow(payload);
  const { data, error } = await supabase
    .from('customer_leads')
    .upsert(row, { onConflict: 'customer_id' })
    .select('*')
    .single();

  if (error) {
    error.statusCode = 502;
    throw error;
  }

  return {
    configured: true,
    lead: toLeadResponse(data)
  };
}

function toLeadRow(payload) {
  return {
    customer_id: payload.customerId,
    display_name: payload.displayName,
    lead_status: payload.leadStatus,
    intent: payload.intent,
    budget_min: payload.budgetMin,
    budget_max: payload.budgetMax,
    preferred_locations: payload.preferredLocations,
    property_categories: payload.propertyCategories,
    bedrooms: payload.bedrooms,
    bathrooms: payload.bathrooms,
    must_haves: payload.mustHaves,
    deal_breakers: payload.dealBreakers,
    urgency: payload.urgency,
    financing_status: payload.financingStatus,
    key_points: payload.keyPoints,
    shortlisted_property_ids: payload.shortlistedPropertyIds,
    last_query_summary: payload.lastQuerySummary,
    next_action: payload.nextAction,
    last_contacted_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

function toLeadResponse(row) {
  return {
    customerId: row.customer_id,
    displayName: row.display_name,
    leadStatus: row.lead_status,
    intent: row.intent,
    budgetMin: row.budget_min,
    budgetMax: row.budget_max,
    preferredLocations: row.preferred_locations,
    propertyCategories: row.property_categories,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    mustHaves: row.must_haves,
    dealBreakers: row.deal_breakers,
    urgency: row.urgency,
    financingStatus: row.financing_status,
    keyPoints: row.key_points,
    shortlistedPropertyIds: row.shortlisted_property_ids,
    lastQuerySummary: row.last_query_summary,
    nextAction: row.next_action,
    updatedAt: row.updated_at
  };
}
