import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config, isSupabaseConfigured } from './config.js';
import { buildOpenAiTools, buildOpenApiDocument } from './openapi.js';
import { leadMemorySchema, upsertLeadMemory } from './leadMemory.js';
import { propertySearchSchema, searchProperties } from './propertySearch.js';
import { createSupabaseClient } from './supabase.js';

export function createApp({ supabase = createSupabaseClient() } = {}) {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_request, response) => {
    response.json({
      ok: true,
      service: 'real-estate-meta-business-agent-connector',
      supabaseConfigured: isSupabaseConfigured
    });
  });

  app.get('/openapi.json', (request, response) => {
    response.json(buildOpenApiDocument(`${request.protocol}://${request.get('host')}`));
  });

  app.get('/openai-tools.json', (_request, response) => {
    response.json(buildOpenAiTools());
  });

  app.post('/tools/search-properties', requireBearerToken, async (request, response, next) => {
    const parsed = propertySearchSchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      return response.status(400).json({
        error: 'invalid_request',
        details: parsed.error.flatten()
      });
    }

    try {
      const result = await searchProperties(supabase, parsed.data);
      return response.json(result);
    } catch (error) {
      return next(error);
    }
  });

  app.post('/tools/upsert-lead-memory', requireBearerToken, async (request, response, next) => {
    const parsed = leadMemorySchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      return response.status(400).json({
        error: 'invalid_request',
        details: parsed.error.flatten()
      });
    }

    try {
      const result = await upsertLeadMemory(supabase, parsed.data);
      return response.json(result);
    } catch (error) {
      return next(error);
    }
  });

  app.use((error, _request, response, _next) => {
    const statusCode = error.statusCode ?? 500;
    response.status(statusCode).json({
      error: statusCode === 500 ? 'internal_error' : 'upstream_error',
      message: error.message
    });
  });

  return app;
}

function requireBearerToken(request, response, next) {
  if (!config.connectorBearerToken) {
    return next();
  }

  const expected = `Bearer ${config.connectorBearerToken}`;
  if (request.get('authorization') !== expected) {
    return response.status(401).json({ error: 'unauthorized' });
  }

  return next();
}
