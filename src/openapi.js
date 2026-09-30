import { CATEGORIES } from './propertyTypes.js';
import { STAGES } from './stages.js';

export function buildOpenApiDocument(baseUrl) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Chennai Real Estate Connector',
      version: '0.2.0',
      description:
        'Property search and lead tracking tools for a chat agent answering Chennai real estate enquiries.'
    },
    servers: [{ url: baseUrl }],
    paths: {
      '/health': {
        get: {
          operationId: 'healthCheck',
          summary: 'Check connector health',
          responses: { 200: { description: 'Connector health status' } }
        }
      },
      '/tools/search-properties': {
        post: {
          operationId: 'searchChennaiProperties',
          summary: 'Find properties that match a requirement, or the closest options',
          description:
            'Returns exact matches when there are any. Otherwise returns up to three recommendations, each with how it differs from the requirement. Sold and reserved listings are never returned as results.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SearchPropertiesRequest' } }
            }
          },
          responses: {
            200: {
              description: 'Matches, recommendations and guidance',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/SearchPropertiesResponse' } }
              }
            },
            400: { description: 'Invalid search request' },
            401: { description: 'Missing or invalid bearer token' },
            502: { description: 'Supabase query failed' }
          }
        }
      },
      '/tools/upsert-lead-memory': {
        post: {
          operationId: 'upsertLeadMemory',
          summary: 'Save what a lead has told us',
          description:
            'Updates only the fields that are sent. The stage never resets, and stage changes follow the pipeline rules. Do not store the full chat transcript.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/UpsertLeadMemoryRequest' } }
            }
          },
          responses: {
            200: {
              description: 'Saved lead',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/UpsertLeadMemoryResponse' } }
              }
            },
            400: { description: 'Invalid lead memory request' },
            401: { description: 'Missing or invalid bearer token' },
            502: { description: 'Supabase write failed' }
          }
        }
      }
    },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      schemas: {
        SearchPropertiesRequest: {
          type: 'object',
          additionalProperties: false,
          properties: searchProperties()
        },
        SearchPropertiesResponse: {
          type: 'object',
          properties: {
            configured: { type: 'boolean' },
            outcome: {
              type: 'string',
              enum: ['matches', 'recommendations', 'nothing_in_area', 'nothing_in_budget', 'nothing_fits'],
              description: 'What the search found.'
            },
            guidance: { type: 'string', description: 'What to tell the lead about this outcome.' },
            criteria: { type: 'object', additionalProperties: true },
            count: { type: 'integer' },
            totalMatches: { type: 'integer' },
            nextOffset: { type: ['integer', 'null'] },
            message: { type: 'string' },
            results: { type: 'array', items: { $ref: '#/components/schemas/PropertyResult' } },
            recommendations: { type: 'array', items: { $ref: '#/components/schemas/PropertyResult' } },
            unavailable: { type: 'array', items: { type: 'object', additionalProperties: true } },
            droppedOverBudget: { type: 'array', items: { type: 'object', additionalProperties: true } },
            excludedByDealBreaker: { type: 'array', items: { type: 'object', additionalProperties: true } },
            nearestElsewhere: { type: ['object', 'null'], additionalProperties: true }
          }
        },
        PropertyResult: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: ['string', 'null'] },
            category: { type: ['string', 'null'] },
            location: { type: ['string', 'null'] },
            status: { type: 'string' },
            statusLabel: { type: 'string' },
            price: { type: ['number', 'null'] },
            priceDisplay: {
              type: 'string',
              description: 'Show exactly this. A missing price reads "Price on Request (POR)"; never estimate one.'
            },
            priceKnown: { type: 'boolean' },
            bedrooms: { type: ['integer', 'null'] },
            bathrooms: { type: ['integer', 'null'] },
            rera: { type: ['string', 'null'] },
            highlights: {
              type: 'array',
              items: {
                type: 'object',
                properties: { label: { type: 'string' }, value: { type: 'string' } }
              }
            },
            kind: { type: 'string', enum: ['match', 'recommendation'] },
            differences: { type: 'array', items: { type: 'string' } },
            distanceKm: { type: ['integer', 'null'] }
          }
        },
        UpsertLeadMemoryRequest: {
          type: 'object',
          required: ['customerId'],
          additionalProperties: false,
          properties: leadMemoryProperties()
        },
        UpsertLeadMemoryResponse: {
          type: 'object',
          properties: {
            configured: { type: 'boolean' },
            message: { type: 'string' },
            lead: { type: 'object', additionalProperties: true },
            stage: { type: ['object', 'null'], additionalProperties: true }
          }
        }
      }
    }
  };
}

// OpenAI "strict" function tools need every property listed as required and nullable.
export function buildOpenAiTools() {
  return {
    tools: [
      {
        type: 'function',
        name: 'search_chennai_properties',
        description:
          'Find Chennai properties that match what the customer wants, or the closest options with how they differ. Pass budgets in rupees.',
        strict: true,
        parameters: strictObject(searchProperties())
      },
      {
        type: 'function',
        name: 'upsert_lead_memory',
        description:
          'Save what the customer has told us (requirements, constraints, stage) without storing the chat transcript. Send only fields that changed; use null for the rest.',
        strict: true,
        parameters: strictObject(leadMemoryProperties())
      }
    ]
  };
}

function strictObject(properties) {
  const strict = Object.fromEntries(
    Object.entries(properties).map(([key, definition]) => [key, nullable(definition, key)])
  );
  return {
    type: 'object',
    additionalProperties: false,
    properties: strict,
    required: Object.keys(strict)
  };
}

// customerId stays a plain required string; everything else may be null.
function nullable(definition, key) {
  if (key === 'customerId') return definition;
  const { default: _unused, ...rest } = definition;
  const copy = { ...rest, type: [].concat(definition.type, 'null') };
  if (definition.enum) copy.enum = [...definition.enum, null];
  return copy;
}

function searchProperties() {
  return {
    location: {
      type: 'string',
      description:
        'Chennai area, corridor or landmark exactly as the customer said it, for example OMR, ECR, Anna Nagar, Tambaram, Tidel Park.'
    },
    query: {
      type: 'string',
      description:
        'The kind of property and any features, for example flat, villa, penthouse, office, cloud kitchen, warehouse, sea facing.'
    },
    category: {
      type: 'string',
      enum: CATEGORIES,
      description: 'Property category. Flats, apartments, villas and houses are residential.'
    },
    status: {
      type: 'string',
      description: 'Only "ready to move" is meaningful; it excludes under-construction properties.'
    },
    bedrooms: { type: 'integer', minimum: 1, description: 'Exact bedroom (BHK) count.' },
    minBedrooms: { type: 'integer', minimum: 1, description: 'Minimum bedroom (BHK) count, for "3 or more".' },
    bathrooms: { type: 'integer', minimum: 1, description: 'Minimum bathroom count.' },
    minBudget: { type: 'number', minimum: 0, description: 'Minimum budget in rupees, for example 7500000.' },
    maxBudget: { type: 'number', minimum: 1, description: 'Maximum budget in rupees. 1.5 crore is 15000000.' },
    readyToMove: { type: 'boolean', description: 'True if the customer wants ready-to-move only.' },
    dealBreakers: {
      type: 'array',
      items: { type: 'string' },
      description: 'Things the customer will not accept, for example "under construction".'
    },
    mustHaves: {
      type: 'array',
      items: { type: 'string' },
      description: 'Things the customer insists on, for example "ready to move".'
    },
    customerId: { type: 'string', description: 'Lead id, used only to record searches with no exact match.' },
    limit: { type: 'integer', minimum: 1, maximum: 25, default: 5, description: 'How many matches to return.' },
    offset: { type: 'integer', minimum: 0, default: 0, description: 'Skip this many matches, for "show more".' }
  };
}

function leadMemoryProperties() {
  const list = (description) => ({ type: 'array', items: { type: 'string' }, description });

  return {
    customerId: {
      type: 'string',
      description: 'Stable lead identifier, such as telegram:<id> or whatsapp:+91...'
    },
    displayName: { type: 'string', description: 'Name if known.' },
    handle: { type: 'string', description: 'Chat username if known.' },
    phone: { type: 'string', description: 'Phone number the customer chose to share.' },
    source: { type: 'string', description: 'Where the customer came from, such as a campaign code.' },
    leadStage: {
      type: 'string',
      enum: STAGES,
      description:
        'Pipeline stage. Set negotiating when they discuss price, discount or terms, or compare options. Set not_interested if they say they are done. Only site visit buttons set site_visit_ready.'
    },
    stageReason: { type: 'string', description: 'One line on why the stage changed.' },
    intent: { type: 'string', description: 'For example buy_residential, invest_commercial or buy_plot.' },
    budgetMin: { type: 'number', minimum: 0, description: 'Minimum budget in rupees.' },
    budgetMax: { type: 'number', minimum: 1, description: 'Maximum budget in rupees.' },
    preferredLocations: list('Preferred Chennai areas. Send the full current list.'),
    propertyCategories: list('Wanted categories. Send the full current list.'),
    bedrooms: { type: 'integer', minimum: 1, description: 'Preferred bedroom count.' },
    bathrooms: { type: 'integer', minimum: 1, description: 'Preferred bathroom count.' },
    mustHaves: list('Must-have requirements. Send the full current list.'),
    dealBreakers: list('Things the customer will not accept. Send the full current list.'),
    urgency: { type: 'string', description: 'Buying timeline.' },
    financingStatus: { type: 'string', description: 'Loan, cash, pre-approved, investor or unknown.' },
    keyPoints: {
      type: 'array',
      description: 'Important facts from the conversation. These are added to what is already saved.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'text', 'confidence'],
        properties: {
          type: { type: 'string', description: 'requirement, objection, negotiation, urgency, financing or follow_up.' },
          text: { type: 'string', description: 'Short human-readable point.' },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        }
      }
    },
    shortlistedPropertyIds: list('Property ids to add to the shortlist. Existing ones are kept.'),
    lastQuerySummary: { type: 'string', description: 'One sentence on the latest request.' },
    nextAction: { type: 'string', description: 'Recommended next step for the sales team.' }
  };
}
