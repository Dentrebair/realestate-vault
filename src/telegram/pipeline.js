// A text message from a Lead: guards, memory, the model, and the reply.
import { setBotState, setStage } from '../leadMemory.js';
import { formatInr } from '../money.js';
import { runAgentTurn } from './agent.js';
import { FALLBACK, MAX_MESSAGE_CHARS, OFF_TOPIC, RATE_LIMITED, TEAM_ACK, TOO_LONG } from './copy.js';
import { hasSearchIntent } from './facts.js';
import { loadPhotos } from '../photos.js';
import { getProperty } from '../propertySearch.js';
import { visitPrompt } from './cards.js';
import { answerFromData, referenced } from './gateway.js';
import { rememberShown, sendCard } from './present.js';
import { loadHistory, saveMessage } from './history.js';
import { log } from './log.js';
import { consentPrompt, needsConsent } from './consent.js';
import { judgeNegotiation } from './negotiation.js';
import { routeMessage } from './router.js';
import { customerIdOf, ensureLead } from './lead.js';
import { raiseHandoff, relayCustomer } from './handoff.js';
import { failureAlert, notifySales } from './sales.js';
import { scopeOf } from './scope.js';

export async function handleText(ctx, deps) {
  const { supabase, api, config } = deps;
  const text = ctx.message.text.trim();
  const chatId = ctx.chat.id;
  const customerId = customerIdOf(ctx.from);
  const started = Date.now();

  if (text.length > MAX_MESSAGE_CHARS) return ctx.reply(TOO_LONG);
  if (!deps.allow(customerId)) return ctx.reply(RATE_LIMITED);

  const lead = await ensureLead(supabase, ctx.from, { config });

  // Until they agree to the privacy notice, nothing they say is kept or sent to the AI.
  if (needsConsent(lead, config)) {
    const prompt = consentPrompt(config);
    await ctx.reply(prompt.text, { reply_markup: prompt.keyboard });
    return;
  }

  // Only someone we know nothing about is checked. A lead who already has a profile is on topic.
  if (lead.botState?.scope !== 'on_topic' && lead.leadStage !== 'initiated') {
    await setBotState(supabase, customerId, { scope: 'on_topic' });
    lead.botState = { ...lead.botState, scope: 'on_topic' };
  }
  if (lead.botState?.scope !== 'on_topic') {
    const verdict = await scopeOf(text, deps.agent);
    if (verdict === 'off_topic') {
      // One polite line, then silence until they ask about property.
      if (lead.botState?.scope !== 'off_topic') {
        await setBotState(supabase, customerId, { scope: 'off_topic' });
        await ctx.reply(OFF_TOPIC);
      }
      return;
    }
    await setBotState(supabase, customerId, { scope: 'on_topic' });
    lead.botState = { ...lead.botState, scope: 'on_topic' };
  }

  // Asking for a discount is negotiation whether or not the model notices. Code does not rely on it.
  // Is the customer negotiating, and did they make an offer? The model decides; code then enforces what follows.
  // The two model reads of the message run side by side, so the customer waits for one, not two.
  const shownNow = lead.botState?.shown ?? [];
  const [judged, route] = await Promise.all([
    judgeNegotiation({ text, shown: shownNow, deps: deps.agent }),
    routeMessage({ text, shown: shownNow, deps: deps.agent })
  ]);
  // The customer answers something the team wrote: the team sees it on the same thread. The bot carries on as normal.
  const relayed = await relayCustomer({ deps, lead, text }).catch((error) => {
    log('relay_failed', { customerId, error: error.message }, 'error');
    return null;
  });

  let passedOn = false;
  if (judged.negotiating) {
    await setStage(supabase, customerId, 'negotiating', {
      actor: 'system',
      reason: judged.offer ? 'made a price offer' : 'asked about price or a discount'
    }).catch((error) => log('stage_failed', { customerId, error: error.message }, 'error'));

    // Price is the team's to decide, so they are told, with the offer if there was one.
    if (shownNow.length) {
      const ref = referenced(text, shownNow);
      const property = ref.property ?? (shownNow.length === 1 ? shownNow[0] : null);
      const summary = judged.offer
        ? `Offered ${formatInr(judged.offer)}${property ? ` for ${property.title} (listed ${property.priceDisplay})` : ''}`
        : `Asked about a discount or whether the price can change${property ? ` on ${property.title} (listed ${property.priceDisplay})` : ''}`;
      const raised = await raiseHandoff({ deps, lead, kind: 'offer', summary, property }).catch((error) => {
        log('handoff_failed', { customerId, error: error.message }, 'error');
        return null;
      });
      passedOn = Boolean(raised && (raised.handoff || raised.alerted));
    }
  }

  // A short reply to what the team wrote ("Saturday works") is for the team. The assistant only says it was passed on,
  // so it does not guess at times or prices. A question, a search or an offer still gets its normal handling.
  const words = text.trim().split(/\s+/).length;
  if (relayed && !judged.negotiating && words <= 12 && !text.includes('?') && !hasSearchIntent(text)) {
    await saveMessage(supabase, customerId, 'user', text);
    await ctx.reply(TEAM_ACK);
    await saveMessage(supabase, customerId, 'assistant', TEAM_ACK);
    return;
  }

  // Factual questions are answered from data, before the model is asked anything. If we cannot answer,
  // the question is saved as a knowledge gap for the business owners to fill in.
  try {
    const answered = await answerFromData({ text, lead, supabase, config, intent: judged, route });
    if (answered) {
      let reply = answered.reply;
      if (answered.passedReply && passedOn) reply = answered.passedReply;
      if (answered.handoff) {
        const raised = await raiseHandoff({ deps, lead, kind: answered.handoff.kind, summary: answered.handoff.summary, property: answered.handoff.property ?? null }).catch((error) => {
          log('handoff_failed', { customerId, error: error.message }, 'error');
          return null;
        });
        if (raised && (raised.handoff || raised.alerted)) reply = answered.handoff.doneReply ?? reply;
      }
      await saveMessage(supabase, customerId, 'user', text);
      await ctx.reply(reply);
      await saveMessage(supabase, customerId, 'assistant', reply);
      if (answered.cardFor) {
        const found = await getProperty(supabase, answered.cardFor);
        if (found) {
          const photos = (await loadPhotos(supabase, [found.row.property_id]).catch(() => new Map())).get(found.row.property_id) ?? [];
          await sendCard(api, chatId, { ...found.view, kind: 'match', photoCount: photos.length }, {
            saved: (lead.shortlistedPropertyIds ?? []).includes(found.row.property_id),
            photos
          });
          await setBotState(supabase, customerId, { shown: rememberShown([{ ...found.view, photoCount: photos.length }]) });
        }
      }
      if (answered.visitFor) {
        const found = await getProperty(supabase, answered.visitFor);
        if (found) {
          const prompt = visitPrompt(found.view);
          await api.sendMessage(chatId, prompt.text, { parse_mode: 'HTML', reply_markup: prompt.keyboard });
        }
      }
      log('answered_from_data', { customerId, gap: Boolean(answered.gapId), served: Boolean(answered.servedEntryId) });
      return;
    }
  } catch (error) {
    log('gateway_failed', { customerId, error: error.message }, 'error');
  }

  const stopTyping = keepTyping(api, chatId);
  try {
    const history = await loadHistory(supabase, customerId);
    await saveMessage(supabase, customerId, 'user', text);

    const turn = await runAgentTurn({ deps: deps.agent, supabase, api, chatId, lead, history, text });

    let replyText = turn.text;
    if (turn.gapNoted) {
      // The assistant had to say "I do not have that": the team is told, and so is the customer.
      const property = turn.shown.length === 1 ? turn.shown[0] : null;
      const raised = await raiseHandoff({ deps, lead, kind: 'question', summary: text.slice(0, 300), property }).catch((error) => {
        log('handoff_failed', { customerId, error: error.message }, 'error');
        return null;
      });
      if (raised && (raised.handoff || raised.alerted)) replyText = `${replyText} I have also passed your question to our team.`;
    }
    await ctx.reply(replyText);
    await turn.sendCards?.();
    await saveMessage(supabase, customerId, 'assistant', replyText, { shown: turn.shown.map((s) => s.id) });
    log('turn', { customerId, ms: Date.now() - started, blocked: turn.blocked, usage: turn.usage });
  } catch (error) {
    log('turn_failed', { customerId, ms: Date.now() - started, error: error.message }, 'error');
    await ctx.reply(FALLBACK);
    await notifySales(api, config.salesDeskChatId, failureAlert(lead, error.message));
  } finally {
    stopTyping();
  }
}

// Telegram clears the "typing" status after about five seconds, so repeat it while we work.
function keepTyping(api, chatId) {
  const send = () => api.sendChatAction(chatId, 'typing').catch(() => {});
  send();
  const timer = setInterval(send, 4000);
  return () => clearInterval(timer);
}

export { log };
