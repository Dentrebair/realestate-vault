// Slash commands and the messages that are not plain text.
import { setBotState, setStage, upsertLeadMemory } from '../leadMemory.js';
import { getProperty } from '../propertySearch.js';
import { browseKeyboard } from './cards.js';
import { loadPhotos } from '../photos.js';
import { sendCard } from './present.js';
import { describeCustomerData } from '../privacy.js';
import { FORGET_ASK, consentPrompt, forgetKeyboard, needsConsent, privacyNotice } from './consent.js';
import { HELP, NO_SAVED, PHONE_THANKS, RESET_DONE, welcome } from './copy.js';
import { clearHistory } from './history.js';
import { customerIdOf, ensureLead } from './lead.js';
import { notifySales } from './sales.js';
import { escapeHtml } from './html.js';

const SHOWABLE = ['available', 'under_construction'];

export async function start(ctx, deps) {
  // A deep link such as t.me/bot?start=omr_ad1 tells us which campaign brought the Lead.
  const source = typeof ctx.match === 'string' && ctx.match.trim() ? ctx.match.trim().slice(0, 60) : undefined;
  const lead = await ensureLead(deps.supabase, ctx.from, { source, config: deps.config });
  if (needsConsent(lead, deps.config)) return askConsent(ctx, deps);
  await setBotState(deps.supabase, lead.customerId, { scope: 'on_topic' });
  await ctx.reply(welcome(ctx.from.first_name), { reply_markup: browseKeyboard() });
}

async function askConsent(ctx, deps) {
  const prompt = consentPrompt(deps.config);
  await ctx.reply(prompt.text, { reply_markup: prompt.keyboard });
}

export async function privacy(ctx, deps) {
  await ctx.reply(privacyNotice(deps.config));
}

export async function mydata(ctx, deps) {
  const lead = await ensureLead(deps.supabase, ctx.from, { config: deps.config });
  if (needsConsent(lead, deps.config)) {
    return ctx.reply('You have not agreed to the privacy notice yet, so we hold only your Telegram id and nothing else.');
  }
  await ctx.reply(`What we hold about you:\n\n${await describeCustomerData(deps.supabase, lead)}\n\nSend /forget to delete it all.`);
}

export async function forget(ctx) {
  await ctx.reply(FORGET_ASK, { reply_markup: forgetKeyboard() });
}

export async function help(ctx) {
  await ctx.reply(HELP);
}

export async function reset(ctx, deps) {
  const customerId = customerIdOf(ctx.from);
  const lead = await ensureLead(deps.supabase, ctx.from, { config: deps.config });
  if (needsConsent(lead, deps.config)) return askConsent(ctx, deps);
  await clearHistory(deps.supabase, customerId);
  await setBotState(deps.supabase, customerId, { shown: [], lastSearch: null, scope: 'on_topic' });
  // Starting over puts the Lead back at the first stage. The earlier stages stay in their history.
  await setStage(deps.supabase, customerId, 'initiated', { actor: 'restart', reason: 'customer started over' });
  await ctx.reply(RESET_DONE);
}

export async function saved(ctx, deps) {
  const lead = await ensureLead(deps.supabase, ctx.from, { config: deps.config });
  if (needsConsent(lead, deps.config)) return askConsent(ctx, deps);
  const ids = lead.shortlistedPropertyIds ?? [];
  if (!ids.length) return ctx.reply(NO_SAVED);

  for (const id of ids) {
    const found = await getProperty(deps.supabase, id);
    if (!found) {
      await ctx.reply('One of your saved properties is no longer listed.');
    } else if (!SHOWABLE.includes(found.row.status)) {
      await ctx.reply(`${found.view.title} is no longer available.`);
    } else {
      const photos = (await loadPhotos(deps.supabase, [id]).catch(() => new Map())).get(id) ?? [];
      await sendCard(deps.api, ctx.chat.id, { ...found.view, kind: 'saved' }, { saved: true, photos });
    }
  }
}

// The number a Lead shares with the contact button. Only their own number is accepted.
export async function contact(ctx, deps) {
  const shared = ctx.message.contact;
  if (shared.user_id !== ctx.from.id) {
    return ctx.reply('Please share your own number using the button.');
  }
  const phone = shared.phone_number.startsWith('+') ? shared.phone_number : `+${shared.phone_number}`;
  const lead = await ensureLead(deps.supabase, ctx.from, { config: deps.config });
  await upsertLeadMemory(deps.supabase, { customerId: lead.customerId, phone }, { actor: 'system' });

  await ctx.reply(PHONE_THANKS, { reply_markup: { remove_keyboard: true } });
  await notifySales(
    deps.api,
    deps.config.salesDeskChatId,
    `📞 <b>${escapeHtml(lead.displayName ?? 'A customer')}</b> shared their number: ${escapeHtml(phone)}`
  );
}

