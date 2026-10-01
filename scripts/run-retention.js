// Runs the retention clean-up once, now. The server also does this every six hours.
//   npm run retention
import 'dotenv/config';
import { config } from '../src/config.js';
import { runRetention } from '../src/privacy.js';
import { createSupabaseClient } from '../src/supabase.js';

const supabase = createSupabaseClient();
if (!supabase) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  process.exit(1);
}
console.log(`Keeping messages for ${config.chatRetentionHours} hours and idle real leads for ${config.leadRetentionHours} hours. Test leads are never removed.`);
console.log('Removed:', await runRetention(supabase, { chatHours: config.chatRetentionHours, leadHours: config.leadRetentionHours }));
