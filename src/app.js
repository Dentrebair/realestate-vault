import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { config, isSupabaseConfigured, telegramMode as defaultTelegramMode } from './config.js';
import { buildOpenAiTools, buildOpenApiDocument } from './openapi.js';
import { leadMemorySchema, upsertLeadMemory } from './leadMemory.js';
import { propertySearchSchema, searchProperties } from './propertySearch.js';
import { createAdminRouter } from './admin/routes.js';
import { createSupabaseAuth } from './admin/auth.js';
import { createSupabaseClient } from './supabase.js';
import { webhookHandler } from './telegram/webhook.js';

export function createApp({
  supabase = createSupabaseClient(),
  telegramBot = null,
  inbox = null,
  telegramMode = defaultTelegramMode,
  telegramSecret = config.telegramWebhookSecret,
  enableToolRoutes = config.enableToolRoutes,
  admin = defaultAdmin(supabase)
} = {}) {
  const app = express();
  // Behind Railway's proxy every request would otherwise appear to come from the proxy, so the sign-in limiter would lock
  // everyone out together. One hop is trusted.
  if (config.nodeEnv === 'production') app.set('trust proxy', 1);

  // Photos are served from Supabase Storage, so the board page may load images from there.
  const imageHosts = config.supabaseUrl ? [new URL(config.supabaseUrl).origin] : [];
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          'img-src': ["'self'", 'data:', 'blob:', ...imageHosts]
        }
      }
    })
  );
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_request, response) => {
    response.json({
      ok: true,
      service: 'real-estate-meta-business-agent-connector',
      supabaseConfigured: isSupabaseConfigured,
      telegramConfigured: Boolean(telegramBot),
      // Without this nobody is told about a visit request, an offer or a question. Set SALES_DESK_CHAT_ID.
      teamAlertsConfigured: Boolean(config.salesDeskChatId),
      // Which commit is running, so a deploy that did not pick up the latest code is easy to spot.
      commit: (process.env.RAILWAY_GIT_COMMIT_SHA ?? '').slice(0, 7) || undefined
    });
  });

  // For an outside monitor: is the bot able to do its job? Checks the database and that Telegram can still deliver to us.
  // The answer is kept for 30 seconds so the page cannot be used to hammer the database or Telegram.
  let ready = { at: 0, body: null, status: 200 };
  app.get('/health/ready', async (_request, response) => {
    if (Date.now() - ready.at > 30000) ready = { at: Date.now(), ...(await checkReady({ supabase, telegramBot, telegramMode })) };
    response.status(ready.status).json(ready.body);
  });

  app.get('/openapi.json', (request, response) => {
    response.json(buildOpenApiDocument(`${request.protocol}://${request.get('host')}`));
  });

  app.get('/openai-tools.json', (_request, response) => {
    response.json(buildOpenAiTools());
  });

  // The lead board for staff. Its own sign-in; it never shares a secret with the tool routes.
  if (admin) {
    // A reply written on the board is delivered by the bot, so the router is given its Telegram client.
    app.use('/admin', createAdminRouter({ supabase, ...admin, telegram: telegramBot ? { api: telegramBot.api, config } : null }));
  }

  if (telegramBot) {
    app.post('/telegram/webhook', webhookHandler(telegramBot, telegramSecret, inbox));
  }

  // The tool routes are for chat agents that call this service over HTTP (the WhatsApp setup).
  // The Telegram bot calls the same code directly, so in production they stay off unless asked for.
  if (enableToolRoutes) {
    app.post('/tools/search-properties', requireBearerToken, async (request, response, next) => {
      const parsed = propertySearchSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return response.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      }
      try {
        return response.json(await searchProperties(supabase, parsed.data));
      } catch (error) {
        return next(error);
      }
    });

    app.post('/tools/upsert-lead-memory', requireBearerToken, async (request, response, next) => {
      const parsed = leadMemorySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return response.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      }
      try {
        return response.json(await upsertLeadMemory(supabase, parsed.data));
      } catch (error) {
        return next(error);
      }
    });
  }

  app.use((error, _request, response, _next) => {
    const statusCode = error.statusCode ?? 500;
    // Upstream messages can name tables and columns; keep them out of responses in production.
    const showDetail = config.nodeEnv !== 'production' || statusCode < 500;
    response.status(statusCode).json({
      error: statusCode === 500 ? 'internal_error' : 'upstream_error',
      message: showDetail ? error.message : 'Something went wrong.'
    });
  });

  return app;
}

async function checkReady({ supabase, telegramBot, telegramMode }) {
  const body = { ok: true, database: 'skipped', webhook: 'skipped' };

  if (supabase) {
    try {
      const { error } = await withTimeout(supabase.from(config.propertiesTable).select('property_id').limit(1));
      body.database = error ? 'down' : 'ok';
    } catch {
      body.database = 'down';
    }
  }

  // In webhook mode Telegram must know our address, and must not be failing to reach it.
  if (telegramBot && telegramMode === 'webhook') {
    try {
      const info = await withTimeout(telegramBot.api.getWebhookInfo());
      const recentError = info.last_error_date && Date.now() / 1000 - info.last_error_date < 15 * 60;
      body.webhook = !info.url ? 'missing' : recentError ? 'erroring' : 'ok';
      body.pendingUpdates = info.pending_update_count ?? 0;
      if (body.webhook === 'erroring') body.lastError = String(info.last_error_message ?? '').slice(0, 120);
    } catch {
      body.webhook = 'unknown';
    }
  }

  body.ok = body.database !== 'down' && !['missing', 'erroring', 'unknown'].includes(body.webhook);
  return { body, status: body.ok ? 200 : 503 };
}

const withTimeout = (promise, ms = 8000) =>
  Promise.race([promise, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timed out')), ms).unref())]);

function defaultAdmin(supabase) {
  if (!supabase || !config.supabaseUrl || !config.supabaseAnonKey) return null;
  return {
    auth: createSupabaseAuth({ url: config.supabaseUrl, anonKey: config.supabaseAnonKey }),
    showConversations: config.boardShowConversations,
    secureCookies: config.nodeEnv === 'production'
  };
}

function sameSecret(given, expected) {
  const a = createHash('sha256').update(String(given ?? '')).digest();
  const b = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

function requireBearerToken(request, response, next) {
  if (!config.connectorBearerToken) {
    return next();
  }
  const header = request.get('authorization') ?? '';
  if (!sameSecret(header, `Bearer ${config.connectorBearerToken}`)) {
    return response.status(401).json({ error: 'unauthorized' });
  }
  return next();
}
