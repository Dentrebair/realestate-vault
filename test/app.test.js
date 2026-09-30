import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';

test('health reports service status', async () => {
  const app = createApp({ supabase: null });

  const response = await request(app).get('/health').expect(200);

  assert.equal(response.body.ok, true);
  assert.equal(response.body.service, 'real-estate-meta-business-agent-connector');
});

test('openapi document exposes search tool operation', async () => {
  const app = createApp({ supabase: null });

  const response = await request(app).get('/openapi.json').expect(200);

  assert.equal(
    response.body.paths['/tools/search-properties'].post.operationId,
    'searchChennaiProperties'
  );
});

test('openai tools document exposes strict function schema', async () => {
  const app = createApp({ supabase: null });

  const response = await request(app).get('/openai-tools.json').expect(200);

  assert.equal(response.body.tools[0].type, 'function');
  assert.equal(response.body.tools[0].name, 'search_chennai_properties');
  assert.equal(response.body.tools[0].strict, true);
  assert.equal(response.body.tools[1].name, 'upsert_lead_memory');
  assert.equal(response.body.tools[1].strict, true);
});

test('search validates budget ranges', async () => {
  const app = createApp({ supabase: null });

  const response = await request(app)
    .post('/tools/search-properties')
    .send({ minBudget: 200, maxBudget: 100 })
    .expect(400);

  assert.equal(response.body.error, 'invalid_request');
});

test('search returns configuration guidance when Supabase env is absent', async () => {
  const app = createApp({ supabase: null });

  const response = await request(app)
    .post('/tools/search-properties')
    .send({ location: 'OMR', bedrooms: 3 })
    .expect(200);

  assert.equal(response.body.configured, false);
  assert.deepEqual(response.body.results, []);
});

test('lead memory validates lead status', async () => {
  const app = createApp({ supabase: null });

  const response = await request(app)
    .post('/tools/upsert-lead-memory')
    .send({ customerId: 'whatsapp:+919999999999', leadStatus: 'maybe_later' })
    .expect(400);

  assert.equal(response.body.error, 'invalid_request');
});

test('lead memory returns configuration guidance when Supabase env is absent', async () => {
  const app = createApp({ supabase: null });

  const response = await request(app)
    .post('/tools/upsert-lead-memory')
    .send({
      customerId: 'whatsapp:+919999999999',
      leadStatus: 'searching',
      preferredLocations: ['Anna Nagar'],
      keyPoints: [
        {
          type: 'requirement',
          text: 'Customer wants a 4BHK in Anna Nagar under 5 Cr.',
          confidence: 0.95
        }
      ]
    })
    .expect(200);

  assert.equal(response.body.configured, false);
});
