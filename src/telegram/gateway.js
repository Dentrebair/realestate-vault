// Answers factual questions from data, before the model is asked anything.
//
// For each question the order is: the listing's own data, then an answer an owner has approved, and only
// then "I do not have that", which is saved as a knowledge gap so an owner can fill it.
import { config as appConfig } from '../config.js';
import { findEntry as findStoredEntry, markServed, recordGap } from '../knowledge.js';
import { upsertLeadMemory } from '../leadMemory.js';
import { locateProperty, normalize, resolveArea } from '../microMarkets.js';
import { POR_LABEL, formatInr, priceDisplay } from '../money.js';
import { loadPhotos } from '../photos.js';
import { getProperty } from '../propertySearch.js';
import { photosAnswer, PHOTOS_GENERAL } from './copy.js';
import { DEFAULT_REPLIES, fieldAnswer, hasSearchIntent, isQuestion, topicOf } from './facts.js';
import { asksAboutPhotos, isNegotiation, isPriceOffer, offeredAmount, wantsRental } from './intent.js';

const STATUS_WORDS = { available: 'Available', under_construction: 'Under construction', reserved: 'Reserved', sold: 'Sold' };
const ORDINALS = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3, fifth: 4, '5th': 4 };
const CITIES = /\b(bangalore|bengaluru|mumbai|delhi|hyderabad|pune|kolkata|coimbatore|madurai|kochi|cochin|trichy|salem|vellore|pondicherry|puducherry|goa|gurgaon|noida)\b/i;

// Which property does the customer mean? One of the cards shown, by "first one", "number 2", its area, or because only one is in play.
export function referenced(text, shown) {
  if (!shown.length) return { none: true };
  const t = String(text).toLowerCase();

  if (/\blast one\b/.test(t)) return { property: shown.at(-1) };
  for (const [word, index] of Object.entries(ORDINALS)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) return shown[index] ? { property: shown[index] } : { ambiguous: shown };
  }
  const number = /\b(?:number|no\.?|#|option|card|property)\s*(\d)\b/.exec(t);
  if (number) return shown[Number(number[1]) - 1] ? { property: shown[Number(number[1]) - 1] } : { ambiguous: shown };

  const byPlace = shown.filter((p) => {
    const place = String(p.location ?? '').split(',')[0].trim().toLowerCase();
    return place.length > 3 && t.includes(place);
  });
  if (byPlace.length === 1) return { property: byPlace[0] };

  return shown.length === 1 ? { property: shown[0] } : { ambiguous: shown };
}

// The listing a customer names in their own words ("High-Rise 2BHK Apartment near omr", "the Alwarpet bungalow").
// Returns it only when one listing is clearly the best match.
const NAME_STOP = new Set(['price', 'cost', 'rate', 'what', 'the', 'how', 'much', 'for', 'near', 'and', 'with', 'tell', 'about', 'can', 'get', 'please', 'chennai', 'asking', 'listed', 'its', 'whats']);
const nameTokens = (text) => normalize(text).split(' ').filter((w) => w.length >= 3 && !NAME_STOP.has(w));

export async function findByName(supabase, text, table) {
  const { data, error } = await supabase.from(table).select('property_id,title,location,status,price_inr,metadata').limit(1000);
  if (error) throw error;
  const wanted = new Set(nameTokens(text));
  const scored = data
    .map((row) => ({ row, score: new Set(nameTokens(`${row.title} ${row.location}`)).size && [...new Set(nameTokens(`${row.title} ${row.location}`))].filter((w) => wanted.has(w)).length }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  return best && best.score >= 2 && best.score > (second?.score ?? 0) ? best.row : null;
}

// Before the knowledge tables exist, or if they are unreachable, there are simply no approved answers.
const findEntry = (supabase, query) => findStoredEntry(supabase, query).catch(() => null);

const which = (shown) =>
  `Which one do you mean? ${shown.map((p, i) => `${i + 1}) ${p.title}`).join('; ')}. You can say "the first one" or "number 2".`;

// The rules that decide what a message is about. Named so the router eval can measure exactly these.
const HOURS = /\b(office|working|business|opening|open) (hours|timings?)\b|\bwhen (are|will) you (be )?(open|available)\b|\bwhat time (do|are) you\b/i;
const HUMAN = /\b(real (person|human)|am i (talking|speaking|chatting) to|are you (a |an )?(bot|robot|human|real|ai|person|machine))\b/i;
const VISIT_TIME = /\b(visit|see|view|come|drop by|tour)\b[^.?!]*\b(tomorrow|today|tonight|weekend|saturday|sunday|monday|tuesday|wednesday|thursday|friday|\d{1,2}(:\d\d)?\s?(am|pm)|at \d)\b/i;
const COMPARE = /\bwhich\b[^.?!]*\b(is|are|would be)\b[^.?!]*\b(better|best)\b|\bwhich (one )?(would|should) (you|i)\b|\b(do )?you recommend\b|\bbetter of the\b|\bcompare\b/i;
export const asksPrice = (t) => /\b(price|cost|how much|asking)\b/i.test(t) && isQuestion(t) && !/\b(per sq|market|average|trend|forecast|appreciat\w*|worth it)\b/i.test(t);
export const asksCount = (t) => /\bhow many\b[^.?!]*\b(propert\w+|listings?|flats?|homes?|plots?|options|units)\b/i.test(t) && !hasSearchIntent(t.replace(/how many/i, ''));
export const asksAvailability = (t) => /\b(still |currently )?(available|vacant|sold|taken|on sale)\b/i.test(t) && isQuestion(t) && !hasSearchIntent(t);
export const asksOtherCity = (t) => CITIES.test(t) && (isQuestion(t) || /\bdo you have\b/i.test(t));
export const asksHours = (t) => HOURS.test(t);
export const asksIfHuman = (t) => HUMAN.test(t);
export const proposesVisitTime = (t) => VISIT_TIME.test(t);
export const asksToCompare = (t) => COMPARE.test(t);


const ONLY_SALES = 'We only sell properties, so I cannot help with rentals or leases. If you are open to buying, tell me the area, your budget and the kind of property, and I will find options.';

export async function answerFromData({ text, lead, supabase, config: given = appConfig, intent = null, route = null }) {
  // Callers may pass only the settings they care about; anything missing comes from the app's own settings.
  const config = { ...appConfig, ...given };
  const shown = lead.botState?.shown ?? [];
  const t = String(text ?? '');

  // ---- questions about our data or our business ----
  if (asksAboutPhotos(t)) {
    const found = shown.length ? await loadPhotos(supabase, shown.map((p) => p.id)).catch(() => new Map()) : new Map();
    return { reply: shown.length ? photosAnswer(shown.map((p) => ({ title: p.title, count: found.get(p.id)?.length ?? 0 }))) : PHOTOS_GENERAL };
  }

  // ---- we only sell: no search, no cards ----
  if (wantsRental(t)) return { reply: ONLY_SALES };

  // ---- an offer on a property in play ("can i get for 54L"): not a search, and not a price we can agree ----
  const offer = intent ? intent.offer : isPriceOffer(t, shown) ? offeredAmount(t) : null;
  const negotiating = intent ? intent.negotiating : isNegotiation(t);
  // What the message is about. The model's label decides when there is one; the keyword rules decide when there is not.
  const says = (label, rule) => (route ? route.label === label : rule(t));

  if (offer !== null && shown.length) {
    const ref = referenced(t, shown);
    if (ref.ambiguous) return { reply: which(ref.ambiguous) };
    const found = ref.property ? await getProperty(supabase, ref.property.id) : null;
    if (found) {
      const amount = offer;
      const listed = found.row.price_inr == null ? `as ${POR_LABEL}` : `at ${priceDisplay(found.row.price_inr)}`;
      await upsertLeadMemory(
        supabase,
        {
          customerId: lead.customerId,
          keyPoints: [{ type: 'negotiation', text: `Offered ${formatInr(amount)} for ${found.row.title} (listed ${listed.replace(/^(as|at) /, '')})`, confidence: 1 }],
          nextAction: 'sales team to discuss a price offer'
        },
        { actor: 'system' }
      ).catch(() => {});
      return {
        reply: `I cannot agree a price or a discount. ${found.row.title} is listed ${listed}. Pricing is handled by our sales team: request a site visit and they can discuss your offer of ${formatInr(amount)}.`,
        visitFor: found.row.property_id
      };
    }
  }

  // ---- "what is the price of X": answer it, naming the listing, and show it if it is not already on screen ----
  if (asksPrice(t) && !negotiating) {
    const named = await findByName(supabase, t, config.propertiesTable).catch(() => null);
    let row = named;
    if (!row && !hasSearchIntent(t)) {
      const ref = referenced(t, shown);
      if (ref.ambiguous) return { reply: which(ref.ambiguous) };
      if (ref.property) row = (await getProperty(supabase, ref.property.id))?.row ?? null;
    }
    if (row) {
      const price = row.price_inr == null ? `listed as ${POR_LABEL}` : `${priceDisplay(row.price_inr)}`;
      const status = ['sold', 'reserved'].includes(row.status) ? ` It is currently ${row.status}.` : '';
      return {
        reply: row.price_inr == null ? `${row.title} is ${price}.${status}` : `The listed price of ${row.title} is ${price}.${status}`,
        cardFor: shown.some((p) => p.id === row.property_id) ? null : row.property_id
      };
    }
  }

  if (says('hours', asksHours)) {
    return { reply: `Our team confirms site visit requests ${config.businessHours}.` };
  }

  if (says('human', asksIfHuman)) {
    return { reply: 'I am an automated assistant. Our sales team are people, and they follow up when you request a site visit.' };
  }

  if (says('other_city', asksOtherCity)) {
    return { reply: 'We only handle property in Chennai. Tell me what you are looking for in Chennai and I will show you what we have.' };
  }

  if (says('count', asksCount)) {
    const { data, error } = await supabase.from(config.propertiesTable).select('category,status').limit(1000);
    if (error) throw error;
    const live = data.filter((p) => ['available', 'under_construction'].includes(p.status));
    const counts = {};
    for (const p of live) counts[p.category] = (counts[p.category] ?? 0) + 1;
    const parts = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${n} ${c.replace(/_/g, ' ')}`);
    return { reply: `We currently have ${live.length} properties listed: ${parts.join(', ')}. Tell me what you are looking for and I will show you the closest.` };
  }

  // A question about a fact of the listing ("is there a current tenant") is not about availability, whatever the label.
  if (route ? route.label === 'availability' && !topicOf(t) : asksAvailability(t)) {
    const ref = referenced(t, shown);
    if (ref.ambiguous) return { reply: which(ref.ambiguous) };
    if (ref.property) {
      const found = await getProperty(supabase, ref.property.id);
      if (!found) return { reply: `${ref.property.title} is no longer listed.` };
      const status = STATUS_WORDS[found.row.status] ?? found.row.status;
      return { reply: `${found.row.title} is listed as ${status}.${found.row.status === 'sold' ? ' It is no longer available.' : ''}` };
    }
  }

  if (VISIT_TIME.test(t)) {
    const ref = referenced(t, shown);
    return {
      reply: `I cannot set a time myself. Request a site visit and our team will confirm a time (${config.businessHours}).`,
      visitFor: ref.property?.id ?? null
    };
  }

  if (COMPARE.test(t)) {
    if (shown.length < 2) return { reply: 'Tell me what you are looking for and I will show you a few options to compare.' };
    const rows = (await Promise.all(shown.map((p) => getProperty(supabase, p.id)))).filter(Boolean);
    const lines = rows.map(({ view }, i) =>
      `${i + 1}) ${view.title}: ${view.priceDisplay}${view.bedrooms ? `, ${view.bedrooms} BHK` : ''}, ${view.location}${view.status !== 'available' ? `, ${view.statusLabel.toLowerCase()}` : ''}`
    );
    return { reply: `I cannot say which is better, because it depends on what matters to you. Here is how they compare:\n${lines.join('\n')}\n\nTell me what matters most, such as budget, area or size, and I will narrow it down.` };
  }

  // ---- questions we may or may not be able to answer ----
  const topic = topicOf(t);
  if (!topic) return null;

  if (topic.kind === 'listing_detail') {
    const ref = referenced(t, shown);
    if (ref.none) return { reply: 'Which property do you mean? Tell me what you are looking for and I will show you, and then you can ask about it.' };
    if (ref.ambiguous) return { reply: which(ref.ambiguous) };

    const found = await getProperty(supabase, ref.property.id);
    if (!found) return { reply: `${ref.property.title} is no longer listed.` };
    const { row } = found;
    const place = locateProperty(row.location ?? '').locality?.name ?? String(row.location ?? '').split(',')[0].trim();

    if (topic.key === 'address') {
      const entry = await findEntry(supabase, { topic: topic.key, propertyId: row.property_id, area: place });
      if (entry) return serve(supabase, entry);
      return gapReply({ supabase, lead, text: t, topic, shown, property: row, area: place, reply: `The listing gives the area only: ${row.location}. I do not have the exact address.` });
    }

    const lines = fieldAnswer(row.metadata, topic);
    if (lines.length) return { reply: `For ${row.title}: ${lines.join('; ')}.` };

    // The title is part of the listing. If it names the topic, say so instead of claiming the listing is silent.
    if (topic.re.test(row.title)) {
      return { reply: `The listing title says "${row.title}". It gives no further detail on ${topic.label}. ${config.teamConfirmLine ?? 'Our team can confirm it at a site visit.'}` };
    }

    const entry = await findEntry(supabase, { topic: topic.key, propertyId: row.property_id, area: place });
    if (entry) return serve(supabase, entry);
    return gapReply({
      supabase, lead, text: t, topic, shown, property: row, area: place,
      reply: `The listing for ${row.title} does not mention ${topic.label}. ${config.teamConfirmLine ?? 'Our team can confirm it at a site visit.'}`
    });
  }

  if (topic.kind === 'area_info') {
    const ref = referenced(t, shown);
    const named = resolveArea(t)?.name ?? null;
    let area = named;
    if (!area && ref.property) {
      const place = locateProperty(ref.property.location ?? '');
      area = place.locality?.name ?? null;
    }
    const entry = await findEntry(supabase, { topic: topic.key, area });
    if (entry) return serve(supabase, entry);
    return gapReply({ supabase, lead, text: t, topic, shown, area, reply: DEFAULT_REPLIES.area_info(topic.label) });
  }

  // policy
  const entry = await findEntry(supabase, { topic: topic.key });
  if (entry) return serve(supabase, entry);
  return gapReply({ supabase, lead, text: t, topic, shown, reply: DEFAULT_REPLIES[topic.key]() });
}

async function serve(supabase, entry) {
  await markServed(supabase, entry).catch(() => {});
  return { reply: entry.answer, servedEntryId: entry.id };
}

// We cannot answer. Say so, and save the question and its context for an owner to fill in.
async function gapReply({ supabase, lead, text, topic, shown, property = null, area = null, reply }) {
  let gapId = null;
  try {
    gapId = await recordGap(supabase, {
      customerId: lead.customerId,
      isTest: lead.isTest === true,
      question: text,
      kind: topic.kind,
      topic: topic.key,
      propertyId: property?.property_id ?? null,
      area,
      request: {
        question: text,
        topic: topic.key,
        kind: topic.kind,
        property: property ? { id: property.property_id, title: property.title, location: property.location } : null,
        area,
        shown: shown.map((p) => ({ id: p.id, title: p.title })),
        leadStage: lead.leadStage,
        assistantReply: reply
      }
    });
  } catch (error) {
    console.error('Could not save a knowledge gap:', error.message);
  }
  return { reply, gapId };
}
