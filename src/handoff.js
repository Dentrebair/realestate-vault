// Requests the bot passes to the team, and the conversation about each one. See sql/007_handoffs.sql.
// Without the tables (before sql/007 is run) every function here does nothing and says so, so the bot still works.
import { log } from './telegram/log.js';

export const KIND_LABELS = {
  visit: 'Site visit',
  callback: 'Call back or talk to a person',
  offer: 'Price offer',
  question: 'Question we could not answer'
};
export const OPEN = ['open', 'waiting_customer'];

const tableMissing = (error) =>
  ['42P01', 'PGRST205'].includes(error?.code) || /does not exist|schema cache/i.test(error?.message ?? '');

let warned = false;
function failed(error, what) {
  if (tableMissing(error)) {
    if (!warned) {
      warned = true;
      log('handoffs_unavailable', { note: 'run sql/007_handoffs.sql to turn on team requests' }, 'warn');
    }
    return null;
  }
  throw Object.assign(new Error(`${what}: ${error.message}`), { statusCode: 502 });
}

const now = () => new Date().toISOString();

// How long the team may take before a request is overdue: a visit is the hottest lead, so it gets the shortest time.
export const replyMinutes = (kind, config) => (kind === 'visit' ? config.visitReplyMinutes : config.requestReplyMinutes);

// Since when has the team owed the customer an answer? From the first customer message after the team's last reply
// (or the first message of the request). It restarts when the customer answers a reply from the team.
export function waitingSince(thread) {
  let lastReply = -Infinity;
  for (const m of thread) if (m.direction === 'staff') lastReply = Math.max(lastReply, Date.parse(m.createdAt));
  return thread.find((m) => m.direction === 'customer' && Date.parse(m.createdAt) > lastReply)?.createdAt ?? null;
}

// "2 hrs 21 mins", "45 mins", "1 hr", "less than a min".
export function formatWait(minutes) {
  const total = Math.max(0, Math.floor(minutes));
  if (total < 1) return 'less than a min';
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  const parts = [];
  if (hours) parts.push(`${hours} ${hours === 1 ? 'hr' : 'hrs'}`);
  if (mins) parts.push(`${mins} ${mins === 1 ? 'min' : 'mins'}`);
  return parts.join(' ');
}

export function toHandoff(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    kind: row.kind,
    kindLabel: KIND_LABELS[row.kind] ?? row.kind,
    status: row.status,
    summary: row.summary,
    propertyId: row.property_id ?? null,
    isTest: row.is_test === true,
    alertChatId: row.alert_chat_id ?? null,
    alertMessageId: row.alert_message_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at ?? null,
    resolvedBy: row.resolved_by ?? null
  };
}

const toMessage = (row) => ({
  id: row.id,
  direction: row.direction,
  via: row.via,
  author: row.author ?? null,
  text: row.text,
  createdAt: row.created_at
});

// Opens a request, or adds to the one already open for the same customer, kind and property (so a customer who makes
// three offers is one conversation, not three alerts). Returns { handoff, created } or null without the tables.
export async function openHandoff(supabase, { customerId, kind, summary, propertyId = null, isTest = false }) {
  let query = supabase.from('handoffs').select('*').eq('customer_id', customerId).eq('kind', kind).in('status', OPEN);
  query = propertyId ? query.eq('property_id', propertyId) : query.is('property_id', null);
  const { data: existing, error: findError } = await query.order('created_at', { ascending: false }).limit(1);
  if (findError) return failed(findError, 'find request');
  if (existing?.length) {
    const added = await addMessage(supabase, existing[0].id, { direction: 'customer', via: 'bot', text: summary });
    return { handoff: toHandoff(existing[0]), created: false, messageId: added?.id ?? null };
  }

  const { data, error } = await supabase
    .from('handoffs')
    .insert({ customer_id: customerId, kind, summary, property_id: propertyId, is_test: isTest })
    .select('*')
    .single();
  if (error) return failed(error, 'open request');
  await addMessage(supabase, data.id, { direction: 'customer', via: 'bot', text: summary });
  return { handoff: toHandoff(data), created: true };
}

export async function addMessage(supabase, handoffId, { direction, via, author = null, text, staffChatId = null, staffMessageId = null }) {
  const { data, error } = await supabase
    .from('handoff_messages')
    .insert({ handoff_id: handoffId, direction, via, author, text: String(text).slice(0, 2000), staff_chat_id: staffChatId, staff_message_id: staffMessageId })
    .select('*')
    .single();
  if (error) return failed(error, 'add message');
  await supabase.from('handoffs').update({ updated_at: now() }).eq('id', handoffId);
  return toMessage(data);
}

// Remember which team-side message shows a thread entry, so a reply to that message finds the request.
export async function attachStaffMessage(supabase, messageRowId, { chatId, messageId }) {
  const { error } = await supabase.from('handoff_messages').update({ staff_chat_id: chatId, staff_message_id: messageId }).eq('id', messageRowId);
  if (error) failed(error, 'attach message');
}

export async function recordAlert(supabase, handoffId, { chatId, messageId }) {
  const { error } = await supabase.from('handoffs').update({ alert_chat_id: chatId, alert_message_id: messageId }).eq('id', handoffId);
  if (error) failed(error, 'record alert');
}

// The request a team-side message belongs to: the original alert, or a later message shown to the team.
export async function findByStaffMessage(supabase, chatId, messageId) {
  const { data: byAlert, error } = await supabase
    .from('handoffs')
    .select('*')
    .eq('alert_chat_id', chatId)
    .eq('alert_message_id', messageId)
    .limit(1);
  if (error) return failed(error, 'find alert');
  if (byAlert?.length) return toHandoff(byAlert[0]);

  const { data: byMessage, error: messageError } = await supabase
    .from('handoff_messages')
    .select('handoff_id')
    .eq('staff_chat_id', chatId)
    .eq('staff_message_id', messageId)
    .limit(1);
  if (messageError) return failed(messageError, 'find message');
  return byMessage?.length ? getHandoff(supabase, byMessage[0].handoff_id) : null;
}

export async function getHandoff(supabase, id) {
  const { data, error } = await supabase.from('handoffs').select('*').eq('id', id).maybeSingle();
  if (error) return failed(error, 'get request');
  return data ? toHandoff(data) : null;
}

export async function getThread(supabase, id) {
  const { data, error } = await supabase.from('handoff_messages').select('*').eq('handoff_id', id).order('created_at', { ascending: true });
  if (error) return failed(error, 'get thread') ?? [];
  return data.map(toMessage);
}

// The open request for a customer that the team has written to, so the customer's answer can be passed back.
export async function awaitingCustomer(supabase, customerId) {
  const { data, error } = await supabase
    .from('handoffs')
    .select('*')
    .eq('customer_id', customerId)
    .eq('status', 'waiting_customer')
    .order('updated_at', { ascending: false })
    .limit(1);
  if (error) return failed(error, 'find waiting request');
  return data?.length ? toHandoff(data[0]) : null;
}

export async function setStatus(supabase, id, status, by = null) {
  const patch = { status, updated_at: now(), ...(status === 'resolved' ? { resolved_at: now(), resolved_by: by } : { resolved_at: null, resolved_by: null }) };
  const { data, error } = await supabase.from('handoffs').update(patch).eq('id', id).select('*');
  if (error) return failed(error, 'set status');
  return data?.length ? toHandoff(data[0]) : null;
}

// `needsTeam` lists only the requests the team owes an answer to. `withWaiting` adds, for those, since when.
export async function listHandoffs(supabase, { status = null, limit = 100, needsTeam = false, withWaiting = false } = {}) {
  let query = supabase.from('handoffs').select('*');
  if (needsTeam) query = query.eq('status', 'open');
  else if (status === 'open') query = query.in('status', OPEN);
  else if (status) query = query.eq('status', status);
  const { data, error } = await query.order('created_at', { ascending: false }).limit(limit);
  if (error) return failed(error, 'list requests') ?? [];

  const ids = [...new Set(data.map((row) => row.customer_id))];
  const names = new Map();
  if (ids.length) {
    const { data: leads } = await supabase.from('customer_leads').select('customer_id,display_name,handle,is_test').in('customer_id', ids);
    for (const lead of leads ?? []) names.set(lead.customer_id, lead);
  }
  const waiting = new Map();
  if (withWaiting) {
    const open = data.filter((row) => row.status === 'open').map((row) => row.id);
    if (open.length) {
      const { data: messages } = await supabase.from('handoff_messages').select('handoff_id,direction,created_at').in('handoff_id', open).order('created_at', { ascending: true });
      const byRequest = new Map();
      for (const m of messages ?? []) (byRequest.get(m.handoff_id) ?? byRequest.set(m.handoff_id, []).get(m.handoff_id)).push({ direction: m.direction, createdAt: m.created_at });
      for (const [id, thread] of byRequest) waiting.set(id, waitingSince(thread));
    }
  }
  return data.map((row) => {
    const lead = names.get(row.customer_id);
    return {
      ...toHandoff(row),
      customerName: lead?.display_name ?? 'Unknown',
      customerHandle: lead?.handle ?? null,
      waitingSince: waiting.get(row.id) ?? null
    };
  });
}

export async function countOpen(supabase) {
  const { data, error } = await supabase.from('handoffs').select('id').in('status', OPEN).limit(500);
  if (error) return failed(error, 'count requests') ?? 0;
  return data.length;
}
