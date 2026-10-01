import { z } from 'zod';
import { STAGES, canTransition } from './stages.js';

const MAX_KEY_POINTS = 30;

// The AI tool schema sends null for "not mentioned". Treat null the same as absent.
export function stripNulls(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null));
}

const text = z.string().trim().min(1);

const leadMemoryBase = z.object({
  customerId: text.min(3),
  displayName: text.optional(),
  handle: text.optional(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9\s-]{6,14}$/, 'phone must be 7 to 15 digits, optionally starting with +')
    .optional(),
  source: text.optional(),
  leadStage: z.enum(STAGES).optional(),
  stageReason: text.optional(),
  intent: text.optional(),
  budgetMin: z.coerce.number().int().nonnegative().optional(),
  budgetMax: z.coerce.number().int().positive().optional(),
  preferredLocations: z.array(text).max(20).optional(),
  propertyCategories: z.array(text).max(20).optional(),
  bedrooms: z.coerce.number().int().positive().optional(),
  bathrooms: z.coerce.number().int().positive().optional(),
  mustHaves: z.array(text).max(30).optional(),
  dealBreakers: z.array(text).max(30).optional(),
  urgency: text.optional(),
  financingStatus: text.optional(),
  keyPoints: z
    .array(
      z.object({
        type: text,
        text,
        confidence: z.coerce.number().min(0).max(1).default(0.8)
      })
    )
    .max(MAX_KEY_POINTS)
    .optional(),
  shortlistedPropertyIds: z.array(text).max(30).optional(),
  lastQuerySummary: text.optional(),
  nextAction: text.optional()
});

export const leadMemorySchema = z.preprocess(
  stripNulls,
  leadMemoryBase.refine(
    (v) => v.budgetMin === undefined || v.budgetMax === undefined || v.budgetMin <= v.budgetMax,
    { message: 'budgetMin must be less than or equal to budgetMax', path: ['budgetMin'] }
  )
);

// ---- reads --------------------------------------------------------------------------------

export async function getLead(supabase, customerId) {
  const row = await fetchLeadRow(supabase, customerId);
  return row ? toLeadResponse(row) : null;
}

async function fetchLeadRow(supabase, customerId) {
  const { data, error } = await supabase
    .from('customer_leads')
    .select('*')
    .eq('customer_id', customerId)
    .maybeSingle();
  if (error) throw upstream(error);
  return data;
}

// ---- writes -------------------------------------------------------------------------------

// Saves what the Lead told us. Only the fields that are sent change; the stage is never reset.
export async function upsertLeadMemory(supabase, payload, { actor = 'api' } = {}) {
  if (!supabase) {
    return {
      configured: false,
      message: 'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
    };
  }

  const existing = await fetchLeadRow(supabase, payload.customerId);
  const patch = toLeadPatch(payload, existing);

  if (existing) {
    const { error } = await supabase.from('customer_leads').update(patch).eq('customer_id', payload.customerId);
    if (error) throw upstream(error);
  } else {
    const { error } = await supabase
      .from('customer_leads')
      .insert({ customer_id: payload.customerId, lead_stage: 'initiated', ...patch });
    if (error) throw upstream(error);
    await recordEvent(supabase, payload.customerId, 'lead_created', { toStage: 'initiated' });
  }

  let stage = null;
  if (payload.leadStage) {
    stage = await setStage(supabase, payload.customerId, payload.leadStage, {
      actor,
      reason: payload.stageReason
    });
  } else {
    const current = await fetchLeadRow(supabase, payload.customerId);
    if (current.lead_stage === 'initiated' && hasUsableRequirements(current)) {
      stage = await setStage(supabase, payload.customerId, 'interested', {
        actor: 'system',
        reason: 'requirements captured'
      });
    }
  }

  return { configured: true, lead: await getLead(supabase, payload.customerId), stage };
}

// Moves a Lead to another stage if the rules allow it, and records why.
export async function setStage(supabase, customerId, to, { actor, reason, propertyId, by } = {}) {
  const row = await fetchLeadRow(supabase, customerId);
  if (!row) throw notFound(customerId);

  const from = row.lead_stage;
  const verdict = canTransition(from, to, actor);
  if (!verdict.ok) return { changed: false, from, to, reason: verdict.reason };

  // Only update if the stage is still what we read, so two writers cannot step on each other.
  const { data, error } = await supabase
    .from('customer_leads')
    .update({ lead_stage: to, updated_at: now() })
    .eq('customer_id', customerId)
    .eq('lead_stage', from)
    .select('customer_id');
  if (error) throw upstream(error);
  if (!data?.length) return { changed: false, from, to, reason: 'stage changed by someone else' };

  await recordEvent(supabase, customerId, 'stage_changed', {
    fromStage: from,
    toStage: to,
    propertyId,
    note: reason,
    payload: { actor, ...(by ? { by } : {}) }
  });
  return { changed: true, from, to };
}

// The customer agreed to the privacy notice. Only now do we store their name and username.
export async function recordConsent(supabase, customerId, { version, from, source }) {
  const row = await fetchLeadRow(supabase, customerId);
  if (!row) throw notFound(customerId);
  const patch = {
    consent_at: now(),
    consent_version: version,
    display_name: from?.first_name || row.display_name || null,
    handle: from?.username || row.handle || null,
    updated_at: now()
  };
  if (source) patch.source = source;
  let { error } = await supabase.from('customer_leads').update(patch).eq('customer_id', customerId);
  if (error && /consent_version/.test(error.message)) {
    // The version column arrives with sql/005_privacy.sql. Agreeing must work before then.
    const { consent_version: _skip, ...withoutVersion } = patch;
    ({ error } = await supabase.from('customer_leads').update(withoutVersion).eq('customer_id', customerId));
  }
  if (error) throw upstream(error);
  await recordEvent(supabase, customerId, 'consent_given', { note: version });
  return getLead(supabase, customerId);
}

export async function addToShortlist(supabase, customerId, propertyId) {
  const row = await fetchLeadRow(supabase, customerId);
  if (!row) throw notFound(customerId);

  const ids = row.shortlisted_property_ids ?? [];
  if (!ids.includes(propertyId)) {
    const { error } = await supabase
      .from('customer_leads')
      .update({ shortlisted_property_ids: [...ids, propertyId], updated_at: now() })
      .eq('customer_id', customerId);
    if (error) throw upstream(error);
    await recordEvent(supabase, customerId, 'shortlisted', { propertyId });
  }

  const stage = await setStage(supabase, customerId, 'interested', {
    actor: 'system',
    reason: 'shortlisted a property',
    propertyId
  });
  return { lead: await getLead(supabase, customerId), stage };
}

export async function removeFromShortlist(supabase, customerId, propertyId) {
  const row = await fetchLeadRow(supabase, customerId);
  if (!row) throw notFound(customerId);

  const ids = row.shortlisted_property_ids ?? [];
  if (ids.includes(propertyId)) {
    const { error } = await supabase
      .from('customer_leads')
      .update({ shortlisted_property_ids: ids.filter((id) => id !== propertyId), updated_at: now() })
      .eq('customer_id', customerId);
    if (error) throw upstream(error);
    await recordEvent(supabase, customerId, 'unshortlisted', { propertyId });
  }
  return { lead: await getLead(supabase, customerId) };
}

// Small per-lead memory for the bot itself (scope check, what was last shown). Merged, not replaced.
export async function setBotState(supabase, customerId, patch) {
  const row = await fetchLeadRow(supabase, customerId);
  if (!row) throw notFound(customerId);

  const botState = { ...(row.bot_state ?? {}), ...patch };
  const { error } = await supabase
    .from('customer_leads')
    .update({ bot_state: botState })
    .eq('customer_id', customerId);
  if (error) throw upstream(error);
  return botState;
}

export async function recordEvent(
  supabase,
  customerId,
  eventType,
  { fromStage, toStage, propertyId, note, payload } = {}
) {
  const { error } = await supabase.from('lead_events').insert({
    customer_id: customerId,
    event_type: eventType,
    from_stage: fromStage ?? null,
    to_stage: toStage ?? null,
    property_id: propertyId ?? null,
    note: note ?? null,
    payload: payload ?? {}
  });
  if (error) throw upstream(error);
}

// ---- mapping ------------------------------------------------------------------------------

function toLeadPatch(p, existing) {
  const patch = {
    last_contacted_at: now(),
    updated_at: now()
  };
  const set = (column, value) => {
    if (value !== undefined) patch[column] = value;
  };

  set('display_name', p.displayName);
  set('handle', p.handle);
  set('phone', p.phone);
  set('source', p.source);
  set('intent', p.intent);
  set('budget_min', p.budgetMin);
  set('budget_max', p.budgetMax);
  set('preferred_locations', p.preferredLocations);
  set('property_categories', p.propertyCategories);
  set('bedrooms', p.bedrooms);
  set('bathrooms', p.bathrooms);
  set('must_haves', p.mustHaves);
  set('deal_breakers', p.dealBreakers);
  set('urgency', p.urgency);
  set('financing_status', p.financingStatus);
  set('last_query_summary', p.lastQuerySummary);
  set('next_action', p.nextAction);

  // Key points accumulate (newest kept); shortlisted ids only ever grow here.
  if (p.keyPoints) {
    const seen = new Set();
    const merged = [...(existing?.key_points ?? []), ...p.keyPoints].filter((k) => {
      const key = `${k.type}|${k.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    patch.key_points = merged.slice(-MAX_KEY_POINTS);
  }
  if (p.shortlistedPropertyIds) {
    patch.shortlisted_property_ids = [
      ...new Set([...(existing?.shortlisted_property_ids ?? []), ...p.shortlistedPropertyIds])
    ];
  }
  return patch;
}

function hasUsableRequirements(row) {
  return (
    row.budget_min != null ||
    row.budget_max != null ||
    row.bedrooms != null ||
    (row.preferred_locations ?? []).length > 0 ||
    (row.property_categories ?? []).length > 0
  );
}

function toLeadResponse(row) {
  return {
    customerId: row.customer_id,
    displayName: row.display_name,
    handle: row.handle,
    phone: row.phone,
    source: row.source,
    leadStage: row.lead_stage,
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
    isTest: row.is_test,
    consentAt: row.consent_at ?? null,
    consentVersion: row.consent_version ?? null,
    botState: row.bot_state ?? {},
    updatedAt: row.updated_at
  };
}

const now = () => new Date().toISOString();

function upstream(error) {
  error.statusCode = 502;
  return error;
}

function notFound(customerId) {
  const error = new Error(`No lead with id ${customerId}`);
  error.statusCode = 404;
  return error;
}
