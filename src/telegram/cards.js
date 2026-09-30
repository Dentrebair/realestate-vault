// Property cards and their buttons. Built in code from search results, never written by the model.
import { InlineKeyboard } from 'grammy';
import { escapeHtml as esc } from './html.js';

const MAX_HIGHLIGHTS = 4;

// A photo caption may be at most 1024 characters. Optional lines are dropped from the end until it fits.
export const CAPTION_LIMIT = 1000;

export function renderCard(view, { maxLength } = {}) {
  let highlights = MAX_HIGHLIGHTS;
  let text = buildCard(view, highlights);
  while (maxLength && text.length > maxLength && highlights > 0) text = buildCard(view, --highlights);
  return maxLength && text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function buildCard(view, highlightCount) {
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

  for (const h of view.highlights.slice(0, highlightCount)) {
    lines.push(`• ${esc(h.label)}: ${esc(h.value)}`);
  }
  if (view.rera) lines.push(`RERA: ${esc(view.rera)}`);
  if (view.differences.length) {
    lines.push(`⚠️ <i>How it differs:</i> ${view.differences.map(esc).join('; ')}`);
  }
  return lines.join('\n');
}

// `photo` is { index, total } when the card is a photo with a gallery: a second row steps through it.
export function cardKeyboard(propertyId, { saved = false, photo = null } = {}) {
  const keyboard = new InlineKeyboard().text('📅 Book Site Visit', `action:visit:${propertyId}`);
  if (saved) keyboard.text('✅ Saved (remove)', `action:unsave:${propertyId}`);
  else keyboard.text('⭐ Shortlist', `action:save:${propertyId}`);

  if (photo && photo.total > 1) {
    const step = (to) => `action:ph:${propertyId}:${(to + photo.total) % photo.total}`;
    keyboard
      .row()
      .text('◀', step(photo.index - 1))
      .text(`📷 ${photo.index + 1}/${photo.total}`, 'action:noop')
      .text('▶', step(photo.index + 1));
  }
  return keyboard;
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
