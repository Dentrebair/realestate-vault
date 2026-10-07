// The model reads a customer's wish for a date and time. Code then checks it against the property's rules.
const TIMEOUT_MS = 4000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// Returns { date, time, cancel, unrelated } or null when the model cannot be reached or answers with something unusable.
export async function readPreferredTime({ text, today, weekday, now, deps }) {
  if (!deps?.generate || !deps?.model) return null;
  try {
    const result = await deps.generate({
      model: deps.model,
      providerOptions: deps.providerOptions,
      ...(deps.temperature !== undefined ? { temperature: deps.temperature } : {}),
      instructions:
        'A real-estate customer in Chennai was asked for the date and time they would like to visit a property. Read their reply.\n' +
        `Today is ${weekday} ${today} and the time now is ${now} (India). Work out dates like "tomorrow", "this Saturday" or "next Monday" from it.\n` +
        'They may write in English, Tamil, or Tamil in English letters.\n' +
        'Reply with JSON only: {"date": "YYYY-MM-DD" or null, "time": "HH:MM" in 24 hour time or null, "cancel": true or false, "unrelated": true or false}\n' +
        'Leave time null when only a part of the day is given ("morning", "evening"). Leave date null when no day is given: never assume today.\n' +
        '"cancel" is true when they no longer want to visit. "unrelated" is true when the message is not about choosing a day or time (a question, a search, small talk).',
      prompt: String(text).slice(0, 300),
      abortSignal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const raw = result.text ?? '';
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    return {
      date: DATE.test(parsed.date ?? '') ? parsed.date : null,
      time: TIME.test(parsed.time ?? '') ? parsed.time : null,
      cancel: parsed.cancel === true,
      unrelated: parsed.unrelated === true
    };
  } catch {
    return null;
  }
}
