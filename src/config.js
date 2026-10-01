import 'dotenv/config';
import { z } from 'zod';

const blank = (value) => (value === '' ? undefined : value);

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

export const config = configSchema.parse({
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
  publicBaseUrl: blank(process.env.PUBLIC_BASE_URL) ?? (publicDomain ? `https://${publicDomain}` : undefined),
  salesDeskChatId: blank(process.env.SALES_DESK_CHAT_ID),
  businessHours: blank(process.env.BUSINESS_HOURS),
  teamConfirmLine: blank(process.env.TEAM_CONFIRM_LINE),

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

export const isSupabaseConfigured =
  Boolean(config.supabaseUrl) && Boolean(config.supabaseServiceRoleKey);

export const isTelegramConfigured =
  Boolean(config.telegramBotToken) && Boolean(config.telegramWebhookSecret);

// Polling needs no public address, so it is the default anywhere except production.
export const telegramMode = config.telegramMode ?? (config.nodeEnv === 'production' ? 'webhook' : 'polling');
