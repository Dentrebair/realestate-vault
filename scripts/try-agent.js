// Runs messages through the real model with an in-memory database, printing what the customer would see.
// Nothing is written to Supabase and nothing is sent to Telegram.
//
//   node scripts/try-agent.js "3BHK in OMR under 1.5 crore" "what about Anna Nagar?"
import 'dotenv/config';
import { createBot } from '../src/telegram/bot.js';
import { config } from '../src/config.js';
import { properties } from '../test/fixtures/properties.js';
import { createFakeSupabase } from '../test/helpers/fakeSupabase.js';

const messages = process.argv.slice(2);
if (!messages.length) {
  console.error('Usage: node scripts/try-agent.js "message 1" "message 2" ...');
  process.exit(1);
}

const supabase = createFakeSupabase({ properties });
const bot = createBot({
  token: '123:local',
  botInfo: { id: 1, is_bot: true, first_name: 'Local', username: 'local', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false },
  supabase,
  config: { ...config, salesDeskChatId: 999 }
});

let n = 0;
bot.api.config.use(async (_prev, method, payload) => {
  if (method === 'sendMessage') {
    const buttons = payload.reply_markup?.inline_keyboard?.flat().map((b) => `[${b.text}]`).join(' ');
    console.log(`\n  BOT${payload.chat_id === 999 ? ' (sales desk)' : ''}: ${payload.text.replace(/<[^>]+>/g, '').replace(/\n/g, '\n       ')}${buttons ? `\n       ${buttons}` : ''}`);
    return { ok: true, result: { message_id: ++n, date: 0, chat: { id: payload.chat_id, type: 'private' }, text: payload.text } };
  }
  return { ok: true, result: true };
});

for (const text of messages) {
  console.log(`\nYOU: ${text}`);
  const started = Date.now();
  await bot.handleUpdate({
    update_id: ++n,
    message: { message_id: ++n, date: 0, chat: { id: 1, type: 'private' }, from: { id: 1, is_bot: false, first_name: 'Tester' }, text }
  });
  console.log(`  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

const lead = supabase.tables.customer_leads?.[0];
console.log('\n--- saved lead ---');
console.log(JSON.stringify({ stage: lead?.lead_stage, budget: [lead?.budget_min, lead?.budget_max], areas: lead?.preferred_locations, categories: lead?.property_categories, bedrooms: lead?.bedrooms, dealBreakers: lead?.deal_breakers, keyPoints: lead?.key_points }, null, 1));
