// One conversational turn: the model, its four tools, and the checks around what it says.
import { generateText, isStepCount, tool } from 'ai';
import { z } from 'zod';
import { setBotState, setStage, upsertLeadMemory, leadMemorySchema } from '../leadMemory.js';
import { formatInr, parseAmount, parseBudgetRange, toInr } from '../money.js';
import { loadPhotos } from '../photos.js';
import { getProperty, searchProperties } from '../propertySearch.js';
import { CATEGORIES } from '../propertyTypes.js';
import { visitPrompt } from './cards.js';
import { narrateSearch } from './narrate.js';
import { recordGap, relevantEntries } from '../knowledge.js';
import { locateProperty } from '../microMarkets.js';
import { sentencesOf, truthful } from './truthguard.js';
import { prepareSearchResult, rememberShown } from './present.js';
import { buildInstructions } from './systemPrompt.js';

const MAX_STEPS = 4;
const MAX_REPLY_CHARS = 1200;

const money = z
  .object({
    amount: z.number().positive(),
    unit: z.enum(['rupees', 'lakh', 'crore']).describe('1.5 crore is amount 1.5 with unit crore')
  })
  .describe('An amount of money. Never convert it yourself.');

const stageChoices = ['interested', 'negotiating', 'not_interested'];

export function createDeps(overrides = {}) {
  return { generate: generateText, timeoutMs: 25000, providerOptions: undefined, ...overrides };
}

export async function runAgentTurn({ deps, supabase, api, chatId, lead, history, text }) {
  const customerId = lead.customerId;
  const state = { shown: lead.botState?.shown ?? [], toolOutputs: [], unavailable: [], visitPromptSent: false, narration: null, sendCards: null };

  const record = (output) => {
    state.toolOutputs.push(JSON.stringify(output));
    return output;
  };

  const tools = {
    search_properties: tool({
      description:
        'Find properties that match what the customer wants, or the closest options with how they differ. Cards are sent to the customer automatically, right after your reply.',
      inputSchema: z.object({
        location: z.string().optional().describe('Area, corridor or landmark as the customer said it, e.g. OMR, Anna Nagar, near Tidel Park'),
        query: z.string().optional().describe('Kind of property and features, e.g. flat, villa, penthouse, office, cloud kitchen, sea facing'),
        category: z.enum(CATEGORIES).optional().describe('Flats, apartments, villas and houses are residential'),
        bedrooms: z.number().int().positive().optional().describe('Exact BHK'),
        minBedrooms: z.number().int().positive().optional().describe('At least this many BHK'),
        minBudget: money.optional(),
        maxBudget: money.optional(),
        ignoreSavedBudget: z.boolean().optional().describe('True only if the customer says the saved budget no longer applies'),
        offset: z.number().int().min(0).optional()
      }),
      execute: async (input) => record(await searchTool({ input, supabase, api, chatId, lead, state }))
    }),

    get_property: tool({
      description: 'Full details of one property already shown. Use position 1 for the first card shown.',
      inputSchema: z.object({
        position: z.number().int().positive().optional(),
        propertyId: z.string().optional()
      }),
      execute: async (input) => {
        const id = resolveId(input, state.shown);
        if (!id) return record({ error: 'No such property in the last results. Run search_properties.' });
        const found = await getProperty(supabase, id);
        if (!found) return record({ error: 'That property is no longer listed.' });
        const { view } = found;
        const photos = (await loadPhotos(supabase, [id]).catch(() => new Map())).get(id) ?? [];
        return record({
          id: view.id, title: view.title, location: view.location, category: view.category,
          status: view.statusLabel, price: view.priceDisplay, bedrooms: view.bedrooms,
          highlights: view.highlights, rera: view.rera, photos: photos.length
        });
      }
    }),

    save_requirements: tool({
      description:
        'Save what the customer told you. Send only what is new or changed. Also use it to set leadStage negotiating or not_interested.',
      inputSchema: z.object({
        displayName: z.string().optional(),
        intent: z.string().optional().describe('buy_residential, buy_plot, buy_commercial, invest, ...'),
        minBudget: money.optional(),
        maxBudget: money.optional(),
        preferredLocations: z.array(z.string()).optional().describe('The full current list'),
        propertyCategories: z.array(z.string()).optional().describe('The full current list'),
        bedrooms: z.number().int().positive().optional(),
        mustHaves: z.array(z.string()).optional().describe('The full current list'),
        dealBreakers: z.array(z.string()).optional().describe('The full current list'),
        urgency: z.string().optional(),
        financingStatus: z.string().optional(),
        leadStage: z.enum(stageChoices).optional(),
        stageReason: z.string().optional().describe('One line: why the stage changed'),
        keyPoints: z
          .array(z.object({ type: z.string(), text: z.string(), confidence: z.number().min(0).max(1) }))
          .optional(),
        lastQuerySummary: z.string().optional(),
        nextAction: z.string().optional().describe('What the sales team should do next')
      }),
      execute: async (input) => {
        const { minBudget, maxBudget, ...rest } = withoutNulls(input);
        const parsed = leadMemorySchema.safeParse({
          ...rest,
          customerId,
          ...(minBudget ? { budgetMin: toInr(minBudget.amount, minBudget.unit) } : {}),
          ...(maxBudget ? { budgetMax: toInr(maxBudget.amount, maxBudget.unit) } : {})
        });
        if (!parsed.success) return record({ saved: false, problem: parsed.error.issues[0]?.message });

        const result = await upsertLeadMemory(supabase, parsed.data, { actor: 'model' });
        return record({
          saved: true,
          stage: result.stage?.changed ? result.stage.to : undefined,
          stageNotAllowed: result.stage && !result.stage.changed ? result.stage.reason : undefined
        });
      }
    }),

    request_site_visit: tool({
      description:
        'The customer wants to visit a property. Sends them a confirm button; the visit is only requested when they tap it.',
      inputSchema: z.object({
        position: z.number().int().positive().optional(),
        propertyId: z.string().optional()
      }),
      execute: async (input) => {
        const id = resolveId(input, state.shown);
        const found = id ? await getProperty(supabase, id) : null;
        if (!found || !['available', 'under_construction'].includes(found.row.status)) {
          return record({ sent: false, problem: 'That property is not available. Run search_properties first.' });
        }
        const prompt = visitPrompt(found.view);
        await api.sendMessage(chatId, prompt.text, { parse_mode: 'HTML', reply_markup: prompt.keyboard });
        state.visitPromptSent = true;
        return record({
          confirmButtonSent: true,
          title: found.view.title,
          tellCustomer: 'A Confirm site visit button was sent. The visit is NOT requested until they tap it. Do not say it was requested, booked or scheduled.'
        });
      }
    })
  };

  // Answers the owners have approved that bear on this question. They are facts the model may use.
  const shownAreas = state.shown.map((p) => locateProperty(p.location ?? '').locality?.name).filter(Boolean);
  const entries = await relevantEntries(supabase, {
    text,
    propertyIds: state.shown.map((p) => p.id),
    areas: [...(lead.preferredLocations ?? []), ...shownAreas]
  }).catch(() => []);

  const instructions = `${buildInstructions(lead, entries)}${moneyHint(text)}`;
  const messages = [...history, { role: 'user', content: text }];
  const abortSignal = AbortSignal.timeout(deps.timeoutMs);
  const run = (extra = {}) =>
    deps.generate({
      model: deps.model,
      instructions,
      messages,
      tools,
      stopWhen: isStepCount(MAX_STEPS),
      abortSignal,
      providerOptions: deps.providerOptions,
      ...(deps.temperature !== undefined ? { temperature: deps.temperature } : {}),
      ...extra
    });

  let result;
  try {
  result = await run();

  // The model sometimes says "searching now" and stops without searching. Run the turn again with the
  // first step forced to use a tool, so the customer is not left waiting for results that never come.
  if (!state.toolOutputs.length && claimsToAct(result.text)) {
    result = await run({ prepareStep: ({ stepNumber }) => (stepNumber === 0 ? { toolChoice: 'required' } : {}) });
  }

  // The model sometimes says "tap the Confirm button" without having sent one. Make it send one.
  if (!state.visitPromptSent && claimsVisitButton(result.text) && state.shown.length) {
    result = await run({
      prepareStep: ({ stepNumber }) =>
        stepNumber === 0 ? { toolChoice: { type: 'tool', toolName: 'request_site_visit' } } : {}
    });
  }
  } catch (error) {
    // Results the customer asked for are not lost because the reply failed.
    await state.sendCards?.();
    throw error;
  }

  // When nothing matched exactly, code writes the reply from the search result. The model is never asked to
  // describe an empty or partial result, which is where it used to name areas from its own memory.
  let reply;
  let blocked = false;
  if (state.narration) {
    reply = state.narration;
  } else {
    const guarded = guardAmounts(result.text ?? '', [text, JSON.stringify(leadBudgets(lead)), ...state.toolOutputs], text);
    blocked = guarded.blocked;
    reply = guarded.blocked
      ? ''
      : mentionUnavailable(
          withoutPhotoClaims(
            withoutPhantomButtons(withoutCardTapping(withoutBackstage(guarded.text)), state.visitPromptSent),
            state.shown.some((p) => p.photoCount > 0)
          ),
          state.unavailable
        );
    const before = reply;
    reply = cardsFollow(reply);
    reply = truthful(reply, allowedContext({ lead, history, text, state, entries }));
    await noteGap({ supabase, lead, text, state, modelReply: before, finalReply: reply });
  }

  if (!reply) {
    reply = blocked
      ? state.shown.length ? 'Please see the details in the cards below.' : 'Let me check the details with our team.'
      : state.shown.length ? 'Here is what I found.' : 'Could you tell me a little more about what you are looking for?';
  }

  return {
    text: withoutDashes(reply).slice(0, MAX_REPLY_CHARS),
    blocked,
    shown: state.shown,
    sendCards: state.sendCards,
    usage: result.usage
  };
}

// When the model had to say "I do not have that", or a check had to remove something it made up, that is a gap
// an owner can fill. The customer's request is saved as JSON for the Knowledge tab.
const NOT_KNOWN = /\b(i do not have|i don'?t have|does not mention|doesn'?t mention|not (listed|mentioned|in the listing)|cannot confirm|can'?t confirm|no information|not available in the listing)\b/i;

async function noteGap({ supabase, lead, text, state, modelReply, finalReply }) {
  const removed = sentencesOf(modelReply).filter((s) => !finalReply.includes(s));
  const refused = NOT_KNOWN.test(finalReply);
  if (!removed.length && !refused) return;
  if (!isQuestionLike(text)) return;

  const property = state.shown.length === 1 ? state.shown[0] : null;
  try {
    await recordGap(supabase, {
      customerId: lead.customerId,
      isTest: lead.isTest === true,
      question: text,
      kind: 'other',
      propertyId: property?.id ?? null,
      request: {
        question: text,
        why: refused ? 'the assistant said it did not have the answer' : 'a statement the data could not support was removed',
        assistantReply: finalReply,
        removed,
        property: property ? { id: property.id, title: property.title, location: property.location } : null,
        shown: state.shown.map((p) => ({ id: p.id, title: p.title })),
        leadStage: lead.leadStage
      }
    });
  } catch (error) {
    console.error('Could not save a knowledge gap:', error.message);
  }
}

const isQuestionLike = (text) => /\?|^\s*(is|are|does|do|can|could|will|would|what|which|how|when|where|who|tell me|any)\b/i.test(text);

// Everything a reply may draw on: tool results, what the customer has said, their saved profile and what was shown.
function allowedContext({ lead, history, text, state, entries = [] }) {
  return [
    ...state.toolOutputs,
    ...entries.map((e) => `${e.answer} ${e.area ?? ''}`),
    text,
    ...history.filter((m) => m.role === 'user').map((m) => m.content),
    JSON.stringify({ areas: lead.preferredLocations, categories: lead.propertyCategories }),
    ...state.shown.map((p) => `${p.title} ${p.location}`)
  ].join(' ');
}

// Notes about the assistant's own bookkeeping are not for the customer: "(Updating lead stage to negotiating...)".
const BACKSTAGE =
  /\b(lead stage|stage to (?:negotiating|interested|initiated|site)|updat(?:e|ed|ing) (?:the |your |their )?(?:lead|record|profile|stage)|so the (?:sales )?team knows|saved? (?:your |these )?(?:preferences|requirements) (?:to|in))\b/i;

export function withoutBackstage(reply) {
  const text = String(reply).replace(/\s*\([^()]*\)/g, (match) => (BACKSTAGE.test(match) ? '' : match));
  const kept = text.split(/(?<=[.!?])\s+/).filter((sentence) => !BACKSTAGE.test(sentence));
  return kept.join(' ').trim();
}

// Cards have buttons, but the card itself is not tappable. "Tap the card to see details" is never true.
const TAP_CARD = /\b(tap|click|press|open|select) (on )?(a|the|that|this|each|any) (card|property|listing|picture|image)\b/i;

// The reply is sent before the cards, so words that assume the cards are already on screen are corrected.
export function cardsFollow(reply) {
  return String(reply)
    .replace(/\b(cards?|options?|listings?|properties|details|results?|ones?)\s+(shown\s+)?above\b/gi, (_, noun) => `${noun} below`)
    .replace(/\b(the|in the|see the) above\b/gi, (m) => m.replace('above', 'below'))
    .replace(/\bI(?: have|'ve)? (?:just )?(?:showed|shown|sent)\b/g, 'I am showing');
}

export function withoutCardTapping(reply) {
  if (!TAP_CARD.test(reply)) return reply;
  return reply.split(/(?<=[.!?])\s+/).filter((sentence) => !TAP_CARD.test(sentence)).join(' ').trim();
}

// With no photos on any property in play, a sentence about photos is wrong. Honest "no photos yet" lines are kept.
const PHOTO_WORDS = /\b(photos?|images?|pictures?|pics?|gallery|galleries)\b/i;
const NEGATION = /\b(no|not|none|don'?t|do not|without|yet)\b/i;

export function withoutPhotoClaims(reply, anyPhotos) {
  if (anyPhotos || !PHOTO_WORDS.test(reply)) return reply;
  const kept = reply.split(/(?<=[.!?])\s+/).filter((sentence) => !PHOTO_WORDS.test(sentence) || NEGATION.test(sentence));
  return kept.join(' ').trim();
}

// Mentions of a button that was never sent.
const BUTTON_CLAIM = /\b(tap|click|press|hit)\b[^.!?]*\b(button|confirm)\b|\bconfirm site visit\b[^.!?]*\bbutton\b/i;

export function claimsVisitButton(reply) {
  return BUTTON_CLAIM.test(String(reply ?? ''));
}

export function withoutPhantomButtons(reply, buttonSent) {
  if (buttonSent || !BUTTON_CLAIM.test(reply)) return reply;
  const kept = reply.split(/(?<=[.!?])\s+/).filter((sentence) => !BUTTON_CLAIM.test(sentence));
  return kept.join(' ').trim() || 'Which property would you like to visit?';
}

// A sold or reserved property that matched the request must be named as such. The model is told to,
// and this makes sure: if it leaves that out, one plain sentence is added.
export function mentionUnavailable(reply, unavailable = []) {
  const first = unavailable[0];
  if (!first || /\b(sold|reserved|no longer available|not available|unavailable)\b/i.test(reply)) return reply;
  const state = first.status === 'sold' ? 'sold' : 'reserved';
  return `${reply.trim()} Note: ${first.title} is ${state}.`;
}

// ---- search tool ---------------------------------------------------------------------------

async function searchTool({ input, supabase, api, chatId, lead, state }) {
  const given = withoutNulls(input);
  const filters = {
    customerId: lead.customerId,
    limit: 5,
    offset: given.offset ?? 0,
    location: given.location,
    query: given.query,
    category: given.category,
    bedrooms: given.bedrooms,
    minBedrooms: given.minBedrooms,
    minBudget: given.minBudget ? toInr(given.minBudget.amount, given.minBudget.unit) : undefined,
    maxBudget: given.maxBudget ? toInr(given.maxBudget.amount, given.maxBudget.unit) : undefined,
    dealBreakers: lead.dealBreakers?.length ? lead.dealBreakers : undefined,
    mustHaves: lead.mustHaves?.length ? lead.mustHaves : undefined
  };

  // Hard limits the customer already gave us carry over unless they say otherwise.
  let usedSavedBudget = false;
  if (!given.ignoreSavedBudget) {
    if (filters.maxBudget === undefined && lead.budgetMax) {
      filters.maxBudget = lead.budgetMax;
      usedSavedBudget = true;
    }
    if (filters.minBudget === undefined && lead.budgetMin && filters.maxBudget !== undefined) {
      filters.minBudget = lead.budgetMin;
      usedSavedBudget = true;
    }
  }

  const result = await searchProperties(supabase, filters);
  if (!result.configured) return { error: result.message };

  // The cards are held back and sent after the reply text, so the customer reads the text first.
  const { views, send } = await prepareSearchResult({ api, supabase, chatId, result, lead });
  state.sendCards = send;
  state.shown = rememberShown(views);
  state.unavailable = result.unavailable;
  state.narration = narrateSearch(result);

  const { customerId: _omit, offset: _offset, limit: _limit, ...remembered } = filters;
  await setBotState(supabase, lead.customerId, {
    shown: state.shown,
    lastSearch: { filters: remembered, nextOffset: result.nextOffset }
  });
  if (views.length) {
    await setStage(supabase, lead.customerId, 'interested', { actor: 'system', reason: 'was shown properties' });
  }

  return {
    outcome: result.outcome,
    guidance: result.guidance,
    searchedFor: result.criteria.summary,
    usedSavedBudget,
    cardsShown: views.map((v, i) => ({
      position: i + 1,
      id: v.id,
      title: v.title,
      location: v.location,
      price: v.priceDisplay,
      bedrooms: v.bedrooms,
      status: v.statusLabel,
      photos: v.photoCount ?? 0,
      differences: v.differences
    })),
    totalMatches: result.totalMatches,
    moreAvailable: result.nextOffset !== null,
    unavailable: result.unavailable.map((u) => `${u.title} (${u.status})`),
    farAboveBudget: result.droppedOverBudget.map((p) => `${p.title} at ${p.priceDisplay}`),
    nearestElsewhere: result.nearestElsewhere
      ? `${result.nearestElsewhere.title}, about ${result.nearestElsewhere.distanceKm} km away, ${result.nearestElsewhere.priceDisplay}`
      : undefined
  };
}

// The business does not want em or en dashes in messages, so they are removed here whatever the model writes.
export function withoutDashes(text) {
  return String(text)
    .replace(/(\d[a-z]*)\s*[–—]\s*(\d)/gi, '$1 to $2')
    .replace(/\s*[–—]\s*/g, ', ')
    .replace(/,\s*,/g, ',');
}

// Amounts are read by code, not by the model: "150L" is 150 lakh and "1.5C" is 1.5 crore, every time.
// The result goes to the model as a fact, so it neither misreads a unit nor asks about one that is there.
const MONEY_WORDS = /\b(budget|price|cost|afford|spend|max|maximum|minimum|under|below|within|upto|up to|around|about|approx)\b/i;

export function moneyHint(text) {
  const range = parseBudgetRange(text);
  if (!range) return '';

  const head = "\n\nWHAT THE CUSTOMER'S LATEST MESSAGE SAYS ABOUT MONEY (read by our software; trust it)\n";
  if (range.inverted) {
    return `${head}- The range is the wrong way round. Ask which way they mean. Do not search or save a budget yet.`;
  }
  if (!range.unitKnown) {
    if (!MONEY_WORDS.test(text)) return '';
    return `${head}- An amount was given with no unit. Ask whether they mean lakh or crore. Do not search or save a budget yet.`;
  }
  const parts = [];
  if (range.min !== undefined) parts.push(`minimum ${formatInr(range.min)}`);
  if (range.max !== undefined) parts.push(`maximum ${formatInr(range.max)}`);
  return `${head}- Budget: ${parts.join(', ')}. The units are clear; do not ask about them.`;
}

// ---- checks on what the model says ----------------------------------------------------------

const AMOUNT =
  /(?:₹|rs\.?\s*)\s*\d[\d,]*(?:\.\d+)?\s*(?:crores?|cr|lakhs?|lacs?|l)?\b|\b\d[\d,]*(?:\.\d+)?\s*(?:crores?|cr|lakhs?|lacs?)\b/gi;

function amountsIn(text) {
  return [...String(text).matchAll(AMOUNT)]
    .map((m) => parseAmount(m[0])?.value)
    .filter((v) => Number.isFinite(v));
}

// Every amount in the reply must come from a tool result, the customer's own words, or their saved budget.
export function guardAmounts(reply, sources, customerText = '') {
  // "80" could mean 80 lakh or 80 crore; repeating their own number back with a unit is how we ask.
  const theirNumbers = [...String(customerText).matchAll(/\d[\d,]*(?:\.\d+)?/g)]
    .map((m) => Number(m[0].replace(/,/g, '')))
    .flatMap((n) => [n * 1e5, n * 1e7]);
  const allowed = [...sources.flatMap(amountsIn), ...theirNumbers];
  const close = (a, b) => Math.abs(a - b) <= Math.max(1, b * 0.02);
  const invented = amountsIn(reply).filter((v) => v >= 1000 && !allowed.some((a) => close(v, a)));
  return invented.length ? { text: '', blocked: true, invented } : { text: reply.trim(), blocked: false };
}

const ACTION_CLAIM = /\b(searching|let me (search|look|find|check|pull)|i(?:'|’)?ll (search|look|find|check|pull|show)|i will (search|look|find|check|pull|show))\b/i;

export function claimsToAct(reply) {
  return ACTION_CLAIM.test(String(reply ?? ''));
}

function leadBudgets(lead) {
  return { min: lead.budgetMin ? `₹${lead.budgetMin}` : '', max: lead.budgetMax ? `₹${lead.budgetMax}` : '' };
}

function resolveId({ position, propertyId }, shown) {
  if (propertyId && shown.some((s) => s.id === propertyId)) return propertyId;
  if (position) return shown[position - 1]?.id ?? null;
  return propertyId ?? null;
}

function withoutNulls(object) {
  return Object.fromEntries(Object.entries(object ?? {}).filter(([, v]) => v !== null && v !== undefined));
}

