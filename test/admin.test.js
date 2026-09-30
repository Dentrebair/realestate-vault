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
