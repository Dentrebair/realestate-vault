# Real Estate Meta Business Agent Connector

Lightweight Node.js/Express connector for a WhatsApp customer support agent built with Meta Business Agent. It exposes an OpenAPI-described property search tool backed by Supabase PostgreSQL.

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

The service starts on `http://localhost:3000` by default.

## Endpoints

- `GET /health` - service health and Supabase configuration status
- `GET /openapi.json` - OpenAPI 3.1 contract for tool registration
- `GET /openai-tools.json` - OpenAI function tool schema for direct OpenAI API integrations
- `POST /tools/search-properties` - search Chennai property listings

## Search Payload

```json
{
  "location": "OMR",
  "category": "apartment",
  "bedrooms": 3,
  "minBudget": 7500000,
  "maxBudget": 15000000,
  "limit": 5
}
```

All filters are optional. Budgets are expected in INR.

## Authentication

Set `CONNECTOR_BEARER_TOKEN` to require:

```http
Authorization: Bearer your-token
```

Leave it empty for local development or private network testing.
