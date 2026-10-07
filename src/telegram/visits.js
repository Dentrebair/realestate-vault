// Asking to visit a property. Each property has its own rules, set on the board:
//   nothing set  the team arranges it (the request goes straight to them)
//   closed       visits are not open yet; the team is told the customer is interested
//   open         the bot asks for a date and time, code checks it against the windows, then the team confirms
import { getLead, recordEvent, setBotState, setStage } from '../leadMemory.js';
import { getProperty } from '../propertySearch.js';
import { describeUpcoming, getAvailability, nowIn, prettyWhen, prettyDate, prettyWindow, slotFits, upcomingDays, windowsOn } from '../visitSlots.js';
import { Keyboard } from 'grammy';
import { SHARE_NUMBER_PROMPT, visitRecorded } from './copy.js';
import { saveMessage } from './history.js';
import { raiseHandoff } from './handoff.js';
import { readPreferredTime } from './visitTime.js';

const SHOWABLE = ['available', 'under_construction'];
const ASK_EXPIRES_MS = 3 * 60 * 60 * 1000;

// A customer asks to visit a property once. After the team has been told, the same property is never offered again.
export async function visitAlreadyAsked(supabase, customerId, propertyId) {
  const { data, error } = await supabase
    .from('lead_events')
    .select('id,alerted_at')
    .eq('customer_id', customerId)
    .eq('event_type', 'site_visit_requested')
    .eq('property_id', propertyId)
    .limit(5);
  if (error) return false;
  return data.some((e) => e.alerted_at);
}

const clockNow = (deps) => deps.now?.() ?? new Date();
const zoneOf = (deps) => deps.config.businessTimeZone ?? 'Asia/Kolkata';

async function say(ctx, deps, customerId, text, extra = {}) {
  await ctx.reply(text);
  await saveMessage(deps.supabase, customerId, 'assistant', text, extra);
}

const optionsText = (rules, deps) => {
  const lines = describeUpcoming(rules, { now: clockNow(deps), timeZone: zoneOf(deps) });
  return lines.length ? lines.map((l) => `• ${l}`).join('\n') : null;
};

// The customer tapped the visit button. Decides what happens next from the property's rules.
export async function startVisit(ctx, deps, lead, found, propertyId) {
  const { supabase } = deps;
  const availability = await getAvailability(supabase, propertyId);

  if (availability?.mode === 'closed') {
    const text = `Site visits for ${found.view.title} are not open yet. I have told our team you are interested, and they will reply here.${availability.note ? `\n${availability.note}` : ''}`;
    await say(ctx, deps, lead.customerId, text, { visit: propertyId });
    await raiseHandoff({ deps, lead: await getLead(supabase, lead.customerId), kind: 'visit', summary: `Interested in visiting ${found.view.title}. Visits are not open for it yet`, property: found.view });
    return { text: 'Noted' };
  }

  if (availability?.mode === 'open') {
    const options = optionsText(availability.rules, deps);
    if (options) {
      await setBotState(supabase, lead.customerId, { pendingVisit: { propertyId, askedAt: clockNow(deps).toISOString() } });
      const text = `When would you like to visit ${found.view.title}? Please share your preferred date and time.\n\nAvailable:\n${options}${availability.note ? `\n\n${availability.note}` : ''}`;
      await say(ctx, deps, lead.customerId, text, { visit: propertyId });
      return { text: 'Tell me a date and time' };
    }
    // Every window has passed: the team arranges it.
  }

  return completeVisit(ctx, deps, { lead, found, propertyId });
}

// Records the request, tells the customer, and alerts the team. `preferred` is { date, time } or { text } or nothing.
export async function completeVisit(ctx, deps, { lead, found, propertyId, preferred = null }) {
  const { supabase, config } = deps;
  const customerId = lead.customerId;
  const when = preferred?.date ? prettyWhen(preferred.date, preferred.time) : null;

  const { data: earlier, error } = await supabase
    .from('lead_events')
    .select('id')
    .eq('customer_id', customerId)
    .eq('event_type', 'site_visit_requested')
    .eq('property_id', propertyId)
    .limit(1);
  if (error) throw error;

  if (!earlier.length) {
    await setStage(supabase, customerId, 'site_visit_ready', { actor: 'button', propertyId, reason: 'tapped Book Site Visit' });
    await recordEvent(supabase, customerId, 'site_visit_requested', { toStage: 'site_visit_ready', propertyId, ...(when ? { payload: { preferred: when } } : {}) });
  }
  await setBotState(supabase, customerId, { pendingVisit: null });

  const confirmation = when
    ? `✅ Site visit request noted for ${found.view.title}.\nYou asked for ${when}. Our team will confirm it here shortly.`
    : visitRecorded(found.view.title, config.businessHours);
  await say(ctx, deps, customerId, confirmation, { visit: propertyId });

  if (!lead.phone) {
    await ctx.reply(SHARE_NUMBER_PROMPT, { reply_markup: new Keyboard().requestContact('📞 Share my number').oneTime().resized() });
  }

  const summary = `Asked to visit ${found.view.title}${when ? `, preferred ${when}` : preferred?.text ? `. Customer wrote: "${preferred.text.slice(0, 200)}"` : ''}`;
  const { alerted } = await raiseHandoff({ deps, lead: await getLead(supabase, customerId), kind: 'visit', summary, property: found.view });
  if (alerted) {
    await supabase
      .from('lead_events')
      .update({ alerted_at: new Date().toISOString() })
      .eq('customer_id', customerId)
      .eq('event_type', 'site_visit_requested')
      .eq('property_id', propertyId);
  }
  return { text: 'Visit request noted' };
}

// The customer answers "when would you like to visit?". Returns true when this message was dealt with here.
export async function continueVisit(ctx, deps, lead, text) {
  const { supabase } = deps;
  const customerId = lead.customerId;
  const pending = lead.botState?.pendingVisit;
  if (!pending) return false;

  const drop = () => setBotState(supabase, customerId, { pendingVisit: null });
  if (clockNow(deps) - Date.parse(pending.askedAt) > ASK_EXPIRES_MS) { await drop(); return false; }

  const [availability, found] = await Promise.all([getAvailability(supabase, pending.propertyId), getProperty(supabase, pending.propertyId)]);
  if (availability?.mode !== 'open' || !found || !SHOWABLE.includes(found.row.status)) { await drop(); return false; }

  const timeZone = zoneOf(deps);
  const here = nowIn(clockNow(deps), timeZone);
  const read = await readPreferredTime({
    text,
    today: here.date,
    weekday: prettyDate(here.date).slice(0, 3),
    now: here.time,
    deps: deps.agent
  });
  const reply = async (message) => { await saveMessage(supabase, customerId, 'user', text); await say(ctx, deps, customerId, message); return true; };

  if (read?.cancel) {
    await drop();
    return reply('No problem. Tell me if you would like to visit later, or keep looking at other properties.');
  }
  if (read?.unrelated) return false;

  // The model could not be reached. Words that look like a day or time go to the team as they are written.
  if (!read) {
    if (!/\d|today|tomorrow|morning|afternoon|evening|weekend|\b(mon|tue|wed|thu|fri|sat|sun)/i.test(text)) return false;
    await saveMessage(supabase, customerId, 'user', text);
    await completeVisit(ctx, deps, { lead, found, propertyId: pending.propertyId, preferred: { text } });
    return true;
  }

  const date = read.date ?? pending.date ?? null;
  const time = read.time ?? pending.time ?? null;
  const options = optionsText(availability.rules, deps);
  const open = (d) => upcomingDays(availability.rules, { now: clockNow(deps), timeZone, horizon: 60, limit: 60 }).find((x) => x.date === d);

  if (!date && !time) return reply(`Please tell me a day and time that suits you.\n\nAvailable:\n${options}`);

  if (date && !open(date)) {
    await setBotState(supabase, customerId, { pendingVisit: { ...pending, date: null } });
    return reply(`Sorry, ${prettyDate(date)} is not available for a visit.\n\nAvailable:\n${options}`);
  }
  if (date && !time) {
    await setBotState(supabase, customerId, { pendingVisit: { ...pending, date } });
    return reply(`What time on ${prettyDate(date)}? Available: ${open(date).windows.map(prettyWindow).join(', ')}.`);
  }
  if (!date) {
    await setBotState(supabase, customerId, { pendingVisit: { ...pending, time } });
    return reply(`Which day? Available:\n${options}`);
  }

  if (!slotFits(availability.rules, date, time, { now: clockNow(deps), timeZone })) {
    await setBotState(supabase, customerId, { pendingVisit: { ...pending, date, time: null } });
    return reply(`That time is outside the visit hours for ${prettyDate(date)}. Available: ${windowsOn(availability.rules, date).map(prettyWindow).join(', ')}.`);
  }

  await saveMessage(supabase, customerId, 'user', text);
  await completeVisit(ctx, deps, { lead, found, propertyId: pending.propertyId, preferred: { date, time } });
  return true;
}
