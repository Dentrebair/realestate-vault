// Seed, clean or adopt the 50 test leads.
//
//   node scripts/seed-test-leads.js --dry              check the fixture against live properties, write nothing
//   node scripts/seed-test-leads.js                    insert or refresh all 50 (safe to re-run)
//   node scripts/seed-test-leads.js --clean            delete every test lead (customer_id 'test:%' and is_test)
//   node scripts/seed-test-leads.js --adopt 016 12345  copy test lead 016 onto telegram:12345 so you can chat as them
//
// Needs sql/001_prototype_schema.sql to have been run. Only rows with is_test = true are ever touched.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { testLeads } from '../test/fixtures/testLeads.js';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const adoptAt = args.indexOf('--adopt');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const STAGE_PATH = ['initiated', 'interested', 'negotiating', 'site_visit_ready', 'closed'];

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    fail('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  }

  if (args.includes('--clean')) return clean();

  const properties = await loadProperties();

  if (adoptAt !== -1) return adopt(args[adoptAt + 1], args[adoptAt + 2], properties);

  const { rows, events, problems } = build(properties);
  summarise(rows, problems);
  if (problems.length) fail(`${problems.length} shortlist reference(s) did not match a property`);
  if (dry) return console.log('\nDry run only. Nothing written.');

  await assertTableExists();

  const ids = rows.map((r) => r.customer_id);
  await check(supabase.from('customer_leads').upsert(rows, { onConflict: 'customer_id' }), 'upsert leads');
  await check(supabase.from('lead_events').delete().in('customer_id', ids), 'clear old events');
  await check(supabase.from('lead_events').insert(events), 'insert events');
  console.log(`\nSeeded ${rows.length} leads and ${events.length} events.`);
}

async function loadProperties() {
  const { data, error } = await supabase
    .from(process.env.PROPERTIES_TABLE || 'properties')
    .select('property_id,title,location,status');
  if (error) fail(`Could not read properties: ${error.message}`);
  return data;
}

function build(properties) {
  const problems = [];
  const resolve = (hint, leadId) => {
    const match = properties.find((p) => p.location.toLowerCase().includes(hint.toLowerCase()));
    if (!match) problems.push(`${leadId}: no property with location containing "${hint}"`);
    return match?.property_id;
  };

  const rows = [];
  const events = [];
  const now = Date.now();
  const day = 86400000;

  for (const t of testLeads) {
    const p = t.profile;
    const shortlist = p.shortlist.map((hint) => resolve(hint, t.id)).filter(Boolean);
    const n = Number(t.id.split(':')[1]);
    const firstContact = now - (3 + (n % 12)) * day;

    rows.push({
      customer_id: t.id,
      display_name: t.name,
      lead_stage: t.stage,
      intent: p.intent ?? null,
      budget_min: p.budgetMin ?? null,
      budget_max: p.budgetMax ?? null,
      preferred_locations: p.locations,
      property_categories: p.categories,
      bedrooms: p.bedrooms ?? null,
      must_haves: p.mustHaves,
      deal_breakers: p.dealBreakers,
      urgency: p.urgency ?? null,
      financing_status: p.financing ?? null,
      key_points: [...p.keyPoints, { type: 'test_tags', text: t.tags.join(', '), confidence: 1 }],
      shortlisted_property_ids: shortlist,
      last_query_summary: p.lastQuery ?? null,
      next_action: p.nextAction ?? null,
      is_test: true,
      created_at: new Date(firstContact).toISOString(),
      last_contacted_at: new Date(now - (n % 5) * day).toISOString(),
      updated_at: new Date(now - (n % 5) * day).toISOString()
    });

    // A plausible history: one event per stage step, spread between first contact and now.
    const steps = t.stage === 'not_interested'
      ? ['initiated', 'interested', 'not_interested']
      : STAGE_PATH.slice(0, STAGE_PATH.indexOf(t.stage) + 1);
    const span = now - (n % 5) * day - firstContact;
    steps.slice(1).forEach((to, i) => {
      events.push({
        customer_id: t.id,
        event_type: 'stage_changed',
        from_stage: steps[i],
        to_stage: to,
        created_at: new Date(firstContact + (span * (i + 1)) / steps.length).toISOString()
      });
    });
    if (t.stage === 'site_visit_ready') {
      events.push({
        customer_id: t.id,
        event_type: 'site_visit_requested',
        to_stage: 'site_visit_ready',
        property_id: shortlist[0] ?? null,
        created_at: new Date(now - (n % 5) * day).toISOString()
      });
    }
  }
  return { rows, events, problems };
}

function summarise(rows, problems) {
  const count = (key) => rows.reduce((acc, r) => ({ ...acc, [r[key]]: (acc[r[key]] ?? 0) + 1 }), {});
  console.log(`Fixture: ${rows.length} leads`);
  console.log('By stage:', JSON.stringify(count('lead_stage')));
  const tags = {};
  for (const t of testLeads) for (const tag of t.tags) tags[tag] = (tags[tag] ?? 0) + 1;
  console.log('By tag:  ', JSON.stringify(tags));
  console.log('With shortlist:', rows.filter((r) => r.shortlisted_property_ids.length).length);
  for (const p of problems) console.log('PROBLEM', p);
}

async function adopt(personaId, telegramId, properties) {
  if (!personaId || !telegramId) fail('Usage: --adopt <persona e.g. 016> <your telegram user id>');
  const persona = testLeads.find((t) => t.id === `test:${personaId}`);
  if (!persona) fail(`No test lead test:${personaId}`);
  const { rows } = build(properties);
  const row = { ...rows.find((r) => r.customer_id === persona.id), customer_id: `telegram:${telegramId}` };
  await assertTableExists();
  // Start the conversation clean: no old messages, history or bot memory from before.
  await check(supabase.from('chat_messages').delete().eq('customer_id', row.customer_id), 'clear messages');
  await check(supabase.from('lead_events').delete().eq('customer_id', row.customer_id), 'clear events');
  // Keep the real person's name and handle; only the requirements and stage come from the persona.
  const { data: existing } = await supabase.from('customer_leads').select('display_name,handle').eq('customer_id', row.customer_id).maybeSingle();
  const keep = existing ? { display_name: existing.display_name ?? row.display_name, handle: existing.handle } : {};
  await check(supabase.from('customer_leads').upsert({ ...row, ...keep, bot_state: {}, phone: null }, { onConflict: 'customer_id' }), 'adopt');
  console.log(`telegram:${telegramId} now has the profile of ${persona.name} (${persona.id}), stage ${persona.stage}.`);
  console.log(`Message to type: ${JSON.stringify(persona.messages)}`);
  console.log(`Expected: ${persona.expect}`);
}

async function clean() {
  await assertTableExists();
  const { data, error } = await supabase
    .from('customer_leads')
    .delete()
    .eq('is_test', true)
    .like('customer_id', 'test:%')
    .select('customer_id');
  if (error) fail(error.message);
  console.log(`Deleted ${data.length} test leads (events and messages go with them).`);
}

async function assertTableExists() {
  const { error } = await supabase.from('customer_leads').select('customer_id').limit(1);
  if (error) fail(`customer_leads is not usable (${error.message}). Run sql/001_prototype_schema.sql in the Supabase SQL editor first.`);
}

async function check(query, label) {
  const { error } = await query;
  if (error) fail(`${label} failed: ${error.message}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

main();
