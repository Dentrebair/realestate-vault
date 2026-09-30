// Alerts to the Sales desk: a Telegram chat whose id is SALES_DESK_CHAT_ID.
import { formatInr } from '../money.js';
import { escapeHtml as esc } from './html.js';

export async function notifySales(api, chatId, html) {
  if (!chatId) {
    console.warn('SALES_DESK_CHAT_ID is not set; alert not sent.');
    return false;
  }
  try {
    await api.sendMessage(chatId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    return true;
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
