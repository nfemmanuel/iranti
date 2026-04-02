# API Reference

This document reflects the current Express API in `src/api/server.ts` and route handlers in `src/api/routes/*`.

## Base URL

```
http://localhost:3001
```

## Authentication

- Most endpoints require an API token via either:
  - `X-Iranti-Key: <api_key_token>` (recommended)
  - `Authorization: Bearer <api_key_token>`
- Public endpoint: `GET /health`

Supported key modes:
- Registry key (recommended): `<keyId>.<secret>` (create with `npm run api-key:create -- --key-id ... --owner ...`)
- Legacy single key: `IRANTI_API_KEY`
- Legacy key list: `IRANTI_API_KEYS` (comma-separated)

Scope model:
- `/kb/*`: `kb:read` for GET/read, `kb:write` for POST/write
- `/memory/*`: `memory:read` for GET/read, `memory:write` for POST/write
- `/agents/*`: `agents:read` for GET/read, `agents:write` for POST/write
- `/metrics`: `metrics:read`
- `/metrics/reset`: `metrics:write`
- `/v1/chat/completions` and `/chat/completions`: `proxy:chat`
- `/dev/*`: `system:admin`

Namespace-aware scopes are supported for entity-bound KB routes:
- `kb:read:project/acme`
- `kb:write:project/*`
- `kb:deny:project/rival`

Rules:
- scope format is `resource:action` or `resource:action:entityType/entityId`
- wildcard is allowed only as `entityType/*`
- deny beats allow
- exact namespace beats wildcard namespace
- `GET /kb/search`, `POST /kb/batchQuery`, and `/memory/*` still require coarse global scopes in the current implementation

## Core Endpoints

### Health

- `GET /health` (public)

Response:

```json
{
  "status": "ok",
  "operatorStatus": "ok",
  "version": "0.2.15",
  "provider": "mock",
  "runtime": {
    "instanceName": "local",
    "pid": 25476,
    "port": 3001,
    "status": "running",
    "startedAt": "2026-03-21T07:12:34.000Z",
    "lastHeartbeatAt": "2026-03-21T07:13:04.000Z",
    "healthUrl": "http://localhost:3001/health"
  },
  "authority": {
    "managed": true,
    "source": "explicit",
    "detail": "using explicit runtime authority",
    "instanceDir": "C:\\Users\\NF\\.iranti\\instances\\local",
    "runtimeFile": "C:\\Users\\NF\\.iranti\\instances\\local\\runtime.json"
  },
  "checks": {
    "runtimeMetadata": {
      "checked": true,
      "ok": true,
      "detail": "runtime metadata written successfully"
    },
    "vectorBackend": {
      "checked": false,
      "ok": true,
      "detail": "vector backend has not been probed yet"
    }
  }
}
```

### Knowledge Base (`/kb/*`)

- `POST /kb/write`
- `POST /kb/ingest`
- `POST /kb/resolve`
- `POST /kb/alias`
- `GET /kb/entity/:entityType/:entityId/aliases`
- `GET /kb/query/:entityType/:entityId/:key`
- `GET /kb/history/:entityType/:entityId/:key`
- `GET /kb/query/:entityType/:entityId`
- `GET /kb/search`
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
  "validFrom": "2028-01-10T00:00:00.000Z",
  "validUntil": null,
  "contested": false,
  "fromArchive": false,
  "archivedReason": null,
  "resolutionState": null,
  "resolutionOutcome": null,
  "resolvedEntity": "project/nexus_prime",
  "inputEntity": "project/nexus_prime"
}
```

Temporal query variant:

```
GET /kb/query/:entityType/:entityId/:key?asOf=2028-03-01T00:00:00.000Z&includeContested=true&includeExpired=false
```

History response (`GET /kb/history/:entityType/:entityId/:key`):

```json
[
  {
    "value": {"date": "2028-06-18"},
    "summary": "Deadline was initially June 18, 2028",
    "confidence": 95,
    "source": "project_manager",
    "validFrom": "2028-01-10T00:00:00.000Z",
    "validUntil": "2028-02-15T00:00:00.000Z",
    "isCurrent": false,
    "contested": false,
    "archivedReason": "superseded",
    "resolutionState": "not_applicable",
    "resolutionOutcome": "not_applicable"
  }
]
```

Hybrid search request (`GET /kb/search`):

```json
{
  "query": "deadline blocker launch readiness",
  "limit": 10,
  "entityType": "project",
  "lexicalWeight": 0.45,
  "vectorWeight": 0.55,
  "minScore": 0.05
}
```

Equivalent query string:

```
/kb/search?query=deadline+blocker+launch+readiness&limit=10&entityType=project&lexicalWeight=0.45&vectorWeight=0.55&minScore=0.05
```

Hybrid search response:

```json
{
  "results": [
    {
      "id": 42,
      "entity": "project/nexus_prime",
      "key": "blocker",
      "value": {"text": "Vendor security review pending"},
      "summary": "Current blocker is vendor security review",
      "confidence": 91,
      "source": "release_pm",
      "validUntil": null,
      "lexicalScore": 0.37,
      "vectorScore": 0.82,
      "score": 0.62
    }
  ]
}
```

### Memory (`/memory/*`)

- `POST /memory/handshake`
- `POST /memory/reconvene`
- `GET /memory/sessions`
- `GET /memory/ledger`
- `GET /memory/session/:agentId`
- `POST /memory/checkpoint`
- `POST /memory/resume`
- `POST /memory/complete`
- `POST /memory/abandon`
- `POST /memory/observe`
- `POST /memory/attend`
- `GET /memory/whoknows/:entityType/:entityId`
- `POST /memory/maintenance`

Handshake request body:

```json
{
  "agentId": "research_agent_001",
  "task": "Audit launch blockers for local setup",
  "recentMessages": [
    "Investigating Docker fallback behavior.",
    "Need to verify upgrade behavior on Windows."
  ]
}
```

`agent` is still accepted as a legacy alias, but `agentId` is the preferred field name for new integrations.

`GET /memory/sessions` accepts optional query parameters:

- `agentId` - exact agent filter
- `operatorState` - one of `none`, `active`, `interrupted`, `completed`, `abandoned`
- `staleOnly` - `true` or `false`
- `limit` - integer `1..100`
- `sort` - one of `operator`, `updated_desc`, `agent_asc`

Session inventory response (`GET /memory/sessions`):

```json
[
  {
    "agentId": "research_agent_001",
    "hasCheckpoint": true,
    "sessionId": "sess_123",
    "task": "Audit launch blockers for local setup",
    "status": "interrupted",
    "operatorState": "interrupted",
    "startedAt": "2026-03-23T08:20:00.000Z",
    "lastHeartbeatAt": "2026-03-23T08:26:00.000Z",
    "updatedAt": "2026-03-23T08:31:00.000Z",
    "interruptedAt": "2026-03-23T08:31:00.000Z",
    "completedAt": null,
    "abandonedAt": null,
    "resumedAt": null,
    "isStale": true,
    "persistedBriefGeneratedAt": "2026-03-23T08:31:00.000Z",
    "checkpointSummary": {
      "currentStep": "collecting Windows lifecycle traces",
      "nextStep": "compare runtime roots",
      "openRiskCount": 1,
      "entityTargetCount": 0
    }
  }
]
```

Session inspection response (`GET /memory/session/:agentId`):

```json
{
  "agentId": "research_agent_001",
  "hasCheckpoint": true,
  "persistedBriefGeneratedAt": "2026-03-23T08:31:00.000Z",
  "sessionCheckpoint": {
    "sessionId": "sess_123",
    "task": "Audit launch blockers for local setup",
    "taskFingerprint": "audit launch blockers for local setup",
    "status": "interrupted",
    "startedAt": "2026-03-23T08:20:00.000Z",
    "lastHeartbeatAt": "2026-03-23T08:26:00.000Z",
    "updatedAt": "2026-03-23T08:31:00.000Z",
    "checkpoint": {
      "currentStep": "collecting Windows lifecycle traces",
      "nextStep": "compare runtime roots",
      "openRisks": ["stale metadata semantics unclear"]
    },
    "interruptedAt": "2026-03-23T08:31:00.000Z"
  },
  "summary": {
    "agentId": "research_agent_001",
    "hasCheckpoint": true,
    "sessionId": "sess_123",
    "task": "Audit launch blockers for local setup",
    "status": "interrupted",
    "operatorState": "interrupted",
    "startedAt": "2026-03-23T08:20:00.000Z",
    "lastHeartbeatAt": "2026-03-23T08:26:00.000Z",
    "updatedAt": "2026-03-23T08:31:00.000Z",
    "interruptedAt": "2026-03-23T08:31:00.000Z",
    "completedAt": null,
    "abandonedAt": null,
    "resumedAt": null,
    "isStale": true,
    "persistedBriefGeneratedAt": "2026-03-23T08:31:00.000Z",
    "checkpointSummary": {
      "currentStep": "collecting Windows lifecycle traces",
      "nextStep": "compare runtime roots",
      "openRiskCount": 1,
      "entityTargetCount": 0
    }
  },
  "sessionRecovery": {
    "available": true,
    "sessionId": "sess_123",
    "task": "Audit launch blockers for local setup",
    "taskFingerprint": "audit launch blockers for local setup",
    "matchedCurrentTask": false,
    "matchConfidence": 0,
    "recommendation": "review",
    "summary": "Resume from collecting Windows lifecycle traces.",
    "lastHeartbeatAt": "2026-03-23T08:26:00.000Z",
    "interruptedAt": "2026-03-23T08:31:00.000Z",
    "checkpoint": {
      "currentStep": "collecting Windows lifecycle traces",
      "nextStep": "compare runtime roots",
      "openRisks": ["stale metadata semantics unclear"]
    }
  }
}
```

Session ledger response (`GET /memory/ledger`):

Optional query parameters:
- `agentId`
- `sessionId`
- `actionType`
- `source`
- `host`
- `level`
- `since` (ISO timestamp)
- `until` (ISO timestamp)
- `limit` (1-500, default 100)

Response:

```json
{
  "items": [
    {
      "eventId": "evt_123",
      "timestamp": "2026-03-28T18:22:31.000Z",
      "staffComponent": "Attendant",
      "actionType": "attend_completed",
      "agentId": "claude_code_main",
      "source": "mcp",
      "level": "debug",
      "reason": "personal_height_recall_prompt",
      "metadata": {
        "sessionId": "2026-03-28T18:20:00.000Z"
      }
    }
  ],
  "total": 1
}
```

If the target instance is missing `staff_events`, first-party hosts now attempt an idempotent bootstrap before retrying the read. The route returns `SESSION_LEDGER_UNAVAILABLE` only if that bootstrap still fails:

```json
{
  "error": "staff_events table is missing. Create it before querying the session ledger.",
  "code": "SESSION_LEDGER_UNAVAILABLE"
}
```

Checkpoint request body:

```json
{
  "agentId": "research_agent_001",
  "task": "Audit launch blockers for local setup",
  "recentMessages": [
    "Investigating Docker fallback behavior.",
    "Need to verify upgrade behavior on Windows."
  ],
  "checkpoint": {
    "currentStep": "Comparing docs with runtime behavior",
    "nextStep": "Patch API docs and rerun tests",
    "openRisks": ["Repo .env points at a stale local schema"],
    "recentOutputs": ["runtime-upgrades spec drafted"],
    "entityTargets": ["project/iranti"],
    "notes": "Resume from contract parity if the session drops."
  }
}
```

Checkpoint response:

```json
{
  "agentId": "research_agent_001",
  "operatingRules": "Attendant manages per-agent working memory.",
  "inferredTaskType": "research",
  "workingMemory": [],
  "sessionStarted": "2026-03-21T07:10:00.000Z",
  "briefGeneratedAt": "2026-03-21T07:13:30.000Z",
  "contextCallCount": 0,
  "sessionLedgerLearnings": [
    {
      "actionType": "memory_injected",
      "summary": "memory injected from plain_cli: user/main/height",
      "timestamp": "2026-03-28T18:22:31.000Z",
      "source": "cli",
      "host": "plain_cli",
      "sessionId": "2026-03-28T18:20:00.000Z",
      "entityKey": "user/main/height",
      "reason": "personal_height_recall_prompt"
    }
  ],
  "sessionCheckpoint": {
    "sessionId": "sess_9f21b6f7",
    "task": "Audit launch blockers for local setup",
    "taskFingerprint": "2d0c0f4f5f0c9d2f",
    "status": "active",
    "startedAt": "2026-03-21T07:10:00.000Z",
    "lastHeartbeatAt": "2026-03-21T07:13:30.000Z",
    "updatedAt": "2026-03-21T07:13:30.000Z",
    "checkpoint": {
      "currentStep": "Comparing docs with runtime behavior",
      "nextStep": "Patch API docs and rerun tests",
      "openRisks": ["Repo .env points at a stale local schema"]
    }
  },
  "sessionRecovery": null
}
```

Resume / complete / abandon request body:

```json
{
  "agentId": "research_agent_001",
  "sessionId": "sess_9f21b6f7"
}
```

Resume / complete / abandon response:

```json
{
  "agentId": "research_agent_001",
  "operatingRules": "Attendant manages per-agent working memory.",
  "inferredTaskType": "research",
  "workingMemory": [],
  "sessionStarted": "2026-03-21T07:10:00.000Z",
  "briefGeneratedAt": "2026-03-21T07:14:00.000Z",
  "contextCallCount": 0,
  "sessionLedgerLearnings": [],
  "sessionCheckpoint": {
    "sessionId": "sess_9f21b6f7",
    "task": "Audit launch blockers for local setup",
    "taskFingerprint": "2d0c0f4f5f0c9d2f",
    "status": "completed",
    "startedAt": "2026-03-21T07:10:00.000Z",
    "lastHeartbeatAt": "2026-03-21T07:13:30.000Z",
    "updatedAt": "2026-03-21T07:14:00.000Z",
    "completedAt": "2026-03-21T07:14:00.000Z",
    "checkpoint": {
      "currentStep": "Comparing docs with runtime behavior",
      "nextStep": "Patch API docs and rerun tests"
    }
  },
  "sessionRecovery": null
}
```

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
  "totalFound": 0,
  "usageGuidance": {
    "tool": "observe",
    "reminder": "Iranti is a hive mind. iranti_attend is mandatory before each reply and around knowledge discovery; if you skip that loop, later sessions will have to rediscover context.",
    "expectedCallSequence": [
      "Call iranti_handshake at session start and again after context compaction.",
      "Call iranti_attend before replying to the user.",
      "Call iranti_attend before knowledge discovery tools such as search, query, or read.",
      "Call iranti_attend again after knowledge discovery when new findings may affect retrieval.",
      "Use iranti_write for durable findings and iranti_checkpoint at meaningful pauses."
    ],
    "note": "observe() is retrieval-only. It surfaces candidate facts for context and warm-up, but it does not persist memory, replace iranti_attend, or count as a checkpoint/write."
  }
}
```

Attend request body:

```json
{
  "agentId": "research_agent_001",
  "latestMessage": "What is my favorite snack?",
  "currentContext": "User: Hi\nAssistant: Hello",
  "phase": "pre-response",
  "maxFacts": 5,
  "entityHints": ["user/main"]
}
```

`phase` is one of `"pre-response"`, `"post-response"`, or `"mid-turn"`. Pass `"pre-response"` before replying and `"post-response"` after. When `protocolEnforcement` is `strict`, starting a new `"pre-response"` turn before closing the previous one with `"post-response"` returns a 428 protocol violation.

Attend response:

```json
{
  "shouldInject": true,
  "reason": "memory_needed_injected",
  "decision": {
    "needed": true,
    "confidence": 0.92,
    "method": "heuristic",
    "explanation": "memory_reference_detected"
  },
  "facts": [
    {
      "entityKey": "user/main/favorite_snack",
      "summary": "favorite_snack: popcorn",
      "value": {"text": "popcorn"},
      "confidence": 90,
      "source": "chatbot_user",
      "lastUpdated": "2026-03-21T09:10:00.000Z"
    }
  ],
  "entitiesDetected": ["user/main"],
  "alreadyPresent": 0,
  "totalFound": 1,
  "usageGuidance": {
    "tool": "attend",
    "reminder": "Iranti is a hive mind. iranti_attend is mandatory before each reply and around knowledge discovery; if you skip that loop, later sessions will have to rediscover context.",
    "expectedCallSequence": [
      "Call iranti_handshake at session start and again after context compaction.",
      "Call iranti_attend(phase='pre-response') before replying to the user.",
      "Call iranti_attend before knowledge discovery tools such as search, query, or read.",
      "Call iranti_attend again after knowledge discovery when new findings may affect retrieval.",
      "Call iranti_attend(phase='post-response') after every response.",
      "Use iranti_write for durable findings and iranti_checkpoint at meaningful pauses."
    ],
    "note": "After using attend() and any retrieved facts, persist durable learnings with iranti_write and shared progress with iranti_checkpoint when applicable."
  },
  "compliance": {
    "status": "healthy",
    "summary": "Session compliance is healthy.",
    "issues": [],
    "lastUpdated": "2026-03-21T09:10:00.000Z",
    "counters": {
      "attendsWithoutPersist": 0,
      "consecutivePreResponseWithoutPost": 0,
      "pendingPostResponse": true,
      "lastAttendPhase": "pre-response"
    }
  }
}
```

Each injected fact includes:
- `entityKey` — `entityType/entityId/key` path that identifies the fact
- `summary` — human-readable summary of the fact value
- `value` — the stored fact value
- `confidence` — confidence score (0–100) at write time
- `source` — what wrote this fact (agent or source identifier)
- `lastUpdated` — ISO timestamp of when the fact was last written; use this to judge freshness

Top-level injection decision fields:
- `shouldInject` — whether facts were injected into this response
- `reason` — one of `memory_needed_injected`, `memory_needed_no_facts`, `memory_needed_but_in_context`, `memory_not_needed`, `forced`
- `decision.method` — how the decision was made: `heuristic`, `llm`, `forced`, or `advisory`
- `alreadyPresent` — how many facts were skipped because they were already in visible context
- `totalFound` — total facts retrieved before the `alreadyPresent` filter
- `compliance` — per-session protocol compliance state (see Session Compliance below)

#### Session Compliance

The `compliance` object returned by attend shows the per-session protocol health:

```json
{
  "status": "healthy",
  "summary": "Session compliance is healthy.",
  "issues": [],
  "lastUpdated": "2026-03-21T09:10:00.000Z",
  "counters": {
    "attendsWithoutPersist": 0,
    "consecutivePreResponseWithoutPost": 0,
    "pendingPostResponse": true,
    "lastAttendPhase": "pre-response"
  }
}
```

`status` is one of `healthy`, `degraded`, or `non_compliant`. Issues have a `code` (`missing_post_response_attend` or `missing_durable_persistence`), `severity` (`warn` or `error`), and `requiredAction`.

### Protocol Enforcement

When the Iranti SDK or API server is initialized with `protocolEnforcement: 'strict'`, knowledge-base discovery routes enforce the handshake → attend → discover turn cycle. Violations return HTTP 428 with a structured body:

```json
{
  "error": "Protocol violation: iranti_query is blocked for agent research_agent_001 until iranti_handshake runs for the current session.",
  "code": "handshake_required",
  "protocolViolation": {
    "code": "handshake_required",
    "agentId": "research_agent_001",
    "operation": "query",
    "message": "Protocol violation: iranti_query is blocked for agent research_agent_001 until iranti_handshake runs for the current session.",
    "requiredAction": "Call iranti_handshake for this agent, then call iranti_attend before discovery if the operation is a read/search traversal tool."
  }
}
```

Violation codes:
- `handshake_required` — agent has not called `/memory/handshake` for this session
- `attend_required` — agent called handshake but has not called `/memory/attend` for this turn, or the per-turn discovery budget (1 read per attend) has been exhausted
- `post_response_required` — agent is starting a new `pre-response` turn without having closed the previous turn via `attend(phase='post-response')`

Affected routes under strict enforcement: `GET /kb/query/:entityType/:entityId/:key`, `GET /kb/history/:entityType/:entityId/:key`, `GET /kb/query/:entityType/:entityId`, `GET /kb/search`, `GET /kb/related/:entityType/:entityId`, `GET /kb/related/:entityType/:entityId/deep`.

Default enforcement mode is `off`. Set `protocolEnforcement: 'warn'` in SDK config to log violations without blocking; set `'strict'` to block.

MCP tools under strict enforcement return a structured `protocolViolation` payload instead of an error result so the calling agent can read and act on the code.

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
- `428`: protocol precondition failed because the host skipped `handshake` or the current-turn `attend`
- `429`: rate-limited
- `500`: server-side error

Protocol-gated discovery endpoints now fail closed. `GET /kb/query/*`, `GET /kb/search`, `GET /kb/related/*`, `GET /memory/whoknows/*`, and `POST /memory/observe` return `428 Precondition Required` until the agent has completed `POST /memory/handshake`, and read/search traversal routes require a fresh `POST /memory/attend` for the current turn. Starting a new `POST /memory/attend` call with `phase="pre-response"` before the previous turn has been closed by `phase="post-response"` now returns a protocol violation as well. Session inspection/listing responses also expose structured lifecycle compliance state so hosts can distinguish healthy runs from degraded breadcrumb discipline or repeated missed post-response closes.

## Notes

- Request body validation is currently enforced on:
  - `POST /kb/write`
  - `POST /kb/relate`
  - `POST /memory/handshake`
  - `POST /memory/checkpoint`
  - `POST /memory/resume`
  - `POST /memory/complete`
  - `POST /memory/abandon`
- Rate limiting middleware is applied to protected route groups (`/kb`, `/memory`, `/agents`).
