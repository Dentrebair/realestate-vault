// Passing a customer to the team, and passing the team's answer back.
//
//   raiseHandoff     the bot tells the team (a Telegram alert) and keeps a request on the board
//   staffReply       the team replies to an alert on Telegram; the customer receives it
//   replyToCustomer  the same, used by the board too
//   relayCustomer    the customer answers; the team sees it on the same thread
//
// Without sql/007 there is no request on the board, but the alert still goes to Telegram, as before.
import {
  OPEN, addMessage, attachStaffMessage, awaitingCustomer, findByStaffMessage, getHandoff, openHandoff, recordAlert, setStatus
} from '../handoff.js';
import { formatInr } from '../money.js';
import { TEAM_PREFIX } from './copy.js';
import { escapeHtml as esc } from './html.js';
import { saveMessage } from './history.js';
import { log } from './log.js';
import { notifySales, visitAlert } from './sales.js';

export const staffIds = (config) =>
  config.staffTelegramIds?.length ? config.staffTelegramIds : config.salesDeskChatId > 0 ? [config.salesDeskChatId] : [];

const HEADINGS = {
  visit: '🔔 <b>Site visit requested</b>',
  callback: '📞 <b>Asked to talk to the team</b>',
  offer: '💰 <b>Price offer</b>',
  question: '❓ <b>Question the assistant could not answer</b>'
};

function who(lead) {
  return [
    `<b>${esc(lead.displayName ?? 'Unknown')}</b>`,
    lead.handle ? `@${esc(lead.handle)}` : null,
    `ID ${esc(lead.customerId.replace(/^(telegram|test):/, ''))}`
  ].filter(Boolean).join(' · ');
}

function alertText({ lead, kind, summary, property, handoff }) {
  if (kind === 'visit' && property) {
    return `${visitAlert(lead, property)}${handoff ? `\nRequest #${handoff.id}` : ''}\n\n↩️ Reply to this message to answer the customer.`;
  }
  const budget = [lead.budgetMin && formatInr(lead.budgetMin), lead.budgetMax && formatInr(lead.budgetMax)].filter(Boolean).join(' to ');
  return [
    `${lead.isTest ? '[TEST] ' : ''}${HEADINGS[kind]}${handoff ? ` · #${handoff.id}` : ''}`,
    who(lead),
    lead.phone ? `📞 ${esc(lead.phone)}` : '📞 No number shared yet',
    property ? `Property: <b>${esc(property.title)}</b> · ${esc(property.priceDisplay)}` : null,
    budget ? `Budget: ${esc(budget)}` : null,
    esc(summary),
    '\n↩️ Reply to this message to answer the customer.'
  ].filter(Boolean).join('\n');
}

const resolveKeyboard = (id) => ({ inline_keyboard: [[{ text: '✅ Mark resolved', callback_data: `action:resolve:${id}` }]] });

// Returns { handoff, alerted }: the request kept on the board (null before sql/007) and whether the team was told.
export async function raiseHandoff({ deps, lead, kind, summary, property = null }) {
  const { supabase, api, config } = deps;
  let opened = null;
  try {
    opened = await openHandoff(supabase, { customerId: lead.customerId, kind, summary, propertyId: property?.id ?? property?.property_id ?? null, isTest: lead.isTest === true });
  } catch (error) {
    log('handoff_failed', { customerId: lead.customerId, error: error.message }, 'error');
  }
  const handoff = opened?.handoff ?? null;

  // A follow-up on a request the team has already been told about: show it under the original alert.
  const followUp = handoff && !opened.created && handoff.alertMessageId;
  const text = followUp
    ? `➕ <b>${esc(lead.displayName ?? 'Customer')}</b> · #${handoff.id}\n${esc(summary)}`
    : alertText({ lead, kind, summary, property, handoff });
  const sent = await notifySales(api, config.salesDeskChatId, text, {
    ...(handoff && !followUp ? { reply_markup: resolveKeyboard(handoff.id) } : {}),
    ...(followUp ? { reply_parameters: { message_id: handoff.alertMessageId, allow_sending_without_reply: true } } : {})
  });

  if (handoff && sent?.message_id) {
    try {
      if (followUp) {
        if (opened.messageId) await attachStaffMessage(supabase, opened.messageId, { chatId: sent.chat?.id ?? config.salesDeskChatId, messageId: sent.message_id });
      } else {
        await recordAlert(supabase, handoff.id, { chatId: sent.chat?.id ?? config.salesDeskChatId, messageId: sent.message_id });
      }
    } catch (error) {
      log('handoff_alert_not_recorded', { handoffId: handoff.id, error: error.message }, 'error');
    }
  }
  return { handoff, alerted: Boolean(sent), message: sent || null };
}

const toChatId = (customerId) => {
  const match = /^telegram:(\d+)$/.exec(customerId);
  return match ? Number(match[1]) : null;
};

// Sends the team's words to the customer and records them. `via` is 'telegram' or 'board'. Returns { delivered, reason }.
export async function replyToCustomer({ deps, handoff, text, by, via }) {
  const { supabase, api, config } = deps;
  const body = String(text ?? '').trim().slice(0, 1500);
  if (!body) return { delivered: false, reason: 'The message is empty.' };

  const chatId = toChatId(handoff.customerId);
  let delivered = false;
  let reason = null;
  if (chatId) {
    try {
      await api.sendMessage(chatId, `📩 <b>Message from our team</b>\n${esc(body)}`, { parse_mode: 'HTML' });
      delivered = true;
    } catch (error) {
      reason = error.description ?? error.message;
      log('handoff_delivery_failed', { handoffId: handoff.id, error: reason }, 'error');
    }
  } else {
    reason = 'This is a test lead, so nothing was sent to a real chat.';
  }

  await addMessage(supabase, handoff.id, { direction: 'staff', via, author: by, text: body });
  // The assistant reads the conversation, so it must know what the team said.
  await saveMessage(supabase, handoff.customerId, 'assistant', `${TEAM_PREFIX}${body}`, { team: true }).catch((error) => log('team_message_not_saved', { handoffId: handoff.id, error: error.message }, 'error'));
  // Writing to the customer reopens a resolved request, so their answer comes back to the team.
  await setStatus(supabase, handoff.id, 'waiting_customer');

  // A reply written on the board is shown to the team on Telegram too, under the original alert.
  if (via === 'board' && config.salesDeskChatId) {
    await notifySales(api, config.salesDeskChatId, `💬 <b>${esc(by ?? 'The board')}</b> replied on the board · #${handoff.id}\n${esc(body)}`, {
      reply_parameters: handoff.alertMessageId ? { message_id: handoff.alertMessageId, allow_sending_without_reply: true } : undefined
    });
  }
  return { delivered, reason };
}

// A message from a team account. Returns true when it was a reply to an alert and has been dealt with.
export async function staffReply(ctx, deps) {
  const { supabase, config } = deps;
  const replied = ctx.message?.reply_to_message;
  if (!replied || !staffIds(config).includes(ctx.from?.id)) return false;

  const handoff = await findByStaffMessage(supabase, ctx.chat.id, replied.message_id).catch(() => null);
  if (!handoff) return false;

  const result = await replyToCustomer({ deps, handoff, text: ctx.message.text, by: `telegram:${ctx.from.id}`, via: 'telegram' });
  await ctx.reply(
    result.delivered
      ? `✅ Sent. Request #${handoff.id} now waits for the customer.`
      : `⚠️ Saved on request #${handoff.id}, but not delivered: ${result.reason}`,
    { reply_parameters: { message_id: ctx.message.message_id } }
  );
  return true;
}

// The customer writes after the team has: show their words to the team on the same thread.
export async function relayCustomer({ deps, lead, text }) {
  const { supabase, api, config } = deps;
  const handoff = await awaitingCustomer(supabase, lead.customerId).catch(() => null);
  if (!handoff) return null;

  const sent = await notifySales(api, config.salesDeskChatId, `💬 <b>${esc(lead.displayName ?? 'Customer')}</b> · #${handoff.id}\n${esc(text)}`, {
    reply_parameters: handoff.alertMessageId ? { message_id: handoff.alertMessageId, allow_sending_without_reply: true } : undefined
  });
  await addMessage(supabase, handoff.id, {
    direction: 'customer', via: 'bot', text,
    staffChatId: sent?.chat?.id ?? (sent ? config.salesDeskChatId : null),
    staffMessageId: sent?.message_id ?? null
  });
  if (handoff.status !== 'open') await setStatus(supabase, handoff.id, 'open');
  return handoff;
}

// The "Mark resolved" button on an alert.
export async function resolveFromTelegram(ctx, deps, id) {
  if (!staffIds(deps.config).includes(ctx.from?.id)) return { text: 'Only the team can do this.', show_alert: true };
  const handoff = await setStatus(deps.supabase, Number(id), 'resolved', `telegram:${ctx.from.id}`);
  if (!handoff) return { text: 'That request no longer exists.', show_alert: true };
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
  return { text: `Request #${handoff.id} marked resolved` };
}

export { OPEN, getHandoff };
