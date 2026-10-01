// A text message from a Lead: guards, memory, the model, and the reply.
import { setBotState, setStage } from '../leadMemory.js';
import { runAgentTurn } from './agent.js';
import { FALLBACK, MAX_MESSAGE_CHARS, OFF_TOPIC, PHOTOS_GENERAL, RATE_LIMITED, TOO_LONG, photosAnswer } from './copy.js';
import { loadPhotos } from '../photos.js';
import { loadHistory, saveMessage } from './history.js';
import { log } from './log.js';
import { asksAboutPhotos, isNegotiation } from './intent.js';
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

  const lead = await ensureLead(supabase, ctx.from);

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
  if (isNegotiation(text)) {
    await setStage(supabase, customerId, 'negotiating', {
      actor: 'system',
      reason: 'asked about price or a discount'
    }).catch((error) => log('stage_failed', { customerId, error: error.message }, 'error'));
  }

  // "Do you have images?" is a question about data, so code answers it from the data.
  if (asksAboutPhotos(text)) {
    const shown = lead.botState?.shown ?? [];
    const found = shown.length ? await loadPhotos(supabase, shown.map((p) => p.id)).catch(() => new Map()) : new Map();
    const answer = shown.length
      ? photosAnswer(shown.map((p) => ({ title: p.title, count: found.get(p.id)?.length ?? 0 })))
      : PHOTOS_GENERAL;
    await saveMessage(supabase, customerId, 'user', text);
    await ctx.reply(answer);
    await saveMessage(supabase, customerId, 'assistant', answer);
    return;
  }

  const stopTyping = keepTyping(api, chatId);
  try {
    const history = await loadHistory(supabase, customerId);
    await saveMessage(supabase, customerId, 'user', text);

    const turn = await runAgentTurn({ deps: deps.agent, supabase, api, chatId, lead, history, text });

    await ctx.reply(turn.text);
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
