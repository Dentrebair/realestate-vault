import 'dotenv/config';
import { z } from 'zod';

const blank = (value) => (value === '' ? undefined : value);

// Tidies a web address people type into a settings page: quotes, spaces, a missing https://, a trailing path.
export function normalizeUrl(value) {
  if (value === undefined || value === null) return undefined;
  let url = String(value).trim().replace(/^["']+|["']+$/g, '').trim();
  if (!url) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

const configSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  nodeEnv: z.string().default('development'),
  supabaseUrl: z.string().url().optional(),
  supabaseServiceRoleKey: z.string().min(1).optional(),
  supabaseAnonKey: z.string().min(1).optional(),
  connectorBearerToken: z.string().min(1).optional(),
  supabaseSchema: z.string().min(1).default('public'),
  propertiesTable: z.string().min(1).default('properties'),

  // Telegram
  telegramBotToken: z.string().min(1).optional(),
  telegramWebhookSecret: z.string().min(16).optional(),
  telegramMode: z.enum(['polling', 'webhook']).optional(),
  publicBaseUrl: z.string().url().optional(),
  salesDeskChatId: z.coerce.number().int().optional(),
  businessHours: z.string().min(1).default('Mon to Sat, 10am to 7pm IST'),
  // Privacy. The notice names the business and says how to reach it; retention is how long data is kept.
  businessName: z.string().min(1).default('our property team'),
  privacyContact: z.string().min(1).optional(),
  requireConsent: z.boolean(),
  consentVersion: z.string().min(1).default('2026-10-draft-1'),
  chatRetentionHours: z.coerce.number().positive().default(24 * 30),
  leadRetentionHours: z.coerce.number().positive().default(24 * 365),

  // Said when the assistant does not have a detail. Only keep it if it is true for your team.
  teamConfirmLine: z.string().min(1).default('Our team can confirm it at a site visit.'),

  // AI
  openaiApiKey: z.string().min(1).optional(),
  openaiModel: z.string().min(1).default('gpt-5-mini'),
  openaiReasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).default('minimal'),
  agentTimeoutMs: z.coerce.number().int().positive().default(25000),
  // Only for non-reasoning models such as gpt-4.1-mini. Reasoning models (gpt-5, o-series) reject it.
  openaiTemperature: z.coerce.number().min(0).max(2).optional(),

  // Who may read the actual conversation on the lead board: test leads only, everyone, or nobody.
  boardShowConversations: z.enum(['test', 'all', 'none']).default('test'),

  // The WhatsApp-style tool routes are open to whoever holds the bearer token.
  enableToolRoutes: z.boolean()
});

const nodeEnv = blank(process.env.NODE_ENV) ?? 'development';
const publicDomain = blank(process.env.RAILWAY_PUBLIC_DOMAIN);

const parsed = configSchema.safeParse({
  port: blank(process.env.PORT),
  nodeEnv,
  supabaseUrl: blank(process.env.SUPABASE_URL),
  supabaseServiceRoleKey: blank(process.env.SUPABASE_SERVICE_ROLE_KEY),
  supabaseAnonKey: blank(process.env.SUPABASE_ANON_KEY),
  connectorBearerToken: blank(process.env.CONNECTOR_BEARER_TOKEN),
  supabaseSchema: blank(process.env.SUPABASE_SCHEMA),
  propertiesTable: blank(process.env.PROPERTIES_TABLE),

  telegramBotToken: blank(process.env.TELEGRAM_BOT_TOKEN),
  telegramWebhookSecret: blank(process.env.TELEGRAM_WEBHOOK_SECRET),
  telegramMode: blank(process.env.TELEGRAM_MODE),
  publicBaseUrl: normalizeUrl(blank(process.env.PUBLIC_BASE_URL) ?? publicDomain),
  salesDeskChatId: blank(process.env.SALES_DESK_CHAT_ID),
  businessHours: blank(process.env.BUSINESS_HOURS),
  teamConfirmLine: blank(process.env.TEAM_CONFIRM_LINE),
  businessName: blank(process.env.BUSINESS_NAME),
  privacyContact: blank(process.env.PRIVACY_CONTACT),
  requireConsent: blank(process.env.REQUIRE_CONSENT) === undefined ? true : process.env.REQUIRE_CONSENT !== 'false',
  consentVersion: blank(process.env.CONSENT_VERSION),
  chatRetentionHours: blank(process.env.CHAT_RETENTION_HOURS),
  leadRetentionHours: blank(process.env.LEAD_RETENTION_HOURS),

  openaiApiKey: blank(process.env.OPENAI_API_KEY),
  openaiModel: blank(process.env.OPENAI_MODEL),
  openaiReasoningEffort: blank(process.env.OPENAI_REASONING_EFFORT),
  agentTimeoutMs: blank(process.env.AGENT_TIMEOUT_MS),
  openaiTemperature: blank(process.env.OPENAI_TEMPERATURE),

  boardShowConversations: blank(process.env.BOARD_SHOW_CONVERSATIONS),

  enableToolRoutes:
    blank(process.env.ENABLE_TOOL_ROUTES) !== undefined
      ? process.env.ENABLE_TOOL_ROUTES === 'true'
      : nodeEnv !== 'production'
});

if (!parsed.success) {
  console.error('The settings are not valid:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.') || '(settings)'}: ${issue.message}`);
  console.error('Fix the variables named above and redeploy.');
  process.exit(1);
}

export const config = parsed.data;

export const isSupabaseConfigured =
  Boolean(config.supabaseUrl) && Boolean(config.supabaseServiceRoleKey);

export const isTelegramConfigured =
  Boolean(config.telegramBotToken) && Boolean(config.telegramWebhookSecret);

// Polling needs no public address, so it is the default anywhere except production.
export const telegramMode = config.telegramMode ?? (config.nodeEnv === 'production' ? 'webhook' : 'polling');
