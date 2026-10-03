// Alerts to the Sales desk: a Telegram chat whose id is SALES_DESK_CHAT_ID.
import { formatInr } from '../money.js';
import { getLead } from '../leadMemory.js';
import { getProperty } from '../propertySearch.js';
import { escapeHtml as esc } from './html.js';
import { log } from './log.js';

// Sends one alert. Returns the message Telegram created (truthy) or false, so a reply to it can be matched to a request.
export async function notifySales(api, chatId, html, options = {}) {
  if (!chatId) {
    console.warn('SALES_DESK_CHAT_ID is not set; alert not sent.');
    return false;
  }
  try {
    const message = await api.sendMessage(chatId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...options });
    return message ?? true;
  } catch (error) {
    console.error('Sales desk alert failed:', error.message);
    return false;
  }
}

export function visitAlert(lead, view) {
  const budget = [lead.budgetMin && formatInr(lead.budgetMin), lead.budgetMax && formatInr(lead.budgetMax)]
    .filter(Boolean)
    .join(' to ');
  const who = [
    `<b>${esc(lead.displayName ?? 'Unknown')}</b>`,
    lead.handle ? `@${esc(lead.handle)}` : null,
    `ID ${esc(lead.customerId.replace(/^telegram:/, ''))}`
  ].filter(Boolean);

  const lines = [
    `${lead.isTest ? '[TEST] ' : ''}🔔 <b>Site visit requested</b>`,
    who.join(' · '),
    lead.phone ? `📞 ${esc(lead.phone)}` : '📞 No number shared yet',
    budget ? `Budget: ${esc(budget)}` : null,
    lead.preferredLocations?.length ? `Areas: ${esc(lead.preferredLocations.join(', '))}` : null,
    lead.urgency ? `Timeline: ${esc(lead.urgency)}` : null,
    `Property: <b>${esc(view.title)}</b>`,
    `${esc(view.location)} · ${esc(view.priceDisplay)}`
  ];
  return lines.filter(Boolean).join('\n');
}

export function failureAlert(lead, reason) {
  return `⚠️ <b>The assistant could not answer a customer</b>\n${esc(lead.displayName ?? 'Unknown')} · ${esc(lead.customerId)}\nReason: ${esc(reason)}`;
}

// A visit request whose alert did not reach the Sales desk is sent again until it does, for up to a day.
// The first attempt has had two minutes before this looks at it, so the two never overlap.
export async function resendVisitAlerts({ supabase, api, chatId, now = () => Date.now() }) {
  if (!chatId) return 0;
  const from = new Date(now() - 24 * 3600 * 1000).toISOString();
  const before = new Date(now() - 2 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('lead_events')
    .select('id,customer_id,property_id')
    .eq('event_type', 'site_visit_requested')
    .is('alerted_at', null)
    .gt('created_at', from)
    .lt('created_at', before)
    .limit(20);
  if (error) {
    log('alert_retry_failed', { error: error.message }, 'error');
    return 0;
  }

  let sent = 0;
  for (const event of data) {
    const [lead, found] = await Promise.all([getLead(supabase, event.customer_id), getProperty(supabase, event.property_id)]);
    if (!lead || !found) continue;
    if (await notifySales(api, chatId, visitAlert(lead, found.view))) {
      await supabase.from('lead_events').update({ alerted_at: new Date(now()).toISOString() }).eq('id', event.id);
      sent++;
    }
  }
  if (sent) log('visit_alerts_resent', { count: sent });
  return sent;
}

export function startAlertRetry({ supabase, api, chatId, everyMs = 60 * 1000 }) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await resendVisitAlerts({ supabase, api, chatId });
    } catch (error) {
      log('alert_retry_failed', { error: error.message }, 'error');
    } finally {
      running = false;
    }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
