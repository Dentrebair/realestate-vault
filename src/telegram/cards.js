// Property cards and their buttons. Built in code from search results, never written by the model.
import { InlineKeyboard } from 'grammy';
import { escapeHtml as esc } from './html.js';

const MAX_HIGHLIGHTS = 4;

export function renderCard(view) {
  const tags = {
    recommendation: '💡 <b>Close option</b>',
    saved: '⭐ <b>Your shortlist</b>',
    match: '✅ <b>Matches your requirements</b>'
  };
  const lines = [
    tags[view.kind] ?? tags.match,
    `<b>${esc(view.title)}</b>`,
    `📍 ${esc(view.location)}`,
    `💰 ${esc(view.priceDisplay)}`
  ];

  const facts = [];
  if (view.bedrooms) facts.push(`${view.bedrooms} BHK`);
  if (view.status !== 'available') facts.push(esc(view.statusLabel));
  if (facts.length) lines.push(`🏠 ${facts.join(' · ')}`);

  for (const h of view.highlights.slice(0, MAX_HIGHLIGHTS)) {
    lines.push(`• ${esc(h.label)}: ${esc(h.value)}`);
  }
  if (view.rera) lines.push(`RERA: ${esc(view.rera)}`);
  if (view.differences.length) {
    lines.push(`⚠️ <i>How it differs:</i> ${view.differences.map(esc).join('; ')}`);
  }
  return lines.join('\n');
}

export function cardKeyboard(propertyId, { saved = false } = {}) {
  const keyboard = new InlineKeyboard().text('📅 Book Site Visit', `action:visit:${propertyId}`);
  return saved
    ? keyboard.text('✅ Saved (remove)', `action:unsave:${propertyId}`)
    : keyboard.text('⭐ Shortlist', `action:save:${propertyId}`);
}

export function moreKeyboard() {
  return new InlineKeyboard().text('➡️ Show more', 'action:more');
}

export function browseKeyboard() {
  return new InlineKeyboard()
    .text('🏠 Flats & villas', 'action:browse:residential')
    .text('🏢 Shops & offices', 'action:browse:commercial')
    .row()
    .text('🌳 Plots & land', 'action:browse:land')
    .text('🏨 Hotels', 'action:browse:hospitality')
    .row()
    .text('🏭 Industrial', 'action:browse:industrial');
}

// A single confirmation prompt, used when the Lead says they want to visit.
export function visitPrompt(view) {
  return {
    text: `Would you like to visit <b>${esc(view.title)}</b> (${esc(view.location)})?`,
    keyboard: new InlineKeyboard().text('📅 Confirm site visit', `action:visit:${view.id}`)
  };
}
