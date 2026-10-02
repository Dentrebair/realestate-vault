// A text message from a Lead: guards, memory, the model, and the reply.
import { setBotState, setStage } from '../leadMemory.js';
import { runAgentTurn } from './agent.js';
import { FALLBACK, MAX_MESSAGE_CHARS, OFF_TOPIC, RATE_LIMITED, TOO_LONG } from './copy.js';
import { loadPhotos } from '../photos.js';
import { getProperty } from '../propertySearch.js';
import { visitPrompt } from './cards.js';
import { answerFromData } from './gateway.js';
import { rememberShown, sendCard } from './present.js';
import { loadHistory, saveMessage } from './history.js';
import { log } from './log.js';
import { consentPrompt, needsConsent } from './consent.js';
import { judgeNegotiation } from './negotiation.js';
import { customerIdOf, ensureLead } from './lead.js';
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
  const judged = await judgeNegotiation({ text, shown: lead.botState?.shown ?? [], deps: deps.agent });
  if (judged.negotiating) {
    await setStage(supabase, customerId, 'negotiating', {
      actor: 'system',
      reason: judged.offer ? 'made a price offer' : 'asked about price or a discount'
    }).catch((error) => log('stage_failed', { customerId, error: error.message }, 'error'));
  }

  // Factual questions are answered from data, before the model is asked anything. If we cannot answer,
  // the question is saved as a knowledge gap for the business owners to fill in.
  try {
    const answered = await answerFromData({ text, lead, supabase, config, intent: judged });
    if (answered) {
      await saveMessage(supabase, customerId, 'user', text);
      await ctx.reply(answered.reply);
      await saveMessage(supabase, customerId, 'assistant', answered.reply);
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

    await ctx.reply(turn.text);
    await turn.sendCards?.();
    await saveMessage(supabase, customerId, 'assistant', turn.text, { shown: turn.shown.map((s) => s.id) });
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
