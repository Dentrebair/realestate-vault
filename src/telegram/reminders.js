// A customer was told "our team will reply here". This makes sure someone notices when that is taking too long.
//
//   at the reply time (30 minutes for a visit, 2 hours for the rest): remind the team
//   after a day: remind the team again, and tell the customer once that the team has not replied yet
//
// Only inside business hours, and once per wait: when the team answers and the customer replies, a new wait begins.
import { formatWait, listHandoffs, replyMinutes } from '../handoff.js';
import { inBusinessHours } from '../businessHours.js';
import { recordEvent } from '../leadMemory.js';
import { escapeHtml as esc } from './html.js';
import { saveMessage } from './history.js';
import { log } from './log.js';
import { notifySales } from './sales.js';

const TEAM = 'handoff_reminder';
const CUSTOMER = 'handoff_customer_notice';

async function alreadySent(supabase, customerId, type, handoffId, since) {
  const { data, error } = await supabase.from('lead_events').select('payload').eq('customer_id', customerId).eq('event_type', type).limit(50);
  if (error) throw error;
  return data.some((e) => e.payload?.handoffId === handoffId && e.payload?.since === since);
}

export async function sendReminders({ supabase, api, config, now = new Date() }) {
  const result = { reminded: 0, notified: 0 };
  if (!config.salesDeskChatId || !inBusinessHours(now, config)) return result;

  const waiting = (await listHandoffs(supabase, { needsTeam: true, withWaiting: true, limit: 100 })).filter((h) => h.waitingSince);
  for (const h of waiting) {
    const minutes = (now.getTime() - Date.parse(h.waitingSince)) / 60000;
    if (minutes < replyMinutes(h.kind, config)) continue;
    const overADay = minutes >= config.holdingNoticeHours * 60;

    const level = overADay ? 2 : 1;
    if (!(await alreadySent(supabase, h.customerId, TEAM, h.id, h.waitingSince + `#${level}`))) {
      const sent = await notifySales(
        api,
        config.salesDeskChatId,
        `⏰ <b>Customer waiting ${esc(formatWait(minutes))}</b> · request #${h.id}\n<b>${esc(h.customerName)}</b>: ${esc(h.summary)}\n\n↩️ Reply to the alert to answer.`,
        { reply_parameters: h.alertMessageId ? { message_id: h.alertMessageId, allow_sending_without_reply: true } : undefined }
      );
      if (sent) {
        await recordEvent(supabase, h.customerId, TEAM, { note: `request #${h.id}, waiting ${formatWait(minutes)}`, payload: { handoffId: h.id, since: h.waitingSince + `#${level}` } });
        result.reminded++;
      }
    }

    // After a day the customer is told, once, so they are not left wondering.
    const chatId = /^telegram:(\d+)$/.exec(h.customerId)?.[1];
    if (overADay && chatId && !(await alreadySent(supabase, h.customerId, CUSTOMER, h.id, h.waitingSince))) {
      const text = `Our team has not replied yet. They are available ${config.businessHours}. Your request is still open.`;
      try {
        await api.sendMessage(Number(chatId), text);
        await saveMessage(supabase, h.customerId, 'assistant', text).catch(() => {});
        await recordEvent(supabase, h.customerId, CUSTOMER, { note: `request #${h.id}`, payload: { handoffId: h.id, since: h.waitingSince } });
        result.notified++;
      } catch (error) {
        log('customer_notice_failed', { handoffId: h.id, error: error.description ?? error.message }, 'error');
      }
    }
  }
  if (result.reminded || result.notified) log('reminders_sent', result);
  return result;
}

export function startReminders({ supabase, api, config, everyMs = 60 * 1000 }) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await sendReminders({ supabase, api, config });
    } catch (error) {
      log('reminders_failed', { error: error.message }, 'error');
    } finally {
      running = false;
    }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
