// Slash commands and the messages that are not plain text.
import { setBotState, upsertLeadMemory } from '../leadMemory.js';
import { getProperty } from '../propertySearch.js';
import { browseKeyboard, cardKeyboard, renderCard } from './cards.js';
import { HELP, NO_SAVED, PHONE_THANKS, RESET_DONE, welcome } from './copy.js';
import { clearHistory } from './history.js';
import { customerIdOf, ensureLead } from './lead.js';
import { notifySales } from './sales.js';
import { escapeHtml } from './html.js';

const SHOWABLE = ['available', 'under_construction'];

export async function start(ctx, deps) {
  // A deep link such as t.me/bot?start=omr_ad1 tells us which campaign brought the Lead.
  const source = typeof ctx.match === 'string' && ctx.match.trim() ? ctx.match.trim().slice(0, 60) : undefined;
  const lead = await ensureLead(deps.supabase, ctx.from, { source });
  await setBotState(deps.supabase, lead.customerId, { scope: 'on_topic' });
  await ctx.reply(welcome(ctx.from.first_name), { reply_markup: browseKeyboard() });
}

export async function help(ctx) {
  await ctx.reply(HELP);
}

export async function reset(ctx, deps) {
  const customerId = customerIdOf(ctx.from);
  await ensureLead(deps.supabase, ctx.from);
  await clearHistory(deps.supabase, customerId);
  await setBotState(deps.supabase, customerId, { shown: [], lastSearch: null, scope: 'on_topic' });
  await ctx.reply(RESET_DONE);
}

export async function saved(ctx, deps) {
  const lead = await ensureLead(deps.supabase, ctx.from);
  const ids = lead.shortlistedPropertyIds ?? [];
  if (!ids.length) return ctx.reply(NO_SAVED);

  for (const id of ids) {
    const found = await getProperty(deps.supabase, id);
    if (!found) {
      await ctx.reply('One of your saved properties is no longer listed.');
    } else if (!SHOWABLE.includes(found.row.status)) {
      await ctx.reply(`${found.view.title} is no longer available.`);
    } else {
      await ctx.reply(renderCard({ ...found.view, kind: 'saved' }), {
        parse_mode: 'HTML',
        reply_markup: cardKeyboard(id, { saved: true }),
        link_preview_options: { is_disabled: true }
      });
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
  const lead = await ensureLead(deps.supabase, ctx.from);
  await upsertLeadMemory(deps.supabase, { customerId: lead.customerId, phone }, { actor: 'system' });

  await ctx.reply(PHONE_THANKS, { reply_markup: { remove_keyboard: true } });
  await notifySales(
    deps.api,
    deps.config.salesDeskChatId,
    `📞 <b>${escapeHtml(lead.displayName ?? 'A customer')}</b> shared their number: ${escapeHtml(phone)}`
  );
}

