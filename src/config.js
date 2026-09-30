import 'dotenv/config';
import { z } from 'zod';

const configSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  nodeEnv: z.string().default('development'),
  supabaseUrl: z.string().url().optional(),
  supabaseServiceRoleKey: z.string().min(1).optional(),
  connectorBearerToken: z.string().min(1).optional(),
  supabaseSchema: z.string().min(1).default('public'),
  propertiesTable: z.string().min(1).default('properties'),
  searchColumns: z
    .string()
    .min(1)
    .default('title,location,category,status,raw_listing_text')
    .transform((value) =>
      value
        .split(',')
        .map((column) => column.trim())
        .filter(Boolean)
    ),
  orderColumn: z.string().min(1).optional()
});

export const config = configSchema.parse({
  port: process.env.PORT,
  nodeEnv: process.env.NODE_ENV,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  connectorBearerToken: process.env.CONNECTOR_BEARER_TOKEN || undefined,
  supabaseSchema: process.env.SUPABASE_SCHEMA,
  propertiesTable: process.env.PROPERTIES_TABLE,
  searchColumns: process.env.SEARCH_COLUMNS || process.env.LOCATION_COLUMNS,
  orderColumn: process.env.ORDER_COLUMN || undefined
});

export const isSupabaseConfigured =
  Boolean(config.supabaseUrl) && Boolean(config.supabaseServiceRoleKey);
