import { createClient } from '@supabase/supabase-js';
import { config, isSupabaseConfigured } from './config.js';

export function createSupabaseClient() {
  if (!isSupabaseConfigured) {
    return null;
  }

  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    },
    db: {
      schema: config.supabaseSchema
    }
  });
}
