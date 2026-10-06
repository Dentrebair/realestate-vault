// Is it business hours? The text customers see is BUSINESS_HOURS; this is the same window in a form code can check.
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function inBusinessHours(date, { businessDays, businessOpenHour, businessCloseHour, businessTimeZone }) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: businessTimeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(date);
  const day = WEEKDAYS[parts.find((p) => p.type === 'weekday').value];
  const hour = Number(parts.find((p) => p.type === 'hour').value);
  return businessDays.includes(day) && hour >= businessOpenHour && hour < businessCloseHour;
}
