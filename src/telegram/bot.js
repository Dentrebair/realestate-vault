// Wires Telegram updates to the handlers above.
import { Bot } from 'grammy';
import { createOpenAI } from '@ai-sdk/openai';
import { handleCallback } from './callbacks.js';
import { contact, forget, help, mydata, privacy, reset, saved, start } from './commands.js';
import { HELP, NON_TEXT, RATE_LIMIT_PER_HOUR } from './copy.js';
import { createDedupe, createQueue, createRateLimiter } from './guards.js';
import { log } from './log.js';
import { handleText } from './pipeline.js';
import { createDeps } from './agent.js';

export const ALLOWED_UPDATES = ['message', 'callback_query'];

export const COMMANDS = [
  { command: 'start', description: 'Open the menu and browse properties' },
  { command: 'saved', description: 'Your shortlisted properties' },
  { command: 'reset', description: 'Start over with a fresh conversation' },
  { command: 'privacy', description: 'How your data is used' },
  { command: 'mydata', description: 'What we hold about you' },
  { command: 'forget', description: 'Delete your data' },
  { command: 'help', description: 'What I can do' }
];

// `ai` is for tests: { generate, model, providerOptions } replaces the real model.
// Telegram answers 429 when a chat is sent to too fast, and says how long to wait. Nothing was sent, so waiting
// and sending again is safe. Other failures are not retried: the message may already have gone out.
export function retryWhenBusy({ attempts = 3, maxWaitMs = 5000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  return async (previous, method, payload, signal) => {
    for (let attempt = 1; ; attempt++) {
      const result = await previous(method, payload, signal);
      if (result.ok || result.error_code !== 429 || attempt >= attempts) return result;
      await sleep(Math.min((result.parameters?.retry_after ?? 1) * 1000, maxWaitMs));
    }
  };
}

export function createBot({ token, botInfo, supabase, config, ai }) {
  const bot = new Bot(token, botInfo ? { botInfo } : undefined);
  bot.api.config.use(retryWhenBusy());

  const agent = createDeps({
    timeoutMs: config.agentTimeoutMs,
    ...(ai ?? modelFrom(config))
  });
  const deps = {
    supabase,
    api: bot.api,
    config,
    agent,
    allow: createRateLimiter({ limit: RATE_LIMIT_PER_HOUR })
  };

  const isDuplicate = createDedupe();
  const enqueue = createQueue();

  bot.use(async (ctx, next) => {
    if (isDuplicate(ctx.update.update_id)) return;
    if (ctx.chat?.type !== 'private' || !ctx.from || ctx.from.is_bot) return;
    // One message at a time per chat, so two quick messages cannot race. Taps get their own lane.
    const lane = ctx.callbackQuery ? `${ctx.chat.id}:tap` : `${ctx.chat.id}`;
    await enqueue(lane, next);
  });

  bot.command('start', (ctx) => start(ctx, deps));
  bot.command('help', help);
  bot.command('privacy', (ctx) => privacy(ctx, deps));
  bot.command('mydata', (ctx) => mydata(ctx, deps));
  bot.command('forget', forget);
  bot.command('reset', (ctx) => reset(ctx, deps));
  bot.command('saved', (ctx) => saved(ctx, deps));

  bot.on('callback_query:data', (ctx) => handleCallback(ctx, deps));
  bot.on('message:contact', (ctx) => contact(ctx, deps));
  bot.on('message:text', (ctx) =>
    ctx.message.text.startsWith('/') ? ctx.reply(HELP) : handleText(ctx, deps)
  );
  bot.on('message', (ctx) => ctx.reply(NON_TEXT));

  bot.catch((error) => {
    log('handler_error', { updateId: error.ctx?.update?.update_id, error: error.error?.message }, 'error');
  });

  return bot;
}

export function modelFrom(config) {
  if (!config.openaiApiKey) return {};
  const openai = createOpenAI({ apiKey: config.openaiApiKey });
  const reasoning = /^(gpt-5(?!-chat)|o\d)/.test(config.openaiModel) && !/chat/.test(config.openaiModel);
  return {
    model: openai(config.openaiModel),
    providerOptions: reasoning ? { openai: { reasoningEffort: config.openaiReasoningEffort } } : undefined,
    // Reasoning models reject temperature, so it is only passed to the others.
    temperature: reasoning ? undefined : config.openaiTemperature
  };
}
