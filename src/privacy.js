// What we keep about a customer, and how it leaves: asking to see it, asking to delete it, and the retention clock.
import { createHash } from 'node:crypto';
import { formatInr } from './money.js';
import { getProperty } from './propertySearch.js';

const hash = (customerId) => createHash('sha256').update(String(customerId)).digest('hex');

export function describePeriod(hours) {
  if (hours < 48) return `${Math.round(hours)} hours`;
  const days = hours / 24;
  if (days < 60) return `${Math.round(days)} days`;
  const months = Math.round(days / 30);
  return months >= 24 ? `${Math.round(months / 12)} years` : `${months} months`;
}

// Deletes a customer and everything that hangs off them. Returns counts of what was removed.
export async function eraseCustomer(supabase, customerId, { reason }) {
  const count = async (table, column = 'customer_id') => {
    const { count: n, error } = await supabase.from(table).select('*', { count: 'exact', head: true }).eq(column, customerId);
    if (error) throw error;
    return n ?? 0;
  };

  const removed = {
    messages: await count('chat_messages'),
    events: await count('lead_events'),
    knowledgeGaps: await count('knowledge_gaps').catch(() => 0),
    requests: await count('handoffs').catch(() => 0)
  };

  // Gaps carry the customer's own words, and have no foreign key, so they are removed here.
  const { error: gapError } = await supabase.from('knowledge_gaps').delete().eq('customer_id', customerId);
  if (gapError && !/knowledge_gaps/.test(gapError.message)) throw gapError;

  // Messages and events go with the lead (they are tied to it by a foreign key with cascade).
  const { error } = await supabase.from('customer_leads').delete().eq('customer_id', customerId);
  if (error) throw error;

  await supabase.from('deletion_log').insert({ customer_ref: hash(customerId), reason, removed }).then(({ error: logError }) => {
    if (logError) console.error('Could not write the deletion log:', logError.message);
  });
  return removed;
}

// A plain list of what we hold about this customer, for /mydata.
export async function describeCustomerData(supabase, lead) {
  const { count: messages } = await supabase.from('chat_messages').select('*', { count: 'exact', head: true }).eq('customer_id', lead.customerId);
  const { count: requests } = await supabase.from('handoffs').select('*', { count: 'exact', head: true }).eq('customer_id', lead.customerId);

  const titles = [];
  for (const id of lead.shortlistedPropertyIds ?? []) {
    const found = await getProperty(supabase, id).catch(() => null);
    if (found) titles.push(found.row.title);
  }

  const budget = [lead.budgetMin && formatInr(lead.budgetMin), lead.budgetMax && formatInr(lead.budgetMax)].filter(Boolean).join(' to ');
  const lines = [
    `Name shown on Telegram: ${lead.displayName ?? 'not stored'}`,
    `Telegram username: ${lead.handle ? `@${lead.handle}` : 'not stored'}`,
    `Phone number: ${lead.phone ?? 'not shared'}`,
    `What you told us: ${[
      lead.bedrooms && `${lead.bedrooms} bedrooms`,
      lead.propertyCategories?.length && lead.propertyCategories.join(', '),
      lead.preferredLocations?.length && `in ${lead.preferredLocations.join(', ')}`,
      budget && `budget ${budget}`,
      lead.urgency && `timeline ${lead.urgency}`
    ].filter(Boolean).join(', ') || 'nothing yet'}`,
    `Shortlisted: ${titles.length ? titles.join('; ') : 'nothing'}`,
    `Messages we hold: ${messages ?? 0}`,
    `Requests passed to our team: ${requests ?? 0}`,
    `Agreed to the privacy notice: ${lead.consentAt ? lead.consentAt.slice(0, 10) : 'not yet'}`
  ];
  return lines.join('\n');
}

// Deletes what has outlived its time. Test leads are exempt. Returns what was removed.
export async function runRetention(supabase, { chatHours, leadHours, now = Date.now() }) {
  const chatCutoff = new Date(now - chatHours * 3600000).toISOString();
  const leadCutoff = new Date(now - leadHours * 3600000).toISOString();

  const { data: oldMessages, error: messagesError } = await supabase.from('chat_messages').delete().lt('created_at', chatCutoff).select('id');
  if (messagesError) throw messagesError;

  // Requests passed to the team hold the customer's words too, so they follow the same clock as the conversation.
  // A missing table (before sql/007) is not an error here.
  const { data: oldRequests, error: requestsError } = await supabase.from('handoffs').delete().lt('updated_at', chatCutoff).select('id');
  if (requestsError && !/handoffs|schema cache|does not exist/i.test(requestsError.message)) throw requestsError;

  const { data: stale, error: staleError } = await supabase
    .from('customer_leads')
    .select('customer_id')
    .eq('is_test', false)
    .lt('last_contacted_at', leadCutoff)
    .limit(500);
  if (staleError) throw staleError;

  let leads = 0;
  for (const { customer_id: id } of stale) {
    await eraseCustomer(supabase, id, { reason: 'retention' });
    leads += 1;
  }
  return { messages: oldMessages.length, requests: oldRequests?.length ?? 0, leads };
}

export function startRetention(supabase, config, log = console.log) {
  const run = async () => {
    try {
      const done = await runRetention(supabase, { chatHours: config.chatRetentionHours, leadHours: config.leadRetentionHours });
      if (done.messages || done.leads) log(JSON.stringify({ at: new Date().toISOString(), event: 'retention', ...done }));
    } catch (error) {
      console.error('Retention run failed:', error.message);
    }
  };
  const first = setTimeout(run, 60 * 1000);
  const every = setInterval(run, 6 * 3600 * 1000);
  first.unref();
  every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
