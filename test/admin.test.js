import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createLoginLimiter } from '../src/admin/auth.js';
import { getDemand } from '../src/admin/board.js';
import { config } from '../src/config.js';
import { Cr, L, properties } from './fixtures/properties.js';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

// ---- stand-in for Supabase Auth -------------------------------------------------------------

const USERS = {
  'admin@x.com': { id: 'u-admin', password: 'pw-admin' },
  'viewer@x.com': { id: 'u-viewer', password: 'pw-viewer' },
  'outsider@x.com': { id: 'u-out', password: 'pw-out' }
};

const fakeAuth = {
  sessionFor(email) {
    const { id } = USERS[email];
    return { accessToken: `access-${id}`, refreshToken: `refresh-${id}`, expiresIn: 3600, user: { id, email } };
  },
  async signIn(email, password) {
    return USERS[email]?.password === password ? this.sessionFor(email) : null;
  },
  async verify(token) {
    const entry = Object.entries(USERS).find(([, u]) => token === `access-${u.id}`);
    return entry ? { id: entry[1].id, email: entry[0] } : null;
  },
  async refresh(token) {
    const entry = Object.entries(USERS).find(([, u]) => token === `refresh-${u.id}`);
    return entry ? { ...this.sessionFor(entry[0]), accessToken: `access-${entry[1].id}` } : null;
  }
};

const lead = (id, name, stage, extra = {}) => ({
  customer_id: id,
  display_name: name,
  lead_stage: stage,
  is_test: false,
  preferred_locations: [],
  property_categories: [],
  shortlisted_property_ids: [],
  key_points: [],
  must_haves: [],
  deal_breakers: [],
  updated_at: '2026-10-01T10:00:00Z',
  last_contacted_at: '2026-10-01T10:00:00Z',
  ...extra
});

function build({ showConversations = 'test', limiter } = {}) {
  const supabase = createFakeSupabase({
    properties,
    staff: [
      { user_id: 'u-admin', email: 'admin@x.com', role: 'admin' },
      { user_id: 'u-viewer', email: 'viewer@x.com', role: 'viewer' }
    ],
    customer_leads: [
      lead('telegram:1', 'Asha', 'interested', { handle: 'asha', budget_max: Cr(1.5), preferred_locations: ['OMR'], bedrooms: 3, property_categories: ['residential'], shortlisted_property_ids: ['p04'], phone: '+919800000000' }),
      lead('telegram:2', 'Ravi <script>alert(1)</script>', 'site_visit_ready'),
      lead('test:001', 'Arun', 'initiated', { is_test: true }),
      lead('test:002', 'Divya', 'negotiating', { is_test: true, budget_min: L(80), budget_max: Cr(1.2) })
    ],
    lead_events: [
      { customer_id: 'telegram:1', event_type: 'lead_created', to_stage: 'initiated', created_at: '2026-10-01T09:00:00Z', payload: {} },
      { customer_id: 'telegram:1', event_type: 'shortlisted', property_id: 'p04', created_at: '2026-10-01T09:05:00Z', payload: {} },
      { customer_id: 'telegram:1', event_type: 'zero_result', note: '3 bedroom residential in OMR up to ₹1.5 Cr', created_at: '2026-10-01T09:06:00Z', payload: { outcome: 'recommendations' } },
      { customer_id: 'test:001', event_type: 'zero_result', note: '3 bedroom residential in OMR up to ₹1.5 Cr', created_at: '2026-10-01T09:07:00Z', payload: { outcome: 'recommendations' } },
      { customer_id: 'test:002', event_type: 'zero_result', note: 'office in OMR up to ₹5 Cr', created_at: '2026-10-01T09:08:00Z', payload: { outcome: 'nothing_in_budget' } },
      { customer_id: 'telegram:2', event_type: 'site_visit_requested', property_id: 'p16', alerted_at: '2026-10-01T09:10:00Z', created_at: '2026-10-01T09:10:00Z', payload: {} }
    ],
    chat_messages: [
      { customer_id: 'telegram:1', role: 'user', content: '3BHK in OMR', created_at: '2026-10-01T09:01:00Z', meta: {} },
      { customer_id: 'telegram:1', role: 'assistant', content: 'Here is one close option.', created_at: '2026-10-01T09:02:00Z', meta: {} },
      { customer_id: 'test:002', role: 'user', content: 'office on OMR', created_at: '2026-10-01T09:03:00Z', meta: {} }
    ]
  });
  const app = createApp({
    supabase,
    enableToolRoutes: false,
    admin: { auth: fakeAuth, showConversations, limiter }
  });
  return { app, supabase };
}

const signIn = async (app, email = 'admin@x.com') => {
  const agent = request.agent(app);
  await agent.post('/admin/api/login').send({ email, password: USERS[email].password }).expect(200);
  return agent;
};

// ---- access ---------------------------------------------------------------------------------

test('the page and its scripts are public, the data is not', async () => {
  const { app } = build();
  await request(app).get('/admin').expect(301).expect('Location', '/admin/');
  const page = await request(app).get('/admin/').expect(200);
  assert.match(page.text, /Lead board/);
  await request(app).get('/admin/board.js').expect(200);
  await request(app).get('/admin/board.css').expect(200);

  for (const path of ['/admin/api/board', '/admin/api/demand', '/admin/api/leads/telegram:1', '/admin/api/me']) {
    await request(app).get(path).expect(401);
  }
  await request(app).post('/admin/api/leads/telegram:1/stage').set('Content-Type', 'application/json').send({ stage: 'closed' }).expect(401);
});

test('a wrong password is refused and sets no cookie', async () => {
  const { app } = build();
  const response = await request(app).post('/admin/api/login').send({ email: 'admin@x.com', password: 'nope' }).expect(401);
  assert.equal(response.headers['set-cookie'], undefined);
});

test('a valid account that is not on the staff list is refused', async () => {
  const { app } = build();
  const response = await request(app).post('/admin/api/login').send({ email: 'outsider@x.com', password: 'pw-out' }).expect(403);
  assert.equal(response.body.error, 'not_staff');
  assert.equal(response.headers['set-cookie'], undefined);
});

test('signing in sets HttpOnly, SameSite=Strict cookies the page cannot read', async () => {
  const { app } = build();
  const response = await request(app).post('/admin/api/login').send({ email: 'admin@x.com', password: 'pw-admin' }).expect(200);
  assert.deepEqual(response.body, { email: 'admin@x.com', role: 'admin' });

  const cookies = response.headers['set-cookie'];
  assert.equal(cookies.length, 2);
  for (const c of cookies) {
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Strict/);
    assert.match(c, /Path=\/admin/);
  }
  assert.ok(!('token' in response.body) && !JSON.stringify(response.body).includes('access-'));
});

test('login needs JSON so a cross-site form cannot post it', async () => {
  const { app } = build();
  await request(app).post('/admin/api/login').type('form').send('email=admin@x.com&password=pw-admin').expect(415);
});

test('an expired session is renewed from the refresh cookie', async () => {
  const { app } = build();
  const response = await request(app).get('/admin/api/me').set('Cookie', 're_refresh=refresh-u-admin').expect(200);
  assert.equal(response.body.email, 'admin@x.com');
  assert.ok(response.headers['set-cookie'].some((c) => c.startsWith('re_access=')));
  await request(app).get('/admin/api/me').set('Cookie', 're_access=garbage').expect(401);
});

test('signing out clears the cookies', async () => {
  const { app } = build();
  const agent = await signIn(app);
  const out = await agent.post('/admin/api/logout').expect(200);
  assert.ok(out.headers['set-cookie'].every((c) => /Max-Age=0/.test(c)));
});

test('repeated wrong passwords are throttled', async () => {
  const { app } = build({ limiter: createLoginLimiter({ limit: 3 }) });
  for (let i = 0; i < 3; i++) {
    await request(app).post('/admin/api/login').send({ email: 'admin@x.com', password: 'bad' }).expect(401);
  }
  await request(app).post('/admin/api/login').send({ email: 'admin@x.com', password: 'pw-admin' }).expect(429);
});

// ---- the board ------------------------------------------------------------------------------

test('the board groups leads by stage in pipeline order, with counts', async () => {
  const { app } = build();
  const agent = await signIn(app);
  const { body } = await agent.get('/admin/api/board').expect(200);

  assert.deepEqual(body.columns.map((c) => c.stage), ['initiated', 'interested', 'negotiating', 'site_visit_ready', 'closed', 'not_interested']);
  assert.deepEqual(body.columns.map((c) => c.count), [1, 1, 1, 1, 0, 0]);
  assert.equal(body.total, 4);

  const asha = body.columns[1].leads[0];
  assert.equal(asha.summary, '3 BHK · residential · in OMR · up to ₹1.5 Cr');
  assert.equal(asha.shortlistCount, 1);
  assert.equal(asha.hasPhone, true);
  assert.equal(JSON.stringify(body).includes('+919800000000'), false, 'phone numbers are not on the cards');
  assert.equal(body.columns[2].leads[0].summary, '₹80 L to ₹1.2 Cr');
});

test('test leads can be hidden', async () => {
  const { app } = build();
  const agent = await signIn(app, 'viewer@x.com');
  const { body } = await agent.get('/admin/api/board?tests=0').expect(200);
  assert.equal(body.total, 2);
  assert.ok(body.columns.flatMap((c) => c.leads).every((l) => !l.isTest));
});

test('unmet demand is grouped by what was asked, most asked first', async () => {
  const { app, supabase } = build();
  const agent = await signIn(app);
  const all = (await agent.get('/admin/api/demand').expect(200)).body.items;
  assert.equal(all[0].request, '3 bedroom residential in OMR up to ₹1.5 Cr');
  assert.equal(all[0].count, 2);
  assert.equal(all[0].customers, 2);
  assert.equal(all[1].request, 'office in OMR up to ₹5 Cr');

  const real = (await agent.get('/admin/api/demand?tests=0').expect(200)).body.items;
  assert.equal(real.length, 1);
  assert.equal(real[0].count, 1);

  assert.deepEqual((await getDemand(createFakeSupabase())).items, []);
  assert.ok(supabase);
});

// ---- one lead -------------------------------------------------------------------------------

test('a lead in full: shortlist titles, history with property names', async () => {
  const { app } = build();
  const agent = await signIn(app);
  const { body } = await agent.get('/admin/api/leads/telegram:1').expect(200);

  assert.equal(body.name, 'Asha');
  assert.equal(body.phone, '+919800000000');
  assert.equal(body.shortlist[0].title, 'High-Rise 2BHK Apartment near Tech Parks');
  assert.equal(body.shortlist[0].price, '₹62 L');
  const saved = body.events.find((e) => e.type === 'shortlisted');
  assert.equal(saved.property.title, 'High-Rise 2BHK Apartment near Tech Parks');

  const visit = (await agent.get('/admin/api/leads/telegram:2').expect(200)).body.events.find((e) => e.type === 'site_visit_requested');
  assert.equal(visit.alerted, true);
  assert.equal(visit.property.title, 'Compact 1BHK Starter Flat');

  await agent.get('/admin/api/leads/telegram:nobody').expect(404);
});

test('conversation policy: test leads only, everyone, or nobody', async () => {
  const cases = [
    ['test', { 'telegram:1': false, 'test:002': true }],
    ['all', { 'telegram:1': true, 'test:002': true }],
    ['none', { 'telegram:1': false, 'test:002': false }]
  ];
  for (const [policy, expected] of cases) {
    const { app } = build({ showConversations: policy });
    const agent = await signIn(app);
    for (const [id, visible] of Object.entries(expected)) {
      const { body } = await agent.get(`/admin/api/leads/${id}`).expect(200);
      assert.equal(body.conversationVisible, visible, `${policy} ${id}`);
      assert.equal(body.conversation !== null, visible, `${policy} ${id} messages`);
    }
  }
  const { app } = build({ showConversations: 'all' });
  const { body } = await (await signIn(app)).get('/admin/api/leads/telegram:1');
  assert.deepEqual(body.conversation.map((m) => m.role), ['user', 'assistant']);
});

// ---- moving a lead --------------------------------------------------------------------------

test('an admin can move a lead, and the move is recorded with who did it', async () => {
  const { app, supabase } = build();
  const agent = await signIn(app);
  const response = await agent.post('/admin/api/leads/telegram:1/stage').send({ stage: 'closed', reason: 'deal signed' }).expect(200);
  assert.deepEqual(response.body, { changed: true, from: 'interested', to: 'closed' });

  assert.equal(supabase.tables.customer_leads.find((l) => l.customer_id === 'telegram:1').lead_stage, 'closed');
  const event = supabase.tables.lead_events.at(-1);
  assert.equal(event.event_type, 'stage_changed');
  assert.equal(event.note, 'deal signed');
  assert.deepEqual(event.payload, { actor: 'board', by: 'admin@x.com' });
});

test('the board may correct a stage backwards; the model never could', async () => {
  const { app, supabase } = build();
  const agent = await signIn(app);
  await agent.post('/admin/api/leads/telegram:2/stage').send({ stage: 'interested' }).expect(200);
  assert.equal(supabase.tables.customer_leads.find((l) => l.customer_id === 'telegram:2').lead_stage, 'interested');
});

test('a viewer cannot move a lead', async () => {
  const { app, supabase } = build();
  const agent = await signIn(app, 'viewer@x.com');
  const response = await agent.post('/admin/api/leads/telegram:1/stage').send({ stage: 'closed' }).expect(403);
  assert.equal(response.body.error, 'admin_only');
  assert.equal(supabase.tables.customer_leads.find((l) => l.customer_id === 'telegram:1').lead_stage, 'interested');
});

test('bad stage changes are refused', async () => {
  const { app } = build();
  const agent = await signIn(app);
  await agent.post('/admin/api/leads/telegram:1/stage').send({ stage: 'won' }).expect(400);
  const same = await agent.post('/admin/api/leads/telegram:1/stage').send({ stage: 'interested' }).expect(409);
  assert.equal(same.body.changed, false);
  await agent.post('/admin/api/leads/telegram:1/stage').type('form').send('stage=closed').expect(415);
  await agent.post('/admin/api/leads/telegram:nobody/stage').send({ stage: 'closed' }).expect(404);
});

// ---- the page script ------------------------------------------------------------------------

test('the page never puts customer text into HTML', () => {
  const script = readFileSync(new URL('../src/admin/public/board.js', import.meta.url), 'utf8');
  for (const risky of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(']) {
    assert.ok(!script.includes(risky), `board.js must not use ${risky}`);
  }
});

// ---- listing photos -------------------------------------------------------------------------

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50, 2)]);

const upload = (agent, id, body, type = 'image/jpeg') =>
  agent.post(`/admin/api/properties/${id}/photos`).set('Content-Type', type).send(body);

test('the listings list shows every property with its photo count and cover', async () => {
  const { app } = build();
  await request(app).get('/admin/api/properties').expect(401);

  const agent = await signIn(app, 'viewer@x.com');
  const first = (await agent.get('/admin/api/properties').expect(200)).body.properties;
  assert.equal(first.length, 20);
  assert.ok(first.every((p) => p.photoCount === 0 && p.cover === null));
  assert.deepEqual(first.map((p) => p.title), [...first.map((p) => p.title)].sort((a, b) => a.localeCompare(b)));
  assert.equal(first.find((p) => p.id === 'p05').price, 'Price on Request (POR)');

  const admin = await signIn(app);
  await upload(admin, 'p04', JPEG).expect(201);
  const after = (await agent.get('/admin/api/properties').expect(200)).body.properties.find((p) => p.id === 'p04');
  assert.equal(after.photoCount, 1);
  assert.match(after.cover, /\/storage\/v1\/object\/public\/property-photos\/p04\/.+\.jpg$/);
});

test('an admin uploads photos one at a time; they come back in order', async () => {
  const { app, supabase } = build();
  const agent = await signIn(app);

  const a = (await upload(agent, 'p04', JPEG).expect(201)).body.photo;
  const b = (await upload(agent, 'p04', PNG, 'image/png').expect(201)).body.photo;
  assert.deepEqual([a.position, b.position], [0, 1]);
  assert.equal(supabase.files.size, 2);
  assert.equal(supabase.tables.property_photos[0].uploaded_by, 'admin@x.com');

  const listed = (await agent.get('/admin/api/properties/p04/photos').expect(200)).body;
  assert.equal(listed.property.title, 'High-Rise 2BHK Apartment near Tech Parks');
  assert.deepEqual(listed.photos.map((p) => p.id), [a.id, b.id]);
  assert.equal(listed.max, 10);
});

test('viewers and signed-out visitors cannot change photos', async () => {
  const { app, supabase } = build();
  await request(app).post('/admin/api/properties/p04/photos').set('Content-Type', 'image/jpeg').send(JPEG).expect(401);

  const viewer = await signIn(app, 'viewer@x.com');
  await upload(viewer, 'p04', JPEG).expect(403);
  await viewer.delete('/admin/api/properties/p04/photos/1').expect(403);
  await viewer.post('/admin/api/properties/p04/photos/order').send({ ids: [] }).expect(403);
  assert.equal(supabase.files.size, 0);
  await viewer.get('/admin/api/properties/p04/photos').expect(200);
});

test('uploads that are not real images, are too big, or are for a missing listing are refused', async () => {
  const { app, supabase } = build();
  const agent = await signIn(app);

  // A script dressed up as an image is caught by its bytes, not its label.
  await upload(agent, 'p04', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')).expect(415);
  await upload(agent, 'p04', Buffer.from('plain text pretending to be a photo')).expect(415);
  // The wrong kind of request body.
  await agent.post('/admin/api/properties/p04/photos').send({ not: 'an image' }).expect(415);
  await upload(agent, 'p04', Buffer.alloc(0)).expect(415);
  // Too big.
  await upload(agent, 'p04', Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)])).expect(413);
  // No such listing.
  await upload(agent, 'nope', JPEG).expect(404);
  await agent.get('/admin/api/properties/nope/photos').expect(404);

  assert.equal(supabase.files.size, 0);
});

test('a listing stops at ten photos', async () => {
  const { app } = build();
  const agent = await signIn(app);
  for (let i = 0; i < 10; i++) await upload(agent, 'p04', JPEG).expect(201);
  const response = await upload(agent, 'p04', JPEG).expect(409);
  assert.match(response.body.message, /at most 10 photos/);
});

test('photos can be deleted and reordered, and the order sticks', async () => {
  const { app, supabase } = build();
  const agent = await signIn(app);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await upload(agent, 'p04', JPEG).expect(201)).body.photo.id);

  await agent.post('/admin/api/properties/p04/photos/order').send({ ids: [ids[2], ids[0], ids[1]] }).expect(200);
  assert.deepEqual((await agent.get('/admin/api/properties/p04/photos')).body.photos.map((p) => p.id), [ids[2], ids[0], ids[1]]);

  await agent.post('/admin/api/properties/p04/photos/order').send({ ids: [ids[0]] }).expect(400);
  await agent.post('/admin/api/properties/p04/photos/order').send({ ids: 'x' }).expect(400);
  await agent.post('/admin/api/properties/p04/photos/order').type('form').send('ids=1').expect(415);

  await agent.delete(`/admin/api/properties/p04/photos/${ids[0]}`).expect(200);
  assert.equal(supabase.files.size, 2);
  const left = (await agent.get('/admin/api/properties/p04/photos')).body.photos;
  assert.deepEqual(left.map((p) => [p.id, p.position]), [[ids[2], 0], [ids[1], 1]]);

  await agent.delete(`/admin/api/properties/p04/photos/${ids[0]}`).expect(404);
  await agent.delete('/admin/api/properties/p16/photos/' + ids[1]).expect(404);
});

test('the board page may load images from Supabase Storage and nowhere else', async () => {
  const { app } = build();
  const csp = (await request(app).get('/admin/')).headers['content-security-policy'];
  const imgSrc = csp.split(';').find((d) => d.trim().startsWith('img-src'));
  assert.match(imgSrc, /'self'/);
  assert.match(imgSrc, /blob:/);
  if (config.supabaseUrl) assert.ok(imgSrc.includes(new URL(config.supabaseUrl).origin));
  assert.doesNotMatch(imgSrc, /\*/);
});

// ---- knowledge gaps and approved answers ------------------------------------------------------

function withGaps() {
  const { app, supabase } = build();
  const gap = (id, fields) => ({
    id, status: 'open', times: 1, is_test: false, entry_id: null, request: { question: fields.question }, topic: null, property_id: null, area: null,
    first_asked_at: '2026-10-01T09:00:00Z', last_asked_at: '2026-10-01T09:00:00Z', ...fields
  });
  supabase.tables.knowledge_gaps = [
    gap(1, { customer_id: 'telegram:1', question: 'Does it have parking?', kind: 'listing_detail', topic: 'parking', property_id: 'p04', group_key: 'listing_detail|parking|p04|', request: { question: 'Does it have parking?', property: { id: 'p04', title: 'High-Rise 2BHK Apartment near Tech Parks' }, assistantReply: 'The listing does not mention parking.' } }),
    gap(2, { customer_id: 'telegram:2', question: 'is there parking', kind: 'listing_detail', topic: 'parking', property_id: 'p04', group_key: 'listing_detail|parking|p04|', times: 2 }),
    gap(3, { customer_id: 'test:001', question: 'Any good school nearby?', kind: 'area_info', topic: 'nearby_places', area: 'Navalur', group_key: 'area_info|nearby_places||Navalur', is_test: true }),
    gap(4, { customer_id: 'telegram:1', question: 'Can I get a loan?', kind: 'policy', topic: 'loan', group_key: 'policy|loan||' })
  ];
  supabase.tables.knowledge_entries = [];
  return { app, supabase };
}

test('open gaps are grouped by what was asked, with the request JSON, most asked first', async () => {
  const { app } = withGaps();
  await request(app).get('/admin/api/knowledge/gaps').expect(401);

  const agent = await signIn(app, 'viewer@x.com');
  const { gaps } = (await agent.get('/admin/api/knowledge/gaps').expect(200)).body;
  assert.equal(gaps.length, 3);
  assert.equal(gaps[0].topic, 'parking');
  assert.equal(gaps[0].times, 3);
  assert.equal(gaps[0].customers, 2);
  assert.equal(gaps[0].propertyTitle, 'High-Rise 2BHK Apartment near Tech Parks');
  assert.equal(gaps[0].topicLabel, 'parking');
  assert.ok(gaps[0].requests.some((r) => r.request.assistantReply === 'The listing does not mention parking.'), 'each ask keeps its own request JSON');

  const real = (await agent.get('/admin/api/knowledge/gaps?tests=0')).body.gaps;
  assert.deepEqual(real.map((g) => g.topic).sort(), ['loan', 'parking']);
});

test('an admin answers a gap: it becomes an approved answer and the gap closes for everyone who asked', async () => {
  const { app, supabase } = withGaps();
  const agent = await signIn(app);
  const created = await agent.post('/admin/api/knowledge/gaps/1/answer').send({ answer: '  Two covered car parks are included.  ' }).expect(201);
  assert.equal(created.body.entry.scope, 'property');
  assert.equal(created.body.entry.property_id, 'p04');
  assert.equal(created.body.entry.answer, 'Two covered car parks are included.');
  assert.equal(created.body.entry.created_by, 'admin@x.com');

  assert.deepEqual(supabase.tables.knowledge_gaps.filter((g) => g.status === 'answered').map((g) => g.id), [1, 2]);
  assert.deepEqual((await agent.get('/admin/api/knowledge/gaps')).body.gaps.map((g) => g.topic).sort(), ['loan', 'nearby_places']);

  const entries = (await agent.get('/admin/api/knowledge/entries').expect(200)).body.entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].propertyTitle, 'High-Rise 2BHK Apartment near Tech Parks');
  assert.equal(entries[0].servedCount, 0);
});

test('viewers cannot answer, and bad answers are refused', async () => {
  const { app, supabase } = withGaps();
  const viewer = await signIn(app, 'viewer@x.com');
  await viewer.post('/admin/api/knowledge/gaps/1/answer').send({ answer: 'Yes.' }).expect(403);
  await viewer.post('/admin/api/knowledge/gaps/1/dismiss').expect(403);

  const admin = await signIn(app);
  await admin.post('/admin/api/knowledge/gaps/1/answer').send({ answer: '' }).expect(400);
  await admin.post('/admin/api/knowledge/gaps/1/answer').send({ answer: 'x'.repeat(1001) }).expect(400);
  await admin.post('/admin/api/knowledge/gaps/1/answer').send({}).expect(400);
  await admin.post('/admin/api/knowledge/gaps/1/answer').type('form').send('answer=hello').expect(415);
  await admin.post('/admin/api/knowledge/gaps/99/answer').send({ answer: 'Fine answer.' }).expect(404);
  assert.equal(supabase.tables.knowledge_entries.length, 0);
});

test('a gap can be dismissed, and approved answers can be edited, switched off and deleted', async () => {
  const { app } = withGaps();
  const agent = await signIn(app);
  await agent.post('/admin/api/knowledge/gaps/4/dismiss').expect(200);
  assert.equal((await agent.get('/admin/api/knowledge/gaps')).body.gaps.some((g) => g.topic === 'loan'), false);
  assert.equal((await agent.get('/admin/api/knowledge/gaps?status=dismissed')).body.gaps.length, 1);
  await agent.post('/admin/api/knowledge/gaps/99/dismiss').expect(404);

  const entry = (await agent.post('/admin/api/knowledge/gaps/3/answer').send({ answer: 'Two CBSE schools nearby.' }).expect(201)).body.entry;
  assert.equal(entry.scope, 'area');
  assert.equal(entry.area, 'Navalur');

  const edited = await agent.patch(`/admin/api/knowledge/entries/${entry.id}`).send({ answer: 'Three CBSE schools nearby.' }).expect(200);
  assert.equal(edited.body.entry.answer, 'Three CBSE schools nearby.');
  const off = await agent.patch(`/admin/api/knowledge/entries/${entry.id}`).send({ active: false }).expect(200);
  assert.equal(off.body.entry.active, false);

  await agent.patch(`/admin/api/knowledge/entries/${entry.id}`).send({ answer: '' }).expect(400);
  await agent.patch(`/admin/api/knowledge/entries/${entry.id}`).send({ active: 'yes' }).expect(400);
  await agent.patch('/admin/api/knowledge/entries/999').send({ active: true }).expect(404);

  await agent.delete(`/admin/api/knowledge/entries/${entry.id}`).expect(200);
  await agent.delete(`/admin/api/knowledge/entries/${entry.id}`).expect(404);
  assert.equal((await agent.get('/admin/api/knowledge/entries')).body.entries.length, 0);
});

// ---- what staff may see, and the access log ---------------------------------------------------

test('viewers never see phone numbers or conversations; admins do, and the access is logged', async () => {
  const { app, supabase } = build({ showConversations: 'all' });
  const viewer = await signIn(app, 'viewer@x.com');
  const seen = (await viewer.get('/admin/api/leads/telegram:1').expect(200)).body;
  assert.equal(seen.phone, null);
  assert.equal(seen.phoneHidden, true);
  assert.equal(seen.conversationVisible, false);
  assert.equal(seen.conversation, null);
  assert.equal(JSON.stringify(seen).includes('+919800000000'), false);
  assert.equal((supabase.tables.audit_log ?? []).length, 0, 'seeing nothing private leaves no entry');

  const admin = await signIn(app);
  const full = (await admin.get('/admin/api/leads/telegram:1').expect(200)).body;
  assert.equal(full.phone, '+919800000000');
  assert.equal(full.conversationVisible, true);
  assert.equal(full.conversation.length, 2);

  const [entry] = supabase.tables.audit_log;
  assert.equal(entry.staff_email, 'admin@x.com');
  assert.equal(entry.customer_id, 'telegram:1');
  assert.deepEqual(entry.detail, { phone: true, conversation: true });
});

test('opening the same lead again, as the page does every few seconds, is one log entry', async () => {
  const { app, supabase } = build({ showConversations: 'all' });
  const admin = await signIn(app);
  for (let i = 0; i < 5; i++) await admin.get('/admin/api/leads/telegram:1').expect(200);
  await admin.get('/admin/api/leads/test:002').expect(200);
  assert.deepEqual(supabase.tables.audit_log.map((e) => e.customer_id).sort(), ['telegram:1', 'test:002']);
});

test('the access log is for admins only, newest first', async () => {
  const { app } = build({ showConversations: 'all' });
  await request(app).get('/admin/api/audit').expect(401);
  const viewer = await signIn(app, 'viewer@x.com');
  await viewer.get('/admin/api/audit').expect(403);

  const admin = await signIn(app);
  await admin.get('/admin/api/leads/telegram:1');
  await admin.get('/admin/api/leads/test:002');
  const { entries } = (await admin.get('/admin/api/audit').expect(200)).body;
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { id: entries[0].id, staff: 'admin@x.com', action: 'view_lead', customerId: entries[0].customerId, sawPhone: entries[0].sawPhone, sawConversation: true, at: entries[0].at });
  assert.deepEqual(entries.map((e) => e.customerId).sort(), ['telegram:1', 'test:002']);
});

// ---- requests the bot passed to the team ----------------------------------------------------

function withRequests() {
  const { supabase } = build();
  supabase.tables.handoffs = [
    { id: 1, customer_id: 'telegram:1', kind: 'offer', status: 'open', summary: 'Offered ₹54 L for High-Rise 2BHK', property_id: 'p04', is_test: false, alert_chat_id: 999, alert_message_id: 500, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z' },
    { id: 2, customer_id: 'test:001', kind: 'question', status: 'open', summary: 'Is there a rooftop garden?', property_id: null, is_test: true, created_at: '2026-10-01T11:00:00Z', updated_at: '2026-10-01T11:00:00Z' },
    { id: 3, customer_id: 'telegram:2', kind: 'visit', status: 'resolved', summary: 'Asked to visit Compact 1BHK', property_id: 'p16', is_test: false, created_at: '2026-10-01T08:00:00Z', updated_at: '2026-10-01T08:30:00Z', resolved_at: '2026-10-01T08:30:00Z', resolved_by: 'admin@x.com' }
  ];
  supabase.tables.handoff_messages = [
    { id: 1, handoff_id: 1, direction: 'customer', via: 'bot', author: null, text: 'Offered ₹54 L for High-Rise 2BHK', created_at: '2026-10-01T10:00:00Z' },
    { id: 2, handoff_id: 1, direction: 'staff', via: 'telegram', author: 'telegram:999', text: 'Let me check with the owner.', created_at: '2026-10-01T10:05:00Z' }
  ];
  const sent = [];
  const bot = { handleUpdate: async () => {}, api: { sendMessage: async (chatId, text, options) => { sent.push({ chatId, text, options }); return { message_id: 600, chat: { id: chatId } }; } } };
  const app = createApp({ supabase, telegramBot: bot, telegramSecret: 's'.repeat(32), enableToolRoutes: false, admin: { auth: fakeAuth, showConversations: 'test' } });
  return { app, supabase, sent };
}

test('requests are for admins only', async () => {
  const { app } = withRequests();
  await request(app).get('/admin/api/handoffs').expect(401);
  const viewer = await signIn(app, 'viewer@x.com');
  await viewer.get('/admin/api/handoffs').expect(403);
  await viewer.get('/admin/api/handoffs/1').expect(403);
  await viewer.post('/admin/api/handoffs/1/reply').send({ text: 'hi' }).expect(403);
});

test('the list shows who asked what, filters by status, and can hide test leads', async () => {
  const { app } = withRequests();
  const agent = await signIn(app);

  const all = (await agent.get('/admin/api/handoffs').expect(200)).body;
  assert.equal(all.requests.length, 3);
  assert.equal(all.open, 2);
  assert.equal(all.requests[0].id, 2, 'newest first');
  assert.equal(all.requests.find((r) => r.id === 1).customerName, 'Asha');
  assert.equal(all.requests.find((r) => r.id === 1).propertyTitle, 'High-Rise 2BHK Apartment near Tech Parks');

  assert.deepEqual((await agent.get('/admin/api/handoffs?status=open').expect(200)).body.requests.map((r) => r.id).sort(), [1, 2]);
  assert.deepEqual((await agent.get('/admin/api/handoffs?status=resolved').expect(200)).body.requests.map((r) => r.id), [3]);
  assert.deepEqual((await agent.get('/admin/api/handoffs?status=open&tests=0').expect(200)).body.requests.map((r) => r.id), [1]);
});

test('opening a request shows the whole thread, and is logged like opening a conversation', async () => {
  const { app, supabase } = withRequests();
  const agent = await signIn(app);
  const { request: handoff, thread } = (await agent.get('/admin/api/handoffs/1').expect(200)).body;

  assert.equal(handoff.kind, 'offer');
  assert.deepEqual(thread.map((m) => [m.direction, m.via, m.text]), [
    ['customer', 'bot', 'Offered ₹54 L for High-Rise 2BHK'],
    ['staff', 'telegram', 'Let me check with the owner.']
  ]);
  assert.ok((supabase.tables.audit_log ?? []).some((e) => e.customer_id === 'telegram:1' && e.detail.conversation === true));
  await agent.get('/admin/api/handoffs/99').expect(404);
});

test('a reply written on the board reaches the customer and is shown to the team', async () => {
  const { app, supabase, sent } = withRequests();
  const agent = await signIn(app);

  const result = (await agent.post('/admin/api/handoffs/1/reply').send({ text: 'The owner can do ₹58 L. Please visit to discuss.' }).expect(200)).body;

  assert.equal(result.delivered, true);
  const toCustomer = sent.find((m) => m.chatId === 1);
  assert.match(toCustomer.text, /Message from our team/);
  assert.match(toCustomer.text, /The owner can do ₹58 L/);

  const saved = supabase.tables.handoff_messages.at(-1);
  assert.deepEqual([saved.direction, saved.via, saved.author], ['staff', 'board', 'admin@x.com']);
  assert.equal(supabase.tables.handoffs.find((h) => h.id === 1).status, 'waiting_customer');
});

test('a reply to a test lead is saved but not sent, and says so', async () => {
  const { app, sent } = withRequests();
  const agent = await signIn(app);
  const result = (await agent.post('/admin/api/handoffs/2/reply').send({ text: 'Yes there is.' }).expect(200)).body;
  assert.equal(result.delivered, false);
  assert.match(result.reason, /test lead/);
  assert.equal(sent.filter((m) => m.chatId !== config.salesDeskChatId).length, 0, 'nothing is sent to a customer chat');
});

test('an empty or oversized reply is refused', async () => {
  const { app } = withRequests();
  const agent = await signIn(app);
  await agent.post('/admin/api/handoffs/1/reply').send({ text: '   ' }).expect(400);
  await agent.post('/admin/api/handoffs/1/reply').send({ text: 'x'.repeat(1501) }).expect(400);
  await agent.post('/admin/api/handoffs/99/reply').send({ text: 'hi' }).expect(404);
});

test('a request can be resolved and reopened from the board', async () => {
  const { app, supabase } = withRequests();
  const agent = await signIn(app);

  await agent.post('/admin/api/handoffs/1/resolve').expect(200);
  let row = supabase.tables.handoffs.find((h) => h.id === 1);
  assert.equal(row.status, 'resolved');
  assert.equal(row.resolved_by, 'admin@x.com');

  await agent.post('/admin/api/handoffs/1/reopen').expect(200);
  row = supabase.tables.handoffs.find((h) => h.id === 1);
  assert.equal(row.status, 'open');
  assert.equal(row.resolved_by, null);
  await agent.post('/admin/api/handoffs/99/resolve').expect(404);
});

test('without Telegram connected, a board reply is refused rather than lost', async () => {
  const { supabase } = withRequests();
  const app = createApp({ supabase, enableToolRoutes: false, admin: { auth: fakeAuth, showConversations: 'test' } });
  const agent = await signIn(app);
  await agent.post('/admin/api/handoffs/1/reply').send({ text: 'hello' }).expect(503);
});

test('the list says since when each customer has waited, and which requests are overdue', async () => {
  const { app, supabase } = withRequests();
  // Request 1 has a team reply at 10:05 and no customer message after it: nobody is owed an answer. Request 2 has waited since 11:00.
  const agent = await signIn(app);
  const body = (await agent.get('/admin/api/handoffs').expect(200)).body;

  const byId = Object.fromEntries(body.requests.map((r) => [r.id, r]));
  assert.equal(byId[1].waitingSince, null, 'the team has replied');
  assert.equal(byId[1].overdue, false);
  assert.equal(byId[3].overdue, false, 'resolved');

  supabase.tables.handoff_messages.push({ id: 9, handoff_id: 2, direction: 'customer', via: 'bot', text: 'Is there a rooftop garden?', created_at: '2026-10-01T11:00:00Z' });
  const again = (await agent.get('/admin/api/handoffs').expect(200)).body;
  const two = again.requests.find((r) => r.id === 2);
  assert.equal(two.waitingSince, '2026-10-01T11:00:00Z');
  assert.equal(two.replyMinutes, 120, 'a question gets two hours');
  assert.equal(two.overdue, true);
  assert.equal(again.overdue, 1);
  assert.ok(Date.parse(again.serverTime) > Date.parse('2026-10-01'), 'the server time is sent so the page counts from it');

  supabase.tables.handoffs.find((h) => h.id === 2).kind = 'visit';
  assert.equal((await agent.get('/admin/api/handoffs').expect(200)).body.requests.find((r) => r.id === 2).replyMinutes, 30, 'a visit gets thirty minutes');
});

// ---- site visit times -----------------------------------------------------------------------

test('an admin sets, reads and clears the visit times of a listing; a viewer can read but not change', async () => {
  const { app, supabase } = build();
  const admin = await signIn(app);
  const viewer = await signIn(app, 'viewer@x.com');
  const path = '/admin/api/properties/p04/visits';

  assert.equal((await viewer.get(path).expect(200)).body.availability, null);
  assert.equal((await admin.get('/admin/api/properties').expect(200)).body.properties.find((p) => p.id === 'p04').visits, 'unset');

  await viewer.put(path).send({ mode: 'closed' }).expect(403);
  await admin.put(path).send({ mode: 'open', rules: [{ days: [6], from: '10:00', to: '13:00' }], note: 'Bring ID' }).expect(200);

  const read = (await viewer.get(path).expect(200)).body;
  assert.equal(read.availability.mode, 'open');
  assert.equal(read.availability.note, 'Bring ID');
  assert.ok(read.preview.length >= 1);
  assert.equal(supabase.tables.visit_availability[0].updated_by, 'admin@x.com');
  assert.equal((await admin.get('/admin/api/properties').expect(200)).body.properties.find((p) => p.id === 'p04').visits, 'open');

  await admin.put(path).send({ mode: 'closed' }).expect(200);
  assert.equal(supabase.tables.visit_availability.length, 1);
  assert.equal(supabase.tables.visit_availability[0].mode, 'closed');

  await admin.put(path).send({ mode: 'unset' }).expect(200);
  assert.equal(supabase.tables.visit_availability.length, 0);
});

test('bad visit times are refused, and an unknown listing is not found', async () => {
  const { app } = build();
  const admin = await signIn(app);
  const bad = await admin.put('/admin/api/properties/p04/visits').send({ mode: 'open', rules: [{ days: [6], from: '13:00', to: '10:00' }] }).expect(400);
  assert.match(bad.body.message, /start time before/);
  await admin.get('/admin/api/properties/nope/visits').expect(404);
  await admin.put('/admin/api/properties/nope/visits').send({ mode: 'closed' }).expect(404);
});
