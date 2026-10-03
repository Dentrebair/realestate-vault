import { createApp } from './app.js';
import { config, isSupabaseConfigured, isTelegramConfigured, telegramMode } from './config.js';
import { startRetention } from './privacy.js';
import { createSupabaseClient } from './supabase.js';
import { ALLOWED_UPDATES, COMMANDS, createBot } from './telegram/bot.js';
import { createInbox } from './telegram/inbox.js';
import { startAlertRetry } from './telegram/sales.js';
import { drain, startRecovery } from './telegram/webhook.js';

function refuse(message) {
  console.error(`Refusing to start: ${message}`);
  process.exit(1);
}

if (config.nodeEnv === 'production') {
  if (config.enableToolRoutes && !config.connectorBearerToken) {
    refuse('CONNECTOR_BEARER_TOKEN is required in production while the tool routes are enabled.');
  }
  if (isTelegramConfigured && !isSupabaseConfigured) {
    refuse('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to run the Telegram bot.');
  }
}

const supabase = createSupabaseClient();

let bot = null;
if (isTelegramConfigured && isSupabaseConfigured && config.openaiApiKey) {
  bot = createBot({ token: config.telegramBotToken, supabase, config });
} else if (isTelegramConfigured) {
  console.warn('Telegram is configured but Supabase or OPENAI_API_KEY is missing; the bot is not started.');
}

if (supabase) startRetention(supabase, config);
if (config.nodeEnv === 'production' && isTelegramConfigured && (!process.env.BUSINESS_NAME || !process.env.PRIVACY_CONTACT)) {
  console.warn('BUSINESS_NAME and PRIVACY_CONTACT are not set. The privacy notice will not name the business or say how to reach it.');
}

// Webhook updates are written down before they are answered, so a crash or a deploy cannot lose one.
const inbox = bot && supabase && telegramMode === 'webhook' ? createInbox({ supabase }) : null;
const app = createApp({ supabase, telegramBot: bot, inbox });
const server = app.listen(config.port, () => {
  console.log(`Connector listening on port ${config.port} (${config.nodeEnv})`);
});

if (bot) {
  if (inbox) startRecovery(bot, inbox);
  startAlertRetry({ supabase, api: bot.api, chatId: config.salesDeskChatId });
  await bot.init();
  await bot.api.setMyCommands(COMMANDS);

  if (telegramMode === 'polling') {
    await bot.api.deleteWebhook();
    bot.start({
      allowed_updates: ALLOWED_UPDATES,
      onStart: (me) => console.log(`Telegram bot @${me.username} is polling for messages`)
    });
  } else if (config.publicBaseUrl) {
    const url = `${config.publicBaseUrl}/telegram/webhook`;
    await bot.api.setWebhook(url, {
      secret_token: config.telegramWebhookSecret,
      allowed_updates: ALLOWED_UPDATES
    });
    console.log(`Telegram webhook set to ${url}`);
  } else {
    console.warn('Telegram webhook mode needs PUBLIC_BASE_URL (or RAILWAY_PUBLIC_DOMAIN); the webhook was not set.');
  }
}

// Railway sends SIGTERM when it replaces a deploy. Stop taking new work and let in-flight replies finish.
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  const deadline = setTimeout(() => process.exit(1), 15000);
  deadline.unref();
  if (bot && telegramMode === 'polling') await bot.stop();
  // Replies already being written are allowed to finish. Anything cut off is picked up again from the inbox.
  const left = await drain(12000);
  if (left) console.warn(`${left} updates were still being answered; they will be retried on the next start.`);
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
