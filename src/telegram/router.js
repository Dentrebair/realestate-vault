// What is this message about? The model reads it and returns a label; code then answers from data.
// The model never writes the answer for any of these labels.
//
// Not wired into the bot yet: evals/router.js measures it against the keyword rules first.
import { TOPICS } from './facts.js';

export const LABELS = {
  photos: 'asks whether there are photos or images, or asks to see them',
  rental: 'wants to rent or lease (we only sell)',
  negotiation: 'tries to pay less than the listed price, asks for a discount, makes an offer, or asks whether the price can change',
  price_question: 'asks the listed price of a property',
  hours: 'asks when the team or office is open',
  human: 'asks whether they are talking to a bot or a real person',
  other_city: 'asks about property outside Chennai',
  count: 'asks how many properties or listings we have in total',
  availability: 'asks whether a property is still available or has been sold',
  visit_time: 'proposes a day or time to visit a property',
  compare: 'asks which of the shown properties is better or to compare them',
  topic: 'asks a specific question that is not one of the above: set "topic" to the closest key below',
  search: 'asks to see, find or filter properties, or gives requirements such as area, budget, size or type',
  other: 'anything else: greeting, thanks, small talk, a name, "I will think about it"'
};

const topicLines = TOPICS.map((t) => `${t.key}: ${t.label}`).join('\n');

const instructionsFor = (shown) =>
  'You route messages for a real-estate chat assistant for Chennai. Pick the ONE label that best describes what the customer wants now.\n' +
  (shown.length
    ? 'Properties on the customer\'s screen:\n' + shown.slice(0, 5).map((p, i) => `${i + 1}) "${p.title}" in ${p.location}, ${p.priceDisplay}`).join('\n') + '\n'
    : 'Nothing is on the customer\'s screen yet.\n') +
  'Labels:\n' + Object.entries(LABELS).map(([k, v]) => `${k}: ${v}`).join('\n') +
  '\nTopic keys (only when the label is "topic"):\n' + topicLines +
  '\nThe customer may write in English, Tamil, or Tamil in English letters.' +
  '\nReply with JSON only: {"label": "<label>", "topic": "<topic key>" or null}';

const TIMEOUT_MS = 4000;

// The model may write a topic as its key ("approvals") or by its description ("approvals and title").
const topicKey = (value) => TOPICS.find((t) => t.key === value || t.label.toLowerCase() === String(value ?? '').toLowerCase())?.key ?? null;

// Returns { label, topic } or null when the model cannot be reached or answers with something unusable.
export async function routeMessage({ text, shown = [], deps }) {
  if (!deps?.generate || !deps?.model) return null;
  try {
    const result = await deps.generate({
      model: deps.model,
      providerOptions: deps.providerOptions,
      ...(deps.temperature !== undefined ? { temperature: deps.temperature } : {}),
      instructions: instructionsFor(shown),
      prompt: String(text).slice(0, 500),
      abortSignal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const raw = result.text ?? '';
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    // The model sometimes puts the topic key in the label slot ("contact"). That is still a clear answer.
    if (topicKey(parsed.label)) return { label: 'topic', topic: topicKey(parsed.label) };
    if (!(parsed.label in LABELS)) return null;
    if (parsed.label !== 'topic') return { label: parsed.label, topic: null };
    return topicKey(parsed.topic) ? { label: 'topic', topic: topicKey(parsed.topic) } : null;
  } catch {
    return null;
  }
}
