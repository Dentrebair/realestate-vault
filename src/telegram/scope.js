// Is this person asking about Chennai property? Cheap checks first; the model only for unclear cases.
import { parseAmount } from '../money.js';
import { resolveArea } from '../microMarkets.js';
import { detectSubtypes, normalizeCategory } from '../propertyTypes.js';

const GREETING = /^(hi+|hello+|hey+|hola|namaste|vanakkam|good (morning|afternoon|evening)|help|start|ok|okay|thanks|thank you)\b[\s!.?]*$/i;

const PROPERTY_WORDS =
  /\b(bhk|rent|buy|sell|sale|price|budget|crore|crores|cr|lakh|lakhs|sq ?ft|property|properties|flat|flats|apartment|house|villa|plot|land|shop|office|warehouse|hotel|resort|visit|listing|listings|available|loan|possession|rera|cmda|real estate|invest|investment|home|commercial|residential)\b/i;

// Returns 'on_topic' when it is obvious, otherwise null.
export function quickScope(text) {
  const t = String(text ?? '').trim();
  if (GREETING.test(t)) return 'on_topic';
  if (PROPERTY_WORDS.test(t)) return 'on_topic';
  if (normalizeCategory(t).length || detectSubtypes(t).size) return 'on_topic';
  if (resolveArea(t)) return 'on_topic';
  if (parseAmount(t)?.unitKnown) return 'on_topic';
  return null;
}

const CLASSIFIER_INSTRUCTIONS =
  'You decide whether a chat message comes from someone interested in Chennai real estate: buying, investing, ' +
  'visiting, asking about listings, prices or areas, or continuing such a conversation. ' +
  'Reply with exactly one word: YES or NO.';

// Fails open: if the check cannot run, treat the message as on topic so no buyer is silenced.
export async function classifyScope(text, { generate, model, providerOptions, temperature, timeoutMs = 5000 }) {
  try {
    const result = await generate({
      model,
      instructions: CLASSIFIER_INSTRUCTIONS,
      prompt: String(text).slice(0, 500),
      abortSignal: AbortSignal.timeout(timeoutMs),
      providerOptions,
      ...(temperature !== undefined ? { temperature } : {})
    });
    return /^\s*no\b/i.test(result.text ?? '') ? 'off_topic' : 'on_topic';
  } catch {
    return 'on_topic';
  }
}

export async function scopeOf(text, deps) {
  return quickScope(text) ?? (await classifyScope(text, deps));
}
