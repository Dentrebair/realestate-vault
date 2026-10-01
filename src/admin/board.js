// What the lead board shows: leads by stage, one lead in full, and unmet demand.
import { formatInr, priceDisplay } from '../money.js';
import { STAGES } from '../stages.js';

export const STAGE_LABELS = {
  initiated: 'Initiated',
  interested: 'Interested',
  negotiating: 'Negotiating',
  site_visit_ready: 'Ready for site visit',
  closed: 'Closed',
  not_interested: 'Not interested'
};

const BOARD_COLUMNS =
  'customer_id,display_name,handle,phone,lead_stage,intent,budget_min,budget_max,preferred_locations,property_categories,bedrooms,shortlisted_property_ids,urgency,next_action,source,is_test,last_contacted_at,updated_at';

const PER_STAGE_LIMIT = 100;

export async function getBoard(supabase, { includeTests = true } = {}) {
  let query = supabase
    .from('customer_leads')
    .select(BOARD_COLUMNS)
    .order('updated_at', { ascending: false })
    .limit(1000);
  if (!includeTests) query = query.eq('is_test', false);

  const { data, error } = await query;
  if (error) throw error;

  const columns = STAGES.map((stage) => ({ stage, label: STAGE_LABELS[stage], count: 0, leads: [] }));
  const byStage = Object.fromEntries(columns.map((c) => [c.stage, c]));
  for (const row of data) {
    const column = byStage[row.lead_stage];
    if (!column) continue;
    column.count += 1;
    if (column.leads.length < PER_STAGE_LIMIT) column.leads.push(toCard(row));
  }
  return { columns, total: data.length };
}

function toCard(row) {
  return {
    id: row.customer_id,
    name: row.display_name ?? 'Unknown',
    handle: row.handle,
    stage: row.lead_stage,
    summary: requirementSummary(row),
    shortlistCount: row.shortlisted_property_ids?.length ?? 0,
    hasPhone: Boolean(row.phone),
    source: row.source,
    isTest: row.is_test,
    lastContactedAt: row.last_contacted_at,
    updatedAt: row.updated_at
  };
}

export function requirementSummary(row) {
  const parts = [];
  if (row.bedrooms) parts.push(`${row.bedrooms} BHK`);
  if (row.property_categories?.length) parts.push(row.property_categories.join(', '));
  if (row.preferred_locations?.length) parts.push(`in ${row.preferred_locations.join(', ')}`);
  if (row.budget_min && row.budget_max) parts.push(`${formatInr(row.budget_min)} to ${formatInr(row.budget_max)}`);
  else if (row.budget_max) parts.push(`up to ${formatInr(row.budget_max)}`);
  else if (row.budget_min) parts.push(`from ${formatInr(row.budget_min)}`);
  return parts.length ? parts.join(' · ') : 'No requirements yet';
}

// One lead in full. `showConversation` is the policy decision, made by the caller.
export async function getLeadDetail(supabase, customerId, { showConversation, role = 'admin' }) {
  const { data: lead, error } = await supabase
    .from('customer_leads')
    .select('*')
    .eq('customer_id', customerId)
    .maybeSingle();
  if (error) throw error;
  if (!lead) return null;

  const { data: events, error: eventsError } = await supabase
    .from('lead_events')
    .select('id,event_type,from_stage,to_stage,property_id,note,payload,alerted_at,created_at')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (eventsError) throw eventsError;

  const propertyIds = [...new Set([...(lead.shortlisted_property_ids ?? []), ...events.map((e) => e.property_id).filter(Boolean)])];
  const properties = await propertiesById(supabase, propertyIds);

  let conversation = null;
  // Only admins may read what a customer actually typed, and then only where the policy allows it.
  if (role === 'admin' && showConversation(lead)) {
    const { data: messages, error: messagesError } = await supabase
      .from('chat_messages')
      .select('role,content,created_at')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .limit(40);
    if (messagesError) throw messagesError;
    conversation = messages.reverse();
  }

  return {
    id: lead.customer_id,
    name: lead.display_name ?? 'Unknown',
    handle: lead.handle,
    phone: role === 'admin' ? lead.phone : null,
    phoneHidden: role !== 'admin' && Boolean(lead.phone),
    stage: lead.lead_stage,
    isTest: lead.is_test,
    source: lead.source,
    requirements: {
      summary: requirementSummary(lead),
      intent: lead.intent,
      mustHaves: lead.must_haves ?? [],
      dealBreakers: lead.deal_breakers ?? [],
      urgency: lead.urgency,
      financing: lead.financing_status,
      nextAction: lead.next_action,
      lastQuery: lead.last_query_summary
    },
    keyPoints: (lead.key_points ?? []).filter((k) => k.type !== 'test_tags'),
    shortlist: (lead.shortlisted_property_ids ?? []).map((id) => describe(id, properties)),
    events: events.map((e) => ({
      id: e.id,
      type: e.event_type,
      fromStage: e.from_stage,
      toStage: e.to_stage,
      property: e.property_id ? describe(e.property_id, properties) : null,
      note: e.note,
      actor: e.payload?.actor ?? null,
      by: e.payload?.by ?? null,
      alerted: Boolean(e.alerted_at),
      at: e.created_at
    })),
    conversationVisible: conversation !== null,
    conversation,
    createdAt: lead.created_at,
    lastContactedAt: lead.last_contacted_at
  };
}

async function propertiesById(supabase, ids) {
  if (!ids.length) return new Map();
  const { data, error } = await supabase
    .from('properties')
    .select('property_id,title,location,status,price_inr')
    .in('property_id', ids);
  if (error) throw error;
  return new Map(data.map((p) => [p.property_id, p]));
}

function describe(id, properties) {
  const p = properties.get(id);
  return p
    ? { id, title: p.title, location: p.location, status: p.status, price: priceDisplay(p.price_inr) }
    : { id, title: 'Property no longer listed', location: null, status: null, price: null };
}

// What customers asked for that we could not fully satisfy, grouped by what they asked.
export async function getDemand(supabase, { includeTests = true } = {}) {
  const { data: events, error } = await supabase
    .from('lead_events')
    .select('customer_id,note,payload,created_at')
    .eq('event_type', 'zero_result')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw error;
  if (!events.length) return { items: [] };

  const { data: leads, error: leadsError } = await supabase
    .from('customer_leads')
    .select('customer_id,is_test')
    .in('customer_id', [...new Set(events.map((e) => e.customer_id))]);
  if (leadsError) throw leadsError;
  const isTest = new Map(leads.map((l) => [l.customer_id, l.is_test]));

  const groups = new Map();
  for (const e of events) {
    if (!includeTests && isTest.get(e.customer_id)) continue;
    const key = e.note ?? 'Unspecified';
    const group = groups.get(key) ?? { request: key, count: 0, customers: new Set(), outcomes: new Set(), lastAt: e.created_at };
    group.count += 1;
    group.customers.add(e.customer_id);
    if (e.payload?.outcome) group.outcomes.add(e.payload.outcome);
    groups.set(key, group);
  }

  const items = [...groups.values()]
    .map((g) => ({ request: g.request, count: g.count, customers: g.customers.size, outcomes: [...g.outcomes], lastAt: g.lastAt }))
    .sort((a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : -1))
    .slice(0, 10);
  return { items };
}
