// Knowledge gaps (what we could not answer) and entries (what the owners told us to say).
import { normalize } from './microMarkets.js';

function groupKeyOf({ kind, topic, question, propertyId, area }) {
  const what = topic ?? normalize(question).slice(0, 60);
  return [kind, what, propertyId ?? '', area ?? ''].join('|');
}

// Saves a question we could not answer. The same customer asking the same thing again only adds to the count.
export async function recordGap(supabase, { customerId, isTest = false, question, kind, topic = null, propertyId = null, area = null, request = {} }) {
  const groupKey = groupKeyOf({ kind, topic, question, propertyId, area });

  const { data: existing, error } = await supabase
    .from('knowledge_gaps')
    .select('id,times')
    .eq('group_key', groupKey)
    .eq('customer_id', customerId)
    .eq('status', 'open')
    .limit(1);
  if (error) throw error;

  const now = new Date().toISOString();
  if (existing.length) {
    const { error: updateError } = await supabase
      .from('knowledge_gaps')
      .update({ times: existing[0].times + 1, last_asked_at: now, question, request })
      .eq('id', existing[0].id);
    if (updateError) throw updateError;
    return existing[0].id;
  }

  const { data, error: insertError } = await supabase
    .from('knowledge_gaps')
    .insert({
      question, kind, topic, property_id: propertyId, area, customer_id: customerId,
      is_test: isTest, group_key: groupKey, request, first_asked_at: now, last_asked_at: now
    })
    .select('id')
    .single();
  if (insertError) throw insertError;
  return data.id;
}

// An owner-approved answer for this topic: about this property first, then this area, then in general.
export async function findEntry(supabase, { topic, propertyId, area }) {
  if (!topic) return null;
  const { data, error } = await supabase
    .from('knowledge_entries')
    .select('*')
    .eq('topic', topic)
    .eq('active', true)
    .limit(200);
  if (error) throw error;

  const named = (a) => normalize(a ?? '');
  return (
    data.find((e) => e.scope === 'property' && propertyId && e.property_id === propertyId) ??
    data.find((e) => e.scope === 'area' && area && named(e.area) === named(area)) ??
    data.find((e) => e.scope === 'general') ??
    null
  );
}

export async function markServed(supabase, entry) {
  await supabase
    .from('knowledge_entries')
    .update({ served_count: (entry.served_count ?? 0) + 1, last_served_at: new Date().toISOString() })
    .eq('id', entry.id);
}

const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'which', 'how', 'does', 'this', 'that', 'there', 'have', 'you', 'can', 'are', 'any', 'tell', 'about', 'is', 'it', 'a', 'of', 'to', 'in', 'on', 'my', 'me', 'do']);
export const keywordsOf = (text) => [...new Set(normalize(text).split(' ').filter((w) => w.length >= 3 && !STOP.has(w)))].slice(0, 12);

// Entries worth handing to the model for this question: they match its words and are about something in play.
export async function relevantEntries(supabase, { text, propertyIds = [], areas = [], limit = 3 }) {
  const { data, error } = await supabase.from('knowledge_entries').select('*').eq('active', true).limit(500);
  if (error) throw error;

  const words = new Set(keywordsOf(text));
  const areaNames = areas.map((a) => normalize(a));
  return data
    .map((e) => {
      const overlap = [...(e.keywords ?? []), ...keywordsOf(e.question ?? '')].filter((w) => words.has(w)).length;
      const about =
        e.scope === 'property' ? (propertyIds.includes(e.property_id) ? 3 : -1)
        : e.scope === 'area' ? (areaNames.includes(normalize(e.area)) ? 2 : -1)
        : 1;
      return { entry: e, score: overlap > 0 && about > 0 ? overlap * 2 + about : 0 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.entry);
}

// ---- for the lead board --------------------------------------------------------------------

// Open gaps, the same question about the same thing grouped together, most asked first.
export async function listGapGroups(supabase, { status = 'open', includeTests = true } = {}) {
  const { data, error } = await supabase
    .from('knowledge_gaps')
    .select('*')
    .eq('status', status)
    .order('last_asked_at', { ascending: false })
    .limit(1000);
  if (error) throw error;

  const groups = new Map();
  for (const gap of data) {
    if (!includeTests && gap.is_test) continue;
    const g = groups.get(gap.group_key) ?? {
      id: gap.id, groupKey: gap.group_key, kind: gap.kind, topic: gap.topic, propertyId: gap.property_id, area: gap.area,
      question: gap.question, times: 0, customers: new Set(), lastAskedAt: gap.last_asked_at, requests: [], isTest: true, entryId: gap.entry_id
    };
    g.times += gap.times;
    g.customers.add(gap.customer_id);
    g.isTest = g.isTest && gap.is_test;
    if (g.requests.length < 5) g.requests.push({ at: gap.last_asked_at, question: gap.question, request: gap.request, customerId: gap.customer_id });
    groups.set(gap.group_key, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, customers: g.customers.size }))
    .sort((a, b) => b.times - a.times || (a.lastAskedAt < b.lastAskedAt ? 1 : -1));
}

// The owner answers a gap. That creates an entry, and every open gap of the same kind closes with it.
export async function answerGap(supabase, gapId, { answer, by }) {
  const { data: gap, error } = await supabase.from('knowledge_gaps').select('*').eq('id', gapId).maybeSingle();
  if (error) throw error;
  if (!gap) return null;

  const scope = gap.property_id ? 'property' : gap.area ? 'area' : 'general';
  const { data: entry, error: entryError } = await supabase
    .from('knowledge_entries')
    .insert({
      scope, property_id: gap.property_id, area: gap.area, topic: gap.topic,
      keywords: keywordsOf(gap.question), question: gap.question, answer: answer.trim(), created_by: by ?? null
    })
    .select('*')
    .single();
  if (entryError) throw entryError;

  const { error: closeError } = await supabase
    .from('knowledge_gaps')
    .update({ status: 'answered', entry_id: entry.id })
    .eq('group_key', gap.group_key)
    .eq('status', 'open');
  if (closeError) throw closeError;
  return entry;
}

export async function dismissGap(supabase, gapId) {
  const { data: gap, error } = await supabase.from('knowledge_gaps').select('group_key').eq('id', gapId).maybeSingle();
  if (error) throw error;
  if (!gap) return false;
  const { error: updateError } = await supabase.from('knowledge_gaps').update({ status: 'dismissed' }).eq('group_key', gap.group_key).eq('status', 'open');
  if (updateError) throw updateError;
  return true;
}

export async function listEntries(supabase) {
  const { data, error } = await supabase.from('knowledge_entries').select('*').order('updated_at', { ascending: false }).limit(500);
  if (error) throw error;
  return data;
}

export async function updateEntry(supabase, id, { answer, active }) {
  const patch = { updated_at: new Date().toISOString() };
  if (typeof answer === 'string') patch.answer = answer.trim();
  if (typeof active === 'boolean') patch.active = active;
  const { data, error } = await supabase.from('knowledge_entries').update(patch).eq('id', id).select('*');
  if (error) throw error;
  return data[0] ?? null;
}

export async function deleteEntry(supabase, id) {
  const { data, error } = await supabase.from('knowledge_entries').delete().eq('id', id).select('id');
  if (error) throw error;
  return data.length > 0;
}
