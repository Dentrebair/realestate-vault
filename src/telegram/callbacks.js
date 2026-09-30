// Button taps. None of these call the model.
import {
  addToShortlist,
  getLead,
  recordEvent,
  removeFromShortlist,
  setBotState,
  setStage
} from '../leadMemory.js';
import { getProperty, searchProperties } from '../propertySearch.js';
import { cardKeyboard } from './cards.js';
import { STALE_PROPERTY, SHARE_NUMBER_PROMPT, VISIT_ALREADY, visitRecorded } from './copy.js';
import { saveMessage } from './history.js';
import { ensureLead } from './lead.js';
import { rememberShown, sendSearchResult } from './present.js';
import { notifySales, visitAlert } from './sales.js';
import { Keyboard } from 'grammy';

const SHOWABLE = ['available', 'under_construction'];

export async function handleCallback(ctx, deps) {
  const match = /^action:(visit|save|unsave|more|browse)(?::(.+))?$/.exec(ctx.callbackQuery.data ?? '');
  let answer = {};

  try {
    if (!match) return;
    const [, action, arg] = match;
    const handlers = { visit, save, unsave, more, browse };
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

  const lead = await ensureLead(supabase, ctx.from);
  const customerId = lead.customerId;

  const { data: earlier, error } = await supabase
    .from('lead_events')
    .select('id')
    .eq('customer_id', customerId)
    .eq('event_type', 'site_visit_requested')
    .eq('property_id', propertyId)
    .limit(1);
  if (error) throw error;
  if (earlier.length) {
    await ctx.reply(VISIT_ALREADY);
    return { text: 'Already requested' };
  }

  await setStage(supabase, customerId, 'site_visit_ready', {
    actor: 'button',
    propertyId,
    reason: 'tapped Book Site Visit'
  });
  await recordEvent(supabase, customerId, 'site_visit_requested', { toStage: 'site_visit_ready', propertyId });

  const confirmation = visitRecorded(found.view.title, config.businessHours);
  await ctx.reply(confirmation);
  await saveMessage(supabase, customerId, 'assistant', confirmation, { visit: propertyId });

  if (!lead.phone) {
    await ctx.reply(SHARE_NUMBER_PROMPT, {
      reply_markup: new Keyboard().requestContact('📞 Share my number').oneTime().resized()
    });
  }

  const fresh = await getLead(supabase, customerId);
  const sent = await notifySales(api, config.salesDeskChatId, visitAlert(fresh, found.view));
  if (sent) {
    await supabase
      .from('lead_events')
      .update({ alerted_at: new Date().toISOString() })
      .eq('customer_id', customerId)
      .eq('event_type', 'site_visit_requested')
      .eq('property_id', propertyId);
  }
  return { text: 'Visit request noted' };
}

async function save(ctx, deps, propertyId) {
  const { supabase } = deps;
  const found = await getProperty(supabase, propertyId);
  if (!found || !SHOWABLE.includes(found.row.status)) return { text: STALE_PROPERTY, show_alert: true };

  const lead = await ensureLead(supabase, ctx.from);
  await addToShortlist(supabase, lead.customerId, propertyId);
  await swapKeyboard(ctx, propertyId, true);
  return { text: 'Saved to your shortlist ⭐' };
}

async function unsave(ctx, deps, propertyId) {
  const lead = await ensureLead(deps.supabase, ctx.from);
  await removeFromShortlist(deps.supabase, lead.customerId, propertyId);
  await swapKeyboard(ctx, propertyId, false);
  return { text: 'Removed from your shortlist' };
}

async function more(ctx, deps) {
  const { supabase, api } = deps;
  const lead = await ensureLead(supabase, ctx.from);
  const last = lead.botState?.lastSearch;
  if (!last || last.nextOffset === null || last.nextOffset === undefined) return { text: 'That is everything I have.' };

  const result = await searchProperties(supabase, {
    ...last.filters,
    customerId: lead.customerId,
    limit: 5,
    offset: last.nextOffset
  });
  const views = await sendSearchResult(api, ctx.chat.id, result, lead);
  await setBotState(supabase, lead.customerId, {
    shown: rememberShown(views),
    lastSearch: { filters: last.filters, nextOffset: result.nextOffset }
  });
  return {};
}

// Quick-pick category buttons from /start.
async function browse(ctx, deps, category) {
  const { supabase, api } = deps;
  const lead = await ensureLead(supabase, ctx.from);

  const filters = { category, limit: 5, offset: 0 };
  const result = await searchProperties(supabase, { ...filters, customerId: lead.customerId });
  const views = await sendSearchResult(api, ctx.chat.id, result, lead);

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

async function swapKeyboard(ctx, propertyId, saved) {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: cardKeyboard(propertyId, { saved }) });
  } catch (error) {
    // "message is not modified" when a button is tapped twice; nothing to fix.
    if (!/not modified/i.test(error.message)) throw error;
  }
}

