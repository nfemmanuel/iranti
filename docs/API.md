# API Reference

This document reflects the current Express API in `src/api/server.ts` and route handlers in `src/api/routes/*`.

## Base URL

```
http://localhost:3001
```

## Authentication

- Most endpoints require: `X-Iranti-Key: <IRANTI_API_KEY>`
- Chat-completions compatibility endpoints use: `Authorization: Bearer <IRANTI_API_KEY>`
- Public endpoint: `GET /health`

## Core Endpoints

### Health

- `GET /health` (public)

Response:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "provider": "mock"
}
```

### Knowledge Base (`/kb/*`)

- `POST /kb/write`
- `POST /kb/ingest`
- `POST /kb/resolve`
- `POST /kb/alias`
- `GET /kb/entity/:entityType/:entityId/aliases`
- `GET /kb/query/:entityType/:entityId/:key`
- `GET /kb/query/:entityType/:entityId`
- `POST /kb/relate`
- `GET /kb/related/:entityType/:entityId`
- `GET /kb/related/:entityType/:entityId/deep?depth=2`
- `POST /kb/batchQuery`

Write request body:

```json
{
  "entity": "project/nexus_prime",
  "key": "deadline",
  "value": {"date": "2028-06-18"},
  "summary": "Deadline is June 18, 2028",
  "confidence": 95,
  "source": "project_manager",
  "agent": "planning_agent_001"
}
```

Write response:

```json
{
  "action": "created",
  "key": "deadline",
  "reason": "No existing entry found. Created.",
  "resolvedEntity": "project/nexus_prime",
  "inputEntity": "project/nexus_prime"
}
```

Query response (`GET /kb/query/:entityType/:entityId/:key`):

```json
{
  "found": true,
  "value": {"date": "2028-06-18"},
  "summary": "Deadline is June 18, 2028",
  "confidence": 95,
  "source": "project_manager",
  "validUntil": null,
  "resolvedEntity": "project/nexus_prime",
  "inputEntity": "project/nexus_prime"
}
```

### Memory (`/memory/*`)

- `POST /memory/handshake`
- `POST /memory/reconvene`
- `POST /memory/observe`
- `GET /memory/whoknows/:entityType/:entityId`
- `POST /memory/maintenance`

Observe request body:

```json
{
  "agentId": "research_agent_001",
  "currentContext": "User: What's the deadline?",
  "maxFacts": 5,
  "entityHints": ["project/nexus_prime"]
}
```

Observe response:

```json
{
  "facts": [],
  "entitiesDetected": [],
  "alreadyPresent": 0,
  "totalFound": 0
}
```

### Agents (`/agents/*`)

- `POST /agents/register`
- `GET /agents`
- `GET /agents/:agentId`
- `POST /agents/:agentId/team`

### Metrics

- `GET /metrics`
- `POST /metrics/reset`

### Chat-Completions Compatibility

- `POST /v1/chat/completions`
- `POST /chat/completions`

These endpoints proxy to the configured provider and return OpenAI-style response objects.

## Error Responses

Common error envelope:

```json
{
  "error": "message"
}
```

Typical status codes:

- `400`: validation/request errors
- `401`: missing/invalid API key
- `404`: missing resource (for agent lookup)
- `429`: rate-limited
- `500`: server-side error

## Notes

- Request body validation is currently enforced on:
  - `POST /kb/write`
  - `POST /kb/relate`
  - `POST /memory/handshake`
- Rate limiting middleware is applied to protected route groups (`/kb`, `/memory`, `/agents`).
