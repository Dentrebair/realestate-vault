export function buildOpenApiDocument(baseUrl) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Chennai Real Estate Connector',
      version: '0.1.0',
      description:
        'Property search tool for a Meta Business Agent answering Chennai real estate WhatsApp queries.'
    },
    servers: [{ url: baseUrl }],
    paths: {
      '/health': {
        get: {
          operationId: 'healthCheck',
          summary: 'Check connector health',
          responses: {
            200: {
              description: 'Connector health status'
            }
          }
        }
      },
      '/tools/search-properties': {
        post: {
          operationId: 'searchChennaiProperties',
          summary: 'Search Chennai real estate listings',
          description:
            'Find available properties by location, category, bedroom count, and INR budget range.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SearchPropertiesRequest' }
              }
            }
          },
          responses: {
            200: {
              description: 'Matching property listings',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SearchPropertiesResponse' }
                }
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
          summary: 'Store customer lead status and critical buying signals',
          description:
            'Persist a compact lead summary with requirements, objections, shortlisted properties, urgency, financing, and next action. Do not store the full chat transcript.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UpsertLeadMemoryRequest' }
              }
            }
          },
          responses: {
            200: {
              description: 'Saved lead memory',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/UpsertLeadMemoryResponse' }
                }
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
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer'
        }
      },
      schemas: {
        SearchPropertiesRequest: {
          type: 'object',
          additionalProperties: false,
          properties: {
            location: {
              type: 'string',
              description: 'Chennai area, locality, corridor, or neighborhood.'
            },
            query: {
              type: 'string',
              description:
                'Free-text property need from the customer, such as sea view, gated community, furnished, ready to move, car parking, landmark, or amenity terms.'
            },
            category: {
              type: 'string',
              description: 'Property category such as apartment, villa, plot, or commercial.'
            },
            status: {
              type: 'string',
              description: 'Availability or listing status, such as available or ready to move.'
            },
            bedrooms: {
              type: 'integer',
              minimum: 1,
              description: 'Requested BHK count.'
            },
            bathrooms: {
              type: 'integer',
              minimum: 1,
              description: 'Requested bathroom count.'
            },
            minBudget: {
              type: 'number',
              minimum: 0,
              description: 'Minimum budget in INR.'
            },
            maxBudget: {
              type: 'number',
              minimum: 1,
              description: 'Maximum budget in INR.'
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 25,
              default: 10
            }
          }
        },
        SearchPropertiesResponse: {
          type: 'object',
          properties: {
            configured: { type: 'boolean' },
            count: { type: 'integer' },
            message: { type: 'string' },
            results: {
              type: 'array',
              items: { $ref: '#/components/schemas/PropertyResult' }
            }
          }
        },
        PropertyResult: {
          type: 'object',
          properties: {
            id: { type: ['string', 'number'] },
            title: { type: ['string', 'null'] },
            location: { type: ['string', 'null'] },
            category: { type: ['string', 'null'] },
            bedrooms: { type: ['integer', 'null'] },
            bathrooms: { type: ['integer', 'null'] },
            price: { type: ['number', 'null'] },
            availability: { type: ['string', 'null'] },
            configuration: { type: ['string', 'object', 'null'] },
            source: { type: ['string', 'null'] }
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
            lead: {
              type: 'object',
              additionalProperties: true
            }
          }
        }
      }
    }
  };
}

export function buildOpenAiTools() {
  return {
    tools: [
      {
        type: 'function',
        name: 'search_chennai_properties',
        description:
          'Search Chennai real estate listings by natural language terms, location, category, budget, bedrooms, bathrooms, and availability status.',
        strict: true,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: {
              type: ['string', 'null'],
              description:
                'Free-text customer need, such as sea view, gated community, furnished, ready to move, car parking, landmark, or amenity terms.'
            },
            location: {
              type: ['string', 'null'],
              description: 'Chennai area, locality, corridor, or neighborhood.'
            },
            category: {
              type: ['string', 'null'],
              description: 'Property category such as apartment, villa, plot, residential, hospitality, commercial, or redevelopment.'
            },
            status: {
              type: ['string', 'null'],
              description: 'Availability or listing status, such as available or ready to move.'
            },
            bedrooms: {
              type: ['integer', 'null'],
              minimum: 1,
              description: 'Requested BHK count.'
            },
            bathrooms: {
              type: ['integer', 'null'],
              minimum: 1,
              description: 'Requested bathroom count.'
            },
            minBudget: {
              type: ['number', 'null'],
              minimum: 0,
              description: 'Minimum budget in INR.'
            },
            maxBudget: {
              type: ['number', 'null'],
              minimum: 1,
              description: 'Maximum budget in INR.'
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 25,
              description: 'Maximum number of listings to return.'
            }
          },
          required: [
            'query',
            'location',
            'category',
            'status',
            'bedrooms',
            'bathrooms',
            'minBudget',
            'maxBudget',
            'limit'
          ]
        }
      },
      {
        type: 'function',
        name: 'upsert_lead_memory',
        description:
          'Store a compact lead summary and critical key points from the customer conversation without storing the full chat transcript.',
        strict: true,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: leadMemoryProperties({ nullableOptionalFields: true }),
          required: [
            'customerId',
            'displayName',
            'leadStatus',
            'intent',
            'budgetMin',
            'budgetMax',
            'preferredLocations',
            'propertyCategories',
            'bedrooms',
            'bathrooms',
            'mustHaves',
            'dealBreakers',
            'urgency',
            'financingStatus',
            'keyPoints',
            'shortlistedPropertyIds',
            'lastQuerySummary',
            'nextAction'
          ]
        }
      }
    ]
  };
}

function leadMemoryProperties({ nullableOptionalFields = false } = {}) {
  const maybeString = nullableOptionalFields ? ['string', 'null'] : 'string';
  const maybeNumber = nullableOptionalFields ? ['number', 'null'] : 'number';
  const maybeInteger = nullableOptionalFields ? ['integer', 'null'] : 'integer';

  return {
    customerId: {
      type: 'string',
      description: 'Stable customer identifier, preferably WhatsApp ID or Meta user ID.'
    },
    displayName: {
      type: maybeString,
      description: 'Customer display name if known.'
    },
    leadStatus: {
      type: 'string',
      enum: [
        'new',
        'searching',
        'shortlisted',
        'callback_requested',
        'site_visit_requested',
        'not_interested',
        'closed'
      ],
      description: 'Current lead pipeline status.'
    },
    intent: {
      type: maybeString,
      description: 'Customer intent such as buy_residential, invest_commercial, lease, or site_visit.'
    },
    budgetMin: {
      type: maybeNumber,
      minimum: 0,
      description: 'Minimum budget in INR.'
    },
    budgetMax: {
      type: maybeNumber,
      minimum: 1,
      description: 'Maximum budget in INR.'
    },
    preferredLocations: {
      type: 'array',
      items: { type: 'string' },
      description: 'Preferred Chennai locations, corridors, or landmarks.'
    },
    propertyCategories: {
      type: 'array',
      items: { type: 'string' },
      description: 'Desired property categories.'
    },
    bedrooms: {
      type: maybeInteger,
      minimum: 1,
      description: 'Preferred bedroom count.'
    },
    bathrooms: {
      type: maybeInteger,
      minimum: 1,
      description: 'Preferred bathroom count.'
    },
    mustHaves: {
      type: 'array',
      items: { type: 'string' },
      description: 'Critical requirements like parking, gated community, sea view, furnishing, or possession timeline.'
    },
    dealBreakers: {
      type: 'array',
      items: { type: 'string' },
      description: 'Constraints or objections such as no old buildings, no high floor, or strict budget ceiling.'
    },
    urgency: {
      type: maybeString,
      description: 'Buying urgency or timeline.'
    },
    financingStatus: {
      type: maybeString,
      description: 'Loan, cash, pre-approved, investor, or unknown financing status.'
    },
    keyPoints: {
      type: 'array',
      description: 'Important facts extracted from the conversation, not full transcript text.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'text', 'confidence'],
        properties: {
          type: {
            type: 'string',
            description:
              'Point category, such as requirement, objection, urgency, financing, contact_preference, or follow_up.'
          },
          text: {
            type: 'string',
            description: 'Short human-readable key point.'
          },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1
          }
        }
      }
    },
    shortlistedPropertyIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'Property IDs the customer showed interest in.'
    },
    lastQuerySummary: {
      type: maybeString,
      description: 'One-sentence summary of the latest property request.'
    },
    nextAction: {
      type: maybeString,
      description:
        'Recommended next action, such as send_more_options, arrange_callback, schedule_visit, or ask_budget.'
    }
  };
}
