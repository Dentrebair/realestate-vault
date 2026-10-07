// Button taps. None of these call the model.
import {
  addToShortlist,
  getLead,
  recordConsent,
  removeFromShortlist,
  setBotState,
  setStage
} from '../leadMemory.js';
import { loadPhotos } from '../photos.js';
import { getProperty, searchProperties } from '../propertySearch.js';
import { eraseCustomer } from '../privacy.js';
import { browseKeyboard, cardKeyboard } from './cards.js';
import { CONSENT_NEEDED, FORGET_CANCELLED, FORGOTTEN, consentPrompt, needsConsent, privacyNotice } from './consent.js';
import { STALE_PROPERTY, VISIT_ALREADY, welcome } from './copy.js';
import { saveMessage } from './history.js';
import { customerIdOf, ensureLead } from './lead.js';
import { rememberShown, sendSearchResult } from './present.js';
import { resolveFromTelegram } from './handoff.js';
import { startVisit } from './visits.js';
import { Keyboard } from 'grammy';

const SHOWABLE = ['available', 'under_construction'];

export async function handleCallback(ctx, deps) {
  const match = /^action:(visit|save|unsave|more|browse|ph|noop|consent|privacy|forget|resolve)(?::(.+))?$/.exec(ctx.callbackQuery.data ?? '');
  let answer = {};

  try {
    if (!match) return;
    const [, action, arg] = match;

    // The team's button is not a customer action, so it never waits for consent.
    if (action === 'resolve') {
      answer = await resolveFromTelegram(ctx, deps, arg);
      return;
    }

    // Everything except agreeing, reading the notice and deleting data waits for consent.
    if (!['consent', 'privacy', 'forget', 'noop'].includes(action)) {
      const lead = await ensureLead(deps.supabase, ctx.from, { config: deps.config });
      if (needsConsent(lead, deps.config)) {
        const prompt = consentPrompt(deps.config);
        await ctx.reply(prompt.text, { reply_markup: prompt.keyboard });
        answer = { text: CONSENT_NEEDED, show_alert: true };
        return;
      }
    }

    const handlers = { visit, save, unsave, more, browse, ph: gallery, noop: async () => ({}), consent, privacy, forget };
    answer = (await handlers[action](ctx, deps, arg)) ?? {};
  } finally {
    // Always answer, or the button keeps spinning.
    await ctx.answerCallbackQuery(answer).catch(() => {});
  }
}

async function visit(ctx, deps, propertyId) {
  const { supabase, api, config } = deps;
  const found = await getProperty(supabase, propertyId);
  if (!found || !SHOWABLE.includes(found.row.status)) return { text: STALE_PROPERTY, show_alert: true };

  const lead = await ensureLead(supabase, ctx.from, { config: deps.config });
  const customerId = lead.customerId;

  const { data: earlier, error } = await supabase
    .from('lead_events')
    .select('id,alerted_at')
    .eq('customer_id', customerId)
    .eq('event_type', 'site_visit_requested')
    .eq('property_id', propertyId)
    .limit(5);
  if (error) throw error;

  // "Already asked" is only true if the team was told. A request whose alert never arrived is sent again now.
  if (earlier.some((e) => e.alerted_at)) {
    await ctx.reply(VISIT_ALREADY);
    return { text: 'Already requested' };
  }

  return startVisit(ctx, deps, lead, found, propertyId);
}

async function save(ctx, deps, propertyId) {
  const { supabase } = deps;
  const found = await getProperty(supabase, propertyId);
  if (!found || !SHOWABLE.includes(found.row.status)) return { text: STALE_PROPERTY, show_alert: true };

  const lead = await ensureLead(supabase, ctx.from, { config: deps.config });
  await addToShortlist(supabase, lead.customerId, propertyId);
  await swapKeyboard(ctx, propertyId, true);
  return { text: 'Saved to your shortlist ⭐' };
}

async function unsave(ctx, deps, propertyId) {
  const lead = await ensureLead(deps.supabase, ctx.from, { config: deps.config });
  await removeFromShortlist(deps.supabase, lead.customerId, propertyId);
  await swapKeyboard(ctx, propertyId, false);
  return { text: 'Removed from your shortlist' };
}

async function more(ctx, deps) {
  const { supabase, api } = deps;
  const lead = await ensureLead(supabase, ctx.from, { config: deps.config });
  const last = lead.botState?.lastSearch;
  if (!last || last.nextOffset === null || last.nextOffset === undefined) return { text: 'That is everything I have.' };

  const result = await searchProperties(supabase, {
    ...last.filters,
    customerId: lead.customerId,
    limit: 5,
    offset: last.nextOffset
  });
  const views = await sendSearchResult({ api, supabase, chatId: ctx.chat.id, result, lead });
  await setBotState(supabase, lead.customerId, {
    shown: rememberShown(views),
    lastSearch: { filters: last.filters, nextOffset: result.nextOffset }
  });
  return {};
}

// Quick-pick category buttons from /start.
async function browse(ctx, deps, category) {
  const { supabase, api } = deps;
  const lead = await ensureLead(supabase, ctx.from, { config: deps.config });

  const filters = { category, limit: 5, offset: 0 };
  const result = await searchProperties(supabase, { ...filters, customerId: lead.customerId });
  const views = await sendSearchResult({ api, supabase, chatId: ctx.chat.id, result, lead });

  await setBotState(supabase, lead.customerId, {
    scope: 'on_topic',
    shown: rememberShown(views),
    lastSearch: { filters: { category }, nextOffset: result.nextOffset }
  });
  if (views.length) {
    await setStage(supabase, lead.customerId, 'interested', { actor: 'system', reason: 'browsed a category' });
  }

  const followUp = views.length
    ? 'Tell me your budget and preferred area and I will narrow these down.'
    : 'I do not have anything in that category right now. Tell me what else you are looking for.';
  await ctx.reply(followUp);
  await saveMessage(supabase, lead.customerId, 'assistant', followUp, { shown: views.map((v) => v.id) });
  return {};
}

// Steps through a property's photos by swapping the picture in place. The caption, with its formatting, is reused.
async function gallery(ctx, deps, arg) {
  const at = arg.lastIndexOf(':');
  const propertyId = arg.slice(0, at);
  const requested = Number(arg.slice(at + 1));

  const photos = (await loadPhotos(deps.supabase, [propertyId])).get(propertyId) ?? [];
  const message = ctx.callbackQuery.message;
  if (!photos.length || !message?.caption) return { text: 'No photos to show.' };

  const index = ((Number.isInteger(requested) ? requested : 0) % photos.length + photos.length) % photos.length;
  const lead = await ensureLead(deps.supabase, ctx.from, { config: deps.config });
  const saved = (lead.shortlistedPropertyIds ?? []).includes(propertyId);

  try {
    await ctx.editMessageMedia(
      { type: 'photo', media: photos[index].url, caption: message.caption, caption_entities: message.caption_entities },
      { reply_markup: cardKeyboard(propertyId, { saved, photo: { index, total: photos.length } }) }
    );
  } catch (error) {
    if (!/not modified/i.test(error.message)) throw error;
  }
  return {};
}

// Swaps Shortlist and Saved on the first row only, so a photo card keeps its ◀ 2/5 ▶ row.
async function swapKeyboard(ctx, propertyId, saved) {
  try {
    const rows = ctx.callbackQuery.message?.reply_markup?.inline_keyboard ?? [];
    const first = cardKeyboard(propertyId, { saved }).inline_keyboard[0];
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [first, ...rows.slice(1)] } });
  } catch (error) {
    // "message is not modified" when a button is tapped twice; nothing to fix.
    if (!/not modified/i.test(error.message)) throw error;
  }
}


async function consent(ctx, deps) {
  const lead = await ensureLead(deps.supabase, ctx.from, { config: deps.config });
  if (lead.consentAt) return { text: 'You have already agreed.' };

  await recordConsent(deps.supabase, lead.customerId, {
    version: deps.config.consentVersion,
    from: ctx.from,
    source: lead.botState?.pendingSource
  });
  await setBotState(deps.supabase, lead.customerId, { scope: 'on_topic', pendingSource: null });
  await ctx.reply(welcome(ctx.from.first_name), { reply_markup: browseKeyboard() });
  return { text: 'Thank you' };
}

async function privacy(ctx, deps) {
  await ctx.reply(privacyNotice(deps.config));
  return {};
}

async function forget(ctx, deps, choice) {
  if (choice !== 'yes') {
    await ctx.reply(FORGET_CANCELLED);
    return {};
  }
  await eraseCustomer(deps.supabase, customerIdOf(ctx.from), { reason: 'customer_request' });
  await ctx.reply(FORGOTTEN);
  return { text: 'Deleted' };
}
