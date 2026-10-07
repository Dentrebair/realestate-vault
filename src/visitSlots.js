// When a property can be visited. Set per property on the board; the bot asks for a date and time and code checks it here.
// A property with no row is arranged by the team. "closed" means visits are not open yet.
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_RULES = 20;
const MAX_NOTE = 200;

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const weekdayOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();

// Whatever the board sends is cleaned here. Returns { value } or { error }.
export function validateAvailability(input) {
  if (!input || !['open', 'closed'].includes(input.mode)) return { error: 'Choose open or closed.' };
  const note = String(input.note ?? '').trim().slice(0, MAX_NOTE) || null;
  if (input.mode === 'closed') return { value: { mode: 'closed', rules: [], note } };

  const given = Array.isArray(input.rules) ? input.rules : [];
  if (!given.length) return { error: 'Add at least one day and time window.' };
  if (given.length > MAX_RULES) return { error: `At most ${MAX_RULES} windows.` };

  const rules = [];
  for (const r of given) {
    if (!TIME.test(r?.from ?? '') || !TIME.test(r?.to ?? '') || minutes(r.from) >= minutes(r.to)) return { error: 'Each window needs a start time before its end time.' };
    if (r.date !== undefined && r.date !== null && r.date !== '') {
      if (!DATE.test(r.date) || Number.isNaN(Date.parse(`${r.date}T12:00:00Z`))) return { error: 'A date is not valid.' };
      rules.push({ date: r.date, from: r.from, to: r.to });
    } else {
      const days = [...new Set((Array.isArray(r.days) ? r.days : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
      if (!days.length) return { error: 'Each weekly window needs at least one day.' };
      rules.push({ days, from: r.from, to: r.to });
    }
  }
  return { value: { mode: 'open', rules, note } };
}

export const nowIn = (now, timeZone) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
};

const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// The windows that apply on one calendar day.
export function windowsOn(rules, date) {
  const day = weekdayOf(date);
  return rules.filter((r) => (r.date ? r.date === date : (r.days ?? []).includes(day))).map(({ from, to }) => ({ from, to })).sort((a, b) => a.from.localeCompare(b.from));
}

export const prettyDate = (date) => `${DAY_NAMES[weekdayOf(date)]} ${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;

const clock = (hhmm) => {
  const h = Number(hhmm.slice(0, 2));
  const m = hhmm.slice(3, 5);
  return `${h % 12 || 12}${m === '00' ? '' : `:${m}`} ${h < 12 ? 'am' : 'pm'}`;
};
export const prettyWindow = ({ from, to }) => `${clock(from)} to ${clock(to)}`;
export const prettyWhen = (date, time) => `${prettyDate(date)}${time ? `, ${clock(time)}` : ''}`;

// The next few days with a window, from today. Today only counts if its window has not ended.
export function upcomingDays(rules, { now = new Date(), timeZone = 'Asia/Kolkata', horizon = 30, limit = 5 } = {}) {
  const here = nowIn(now, timeZone);
  const out = [];
  for (let i = 0; i <= horizon && out.length < limit; i += 1) {
    const date = addDays(here.date, i);
    const windows = windowsOn(rules, date).filter((w) => date !== here.date || w.to > here.time);
    if (windows.length) out.push({ date, windows });
  }
  return out;
}

export function describeUpcoming(rules, options) {
  return upcomingDays(rules, options).map(({ date, windows }) => `${prettyDate(date)}: ${windows.map(prettyWindow).join(', ')}`);
}

// Is this date and time inside a window, and still ahead of us?
export function slotFits(rules, date, time, { now = new Date(), timeZone = 'Asia/Kolkata' } = {}) {
  if (!DATE.test(date ?? '') || !TIME.test(time ?? '')) return false;
  const here = nowIn(now, timeZone);
  if (date < here.date || (date === here.date && time <= here.time)) return false;
  return windowsOn(rules, date).some((w) => time >= w.from && time < w.to);
}

// ---- storage ----------------------------------------------------------------------------------

const toAvailability = (row) => ({ propertyId: row.property_id, mode: row.mode, rules: row.rules ?? [], note: row.note ?? null, updatedAt: row.updated_at ?? null });

export async function getAvailability(supabase, propertyId) {
  const { data, error } = await supabase.from('visit_availability').select('*').eq('property_id', propertyId).maybeSingle();
  // Before 008 is run, or if the table cannot be read, nothing is set: the team arranges the visit, as before.
  if (error || !data) return null;
  return toAvailability(data);
}

export async function listAvailability(supabase, propertyIds) {
  if (!propertyIds.length) return new Map();
  const { data, error } = await supabase.from('visit_availability').select('property_id,mode').in('property_id', propertyIds);
  if (error || !data) return new Map();
  return new Map(data.map((r) => [r.property_id, r.mode]));
}

export async function saveAvailability(supabase, propertyId, value, by = null) {
  const { error } = await supabase.from('visit_availability').upsert(
    { property_id: propertyId, mode: value.mode, rules: value.rules, note: value.note, updated_by: by, updated_at: new Date().toISOString() },
    { onConflict: 'property_id' }
  );
  if (error) throw error;
}

export async function clearAvailability(supabase, propertyId) {
  const { error } = await supabase.from('visit_availability').delete().eq('property_id', propertyId);
  if (error) throw error;
}
