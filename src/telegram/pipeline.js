// A text message from a Lead: guards, memory, the model, and the reply.
import { setBotState } from '../leadMemory.js';
import { runAgentTurn } from './agent.js';
import { FALLBACK, MAX_MESSAGE_CHARS, OFF_TOPIC, RATE_LIMITED, TOO_LONG } from './copy.js';
import { loadHistory, saveMessage } from './history.js';
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

export function log(event, fields = {}, level = 'info') {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...fields });
  (level === 'error' ? console.error : console.log)(line);
}
