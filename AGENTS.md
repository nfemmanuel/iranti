# AGENTS.md â€” Iranti System Context

This file is the primary context document for any AI agent, coding assistant,
or human developer working in this codebase. Read this before touching anything.

---

## What Iranti Is

Iranti (Yoruba: memory / remembrance) is memory infrastructure for multi-agent
AI systems. It gives agents shared, persistent, consistent knowledge across
sessions and across multiple agents working on the same problem.

Iranti is not an agent framework. It does not orchestrate tasks or run agents.
It is the memory layer that sits underneath agent systems. Other systems plug
into it.

Primary retrieval mode is identity-based lookup (`entityType/entityId + key`).
Iranti also supports optional hybrid search (full-text + vector similarity).

Product type: IaaS (Infrastructure as a Service)
License: AGPL

---

## The Staff â€” System Components

Iranti has five internal components collectively called The Staff:

### The Library
The knowledge base itself. PostgreSQL database with five core tables:
- `knowledge_base` â€” active truth. What agents read from and write to.
- `archive` â€” challenged truth. Superseded or contradicted entries with full
  provenance. Never deleted.
- `entity_relationships` â€” directional relationships between entities. Caller-
  defined relationship types (MEMBER_OF, PART_OF, AUTHORED, etc.).
- `entities` â€” canonical entity identity registry (`entityType + entityId`).
- `entity_aliases` â€” normalized aliases mapped to canonical entities for
  resolution across detector/extractor/query variants.

There is also a protected Staff Namespace: entries where `entityType = 'system'`.
No agent can write here. Only the seed script and explicit system operations
can. The Staff Namespace holds operating rules for all Staffers and system
metadata including source reliability scores and ontology governance records.

### The Librarian
The agent that manages the Library. All writes from external agents go through
the Librarian â€” never directly to the database. Responsibilities:
- Receives findings from agents, decides how to store them
- Chunks raw content blobs into atomic facts before writing
- Loads source reliability scores and applies weighted confidence to all writes
- Checks new findings for conflicts with existing entries
- Resolves conflicts deterministically when confidence gap >= 10 points
- Uses LLM reasoning (conflict_resolution task type) for ambiguous conflicts
- Escalates genuinely unresolvable conflicts to the Escalation Folder
- Updates agent stats after every write
- Logs every decision with a reason â€” nothing is silently overwritten
- May record repeated unknown concepts into ontology candidate tracking, but may not
  promote new core ontology terms automatically

### The Attendant
A stateful, per-agent class. One instance per external agent per process.
Manages that agent's working memory. Serves the agent, not the user.

Each agent gets its own `AttendantInstance`. The singleton registry
(`src/attendant/registry.ts`) ensures the same agentId always returns the
same instance within a process. State is persisted to the Library between
sessions under `agent / agentId / attendant_state`.

Responsibilities:
- Handshake on agent startup: loads operating rules from Staff Namespace,
  infers task type from recent messages, builds working memory brief from
  relevant KB entries and related entity knowledge
- Relevance filtering: loads only what is relevant to the current task,
  not the full KB. Uses the knowledge graph to pull in related entity entries
  automatically
- Reconvene: updates working memory if task context has shifted. Returns
  existing brief with updated timestamp if task is unchanged
- In-memory consolidation: `updateWorkingMemory()` updates the brief without
  a DB round trip â€” the Attendant is a fast cache, the Librarian owns truth
- Context recovery: after 20 LLM calls, re-reads operating rules from Staff
  Namespace rather than hallucinating behavior. Resets call counter

Context inference method: observes the agent's recent messages to infer
current task â€” does not require the agent to explicitly signal task type.

### The Archivist
A periodic cleanup agent. Does not run on every write. Runs on a schedule or
when conflict flags exceed a threshold. Responsibilities:
- Archives expired entries (validUntil has passed)
- Archives low confidence entries (below threshold)
- Applies opt-in Ebbinghaus-style confidence decay using `lastAccessedAt`
  and `stability`, then archives facts that decay below threshold
- Resolves pending escalation intervals by closing the contested archive row and reopening current truth in `knowledge_base`
- Reads Escalation Folder for RESOLVED files, parses `AUTHORITATIVE_JSON`,
  writes to KB as authoritative (confidence = 100, source = HumanReview)
- Optionally appends non-authoritative LLM enrichment notes for human audit
- Moves resolved files to escalation/resolved/, archives copy to
  escalation/archived/ with timestamp

The Archivist never deletes. Worst case of bad reasoning is a messy Archive,
not lost knowledge.

### The Resolutionist
An interactive CLI helper for human conflict review. It does not write to the
database directly. Instead, it reads pending escalation files, guides a human
reviewer through the conflicting facts, writes valid `AUTHORITATIVE_JSON`, and
marks the file `RESOLVED` for the Archivist to process.

Responsibilities:
- Scans `escalation/active/` for files still marked `PENDING`
- Displays conflict context clearly for a reviewer
- Lets the reviewer accept the existing fact, accept the challenger, or enter
  a custom value
- Rewrites escalation markdown in the exact format the Archivist already parses
- Leaves archival and KB writes to the Archivist maintenance cycle

---

## LLM Abstraction Layer

All model calls go through `src/lib/llm.ts` and `src/lib/router.ts`. Never
call a provider SDK directly from component code.

### Task Types and Model Routing
Each LLM call declares a task type. The router selects the appropriate model:

| Task Type | Default Model | Reason |
|---|---|---|
| classification | gemini-2.5-flash | Fast, cheap |
| relevance_filtering | gemini-2.5-flash | Fast enough |
| conflict_resolution | gemini-2.5-pro | Needs careful reasoning |
| summarization | gemini-2.5-flash | Well within fast model capability |
| task_inference | gemini-2.5-flash | Lightweight classification |

Override any model via environment variable (e.g. `CONFLICT_MODEL=claude-opus-4`).

### Providers
Providers live in `src/lib/providers/`. Current implementations:
- `mock.ts` â€” hardcoded responses for local dev and testing (default)
- `gemini.ts` â€” Google Gemini via REST API
- `claude.ts` â€” Anthropic Claude via Anthropic SDK API
- `openai.ts` â€” OpenAI chat/responses API
- `groq.ts` â€” Groq chat completions API
- `mistral.ts` â€” Mistral chat completions API
- `ollama.ts` â€” local Ollama runtime

Switch provider by setting `LLM_PROVIDER` in `.env`. Swap is a one-line
config change â€” no code changes required.

Provider API-key management is exposed through the CLI:
- `iranti list api-keys`
- `iranti add api-key`
- `iranti update api-key`
- `iranti remove api-key`

These commands update stored upstream provider credentials in the target
instance env without requiring users to edit `.env` files manually.

---

## Source Reliability Learning

The Librarian tracks per-source reliability scores in the Staff Namespace
under `system / librarian / source_reliability`. Scores are used to compute
weighted confidence: `confidence Ã— 0.7 + confidence Ã— reliability Ã— 0.3`.

- Default score: 0.5 (neutral, used for unknown sources)
- Range: 0.1 â€“ 1.0
- Win delta: +0.03 per resolution won
- Loss delta: -0.02 per resolution lost
- Human override delta: +/- 0.08
- Decay rate: 0.005 toward neutral per update cycle

Scores update automatically after every conflict resolution. Over hundreds of
resolutions, trusted sources score higher and their findings carry more weight.

---

## Agent Registry

Agents are first-class entities in the Library. Each registered agent has:
- `agent / agentId / profile` â€” name, description, capabilities, model
- `agent / agentId / stats` â€” totalWrites, totalRejections, totalEscalations,
  avgConfidence, lastSeen, isActive
- `agent / agentId / attendant_state` â€” persisted Attendant working memory

Stats update automatically on every `librarianWrite` call. No manual tracking
needed. `whoKnows(entityType, entityId)` returns every agent that has written
a fact about a given entity.

---

## API Key Authorization

Registry-backed API keys support both global scopes and namespace-aware scopes.

- Global scopes remain unchanged: `kb:read`, `kb:write`, `memory:read`
- Entity-bound KB routes may also use namespaced scopes:
  - `kb:read:project/acme`
  - `kb:write:project/*`
  - `kb:deny:project/rival`

Rules:
- scope format is `resource:action` or `resource:action:entityType/entityId`
- wildcard is allowed only as `entityType/*`
- deny beats allow
- exact namespace beats wildcard namespace
- entity-bound KB routes enforce namespace ACLs at the API layer
- `GET /kb/search`, `POST /kb/batchQuery`, and `/memory/*` still use coarse global scopes in the current implementation

---

## File Structure

```
iranti/
â”œâ”€â”€ src/
â”‚   â”œâ”€â”€ library/
â”‚   â”‚   â”œâ”€â”€ client.ts           â€” Prisma singleton
â”‚   â”‚   â”œâ”€â”€ queries.ts          â€” All KB read/write operations
â”‚   â”‚   â”œâ”€â”€ embeddings.ts       â€” Deterministic embedding generation utilities
â”‚   â”‚   â”œâ”€â”€ vectorBackend.ts    â€” Vector backend interface for pgvector/Qdrant/Chroma
â”‚   â”‚   â”œâ”€â”€ backends/           â€” Vector backend implementations + factory
â”‚   â”‚   â”œâ”€â”€ entity-resolution.ts â€” Canonical entity resolution + alias mapping
â”‚   â”‚   â”œâ”€â”€ relationships.ts    â€” Entity relationship graph
â”‚   â”‚   â””â”€â”€ agent-registry.ts  â€” Agent profiles, stats, whoKnows
â”‚   â”œâ”€â”€ librarian/
â”‚   â”‚   â”œâ”€â”€ index.ts            â€” librarianWrite, librarianIngest
â”‚   â”‚   â”œâ”€â”€ chunker.ts          â€” Raw content â†’ atomic EntryInput facts
â”‚   â”‚   â””â”€â”€ source-reliability.ts â€” Reliability scores, weighted confidence
â”‚   â”œâ”€â”€ attendant/
â”‚   â”‚   â”œâ”€â”€ index.ts            â€” Re-exports + legacy functional API
â”‚   â”‚   â”œâ”€â”€ AttendantInstance.ts â€” Per-agent stateful class
â”‚   â”‚   â””â”€â”€ registry.ts         â€” Singleton map, getAttendant()
â”‚   â”œâ”€â”€ archivist/
â”‚   â”‚   â””â”€â”€ index.ts            â€” runArchivist(), escalation processing
â”‚   â”œâ”€â”€ chat/
â”‚   â”‚   â””â”€â”€ index.ts            â€” Interactive CLI chat session backed by Iranti APIs + routed LLM calls
â”‚   â”œâ”€â”€ resolutionist/
â”‚   â”‚   â””â”€â”€ index.ts            â€” Interactive escalation review + AUTHORITATIVE_JSON writer
â”‚   â”œâ”€â”€ lib/
â”‚   â”‚   â”œâ”€â”€ llm.ts              â€” LLMProvider interface, completeWithFallback(), fallback chain
â”‚   â”‚   â”œâ”€â”€ router.ts           â€” route() by TaskType, model profiles
â”‚   â”‚   â”œâ”€â”€ runtimeEnv.ts       â€” Runtime env resolution for CLI/MCP/hook integrations
â”‚   â”‚   â”œâ”€â”€ runtimeLifecycle.ts â€” Runtime metadata read/write, pid probes, restart helpers
â”‚   â”‚   â”œâ”€â”€ autoRemember.ts    â€” Opt-in explicit prompt memory capture for Claude/Codex integrations, routing personal facts separately from project facts
â”‚   â”‚   â”œâ”€â”€ cliHelpCatalog.ts   â€” Extracted command/help catalog text for CLI guidance surfaces
â”‚   â”‚   â”œâ”€â”€ cliHelpRenderer.ts  â€” Shared CLI help rendering for command and wizard guidance
â”‚   â”‚   â”œâ”€â”€ escalationPaths.ts  â€” Escalation runtime path resolution + folder bootstrap
â”‚   â”‚   â””â”€â”€ providers/
â”‚   â”‚       â”œâ”€â”€ mock.ts         â€” Local dev provider
â”‚   â”‚       â”œâ”€â”€ gemini.ts       â€” Google Gemini provider
â”‚   â”‚       â”œâ”€â”€ claude.ts       â€” Anthropic Claude provider
â”‚   â”‚       â”œâ”€â”€ openai.ts       â€” OpenAI provider
â”‚   â”‚       â”œâ”€â”€ groq.ts         â€” Groq provider
â”‚   â”‚       â”œâ”€â”€ mistral.ts      â€” Mistral AI provider
â”‚   â”‚       â””â”€â”€ ollama.ts       â€” Ollama local provider
â”‚   â”œâ”€â”€ sdk/
â”‚   â”‚   â””â”€â”€ index.ts            â€” Iranti class, public API
â”‚   â”œâ”€â”€ api/
â”‚   â”‚   â”œâ”€â”€ server.ts           â€” Express REST API server
â”‚   â”‚   â”œâ”€â”€ middleware/
â”‚   â”‚   â”‚   â””â”€â”€ auth.ts         â€” API key authentication
â”‚   â”‚   â””â”€â”€ routes/
â”‚   â”‚       â”œâ”€â”€ knowledge.ts    â€” Write, ingest, query, hybrid search, relationships, resolution
â”‚   â”‚       â”œâ”€â”€ agents.ts       â€” Agent registration and management
â”‚   â”‚       â””â”€â”€ memory.ts       â€” Handshake, session inspection/recovery, reconvene, observe, attend, whoKnows, maintenance
â”‚   â””â”€â”€ types.ts                â€” Shared TypeScript types
â”œâ”€â”€ prisma/
â”‚   â”œâ”€â”€ schema.prisma           â€” KnowledgeEntry, Archive, EntityRelationship, Entity, EntityAlias
â”‚   â””â”€â”€ migrations/             â€” Migration history
â”œâ”€â”€ scripts/
â”‚   â”œâ”€â”€ seed.ts                 â€” Seeds Staff Namespace
â”‚   â”œâ”€â”€ harness.ts              â€” Shared test harness bootstrap (DB + escalation path)
â”‚   â”œâ”€â”€ api-key-create.ts       â€” Creates/rotates per-user API key tokens
â”‚   â”œâ”€â”€ api-key-list.ts         â€” Lists API key registry entries
â”‚   â”œâ”€â”€ api-key-revoke.ts       â€” Revokes API key tokens
â”‚   â”œâ”€â”€ bump-version.ts         â€” Bumps coordinated Node/Python/runtime version surfaces for releases
â”‚   â”œâ”€â”€ check-release-version.ts â€” Verifies Node/Python/package tag version alignment before publish
â”‚   â”œâ”€â”€ iranti-cli.ts           â€” Machine install, configure/auth/status/diagnostics/upgrade, instance/project binding, provider-key management, MCP and Claude hook CLI
â”‚   â”œâ”€â”€ iranti-mcp.ts           â€” Stdio MCP server for Claude Code, Codex, and other MCP clients
â”‚   â”œâ”€â”€ codex-setup.ts          â€” Registers Iranti MCP with Codex global config, preferring the installed CLI path
â”‚   â”œâ”€â”€ claude-code-memory-hook.ts â€” Claude Code hook helper for SessionStart/UserPromptSubmit
â”‚   â”œâ”€â”€ demo.ts                 â€” Full system demo with two agents
â”‚   â”œâ”€â”€ test-librarian.ts       â€” Librarian smoke tests
â”‚   â”œâ”€â”€ test-attendant.ts       â€” Attendant smoke tests
â”‚   â”œâ”€â”€ test-archivist.ts       â€” Archivist smoke tests
â”‚   â”œâ”€â”€ test-chunker.ts         â€” Chunker + ingest tests
â”‚   â”œâ”€â”€ test-reliability.ts     â€” Source reliability learning tests
â”‚   â”œâ”€â”€ test-relationships.ts   â€” Knowledge graph tests
â”‚   â”œâ”€â”€ test-registry.ts        â€” Agent registry tests
â”‚   â”œâ”€â”€ test-sdk.ts             â€” Full SDK smoke tests
â”‚   â”œâ”€â”€ test-integration.ts     â€” End-to-end integration test
â”‚   â”œâ”€â”€ test-fallback.ts        â€” LLM provider fallback chain test
â”‚   â””â”€â”€ test-contracts.ts       â€” API/SDK/client contract drift checks
â”œâ”€â”€ bin/
â”‚   â””â”€â”€ iranti.js               â€” CLI launcher used by npm global installs
â”œâ”€â”€ escalation/                 â€” Optional local folder if IRANTI_ESCALATION_DIR points here
â”‚   â”œâ”€â”€ active/                 â€” Unresolved conflicts (PENDING)
â”‚   â”œâ”€â”€ resolved/               â€” Processed by Archivist
â”‚   â””â”€â”€ archived/               â€” Long-term conflict log
â”œâ”€â”€ docs/
â”‚   â”œâ”€â”€ engineering/            â€” CODE_STANDARDS.md, COMMENTING_GUIDELINES.md
â”‚   â”œâ”€â”€ decisions/              â€” One file per architectural decision
â”‚   â”œâ”€â”€ features/               â€” One subfolder per feature, including cli-uninstall, ontology-evolution, cross-tool-handoffs, and compatibility-contracts
â”‚   â””â”€â”€ internal/               â€” Internal design notes, validation artifacts, and compatibility backlog
+-- clients/
¦   +-- python/
¦       +-- iranti.py           — Python HTTP client for REST API
¦       +-- test_client.py      — Python client smoke test
¦       +-- README.md           — Python client documentation
¦       +-- pyproject.toml      — Python package metadata for PyPI
¦       +-- LICENSE             — AGPL metadata for Python package
¦   +-- typescript/
¦       +-- src/
¦       ¦   +-- client.ts       — External TypeScript HTTP client for REST API
¦       ¦   +-- types.ts        — Request/response and error types for npm client
¦       ¦   +-- index.ts        — Re-exports for package consumers
¦       +-- package.json        — npm package metadata for @iranti/sdk
¦       +-- tsconfig.json       — Package-local TypeScript build config
¦       +-- README.md           — TypeScript client documentation
+-- tests/
¦   +-- conflict/
¦   ¦   +-- run_conflict_benchmark.ts — Benchmark runner for adversarial conflict scenarios
¦   ¦   +-- *.ts                — Direct contradiction, temporal, cascading, and multi-hop conflict cases
¦   +-- vector-backends/
¦   ¦   +-- run_vector_backend_tests.ts — Vector backend factory + adapter tests
¦   +-- runtime-lifecycle/
¦   ¦   +-- run_runtime_lifecycle_tests.ts — CLI runtime metadata and restart guard smoke test
¦   +-- temporal/
¦   ¦   +-- common.ts           — Temporal test DB fallback and harness helpers
¦   ¦   +-- run_temporal_tests.ts — DB-backed temporal query/history/escalation validation
¦   +-- consistency/
¦       +-- run_consistency_tests.ts — Empirical validation for write serialization, read-after-write, escalation visibility, and observe isolation
¦   +-- session-recovery/
¦   ¦   +-- run_session_recovery_tests.ts — Stubbed attendant recovery validation without a live DB
¦   +-- cross-tool/
¦   ¦   +-- run_cross_tool_handoff_tests.ts — DB-backed Claude/Codex shared-memory handoff validation
¦   +-- claude-hook/
¦   ¦   +-- run_claude_hook_tests.ts — Claude hook handshake/attend contract regression test
¦   +-- memory-retrieval-regressions.ts — Slash-value retrieval and explicit-hint isolation regressions
+-- AGENTS.md                   — This file
â”œâ”€â”€ docker-compose.yml          â€” PostgreSQL for local dev
â””â”€â”€ .env                        â€” Local environment (never committed)
```

---

Additional current paths not called out explicitly above:
- `src/security/apiKeys.ts` â€” registry-backed API key storage and validation
- `src/security/scopes.ts` â€” scope parsing and namespace ACL evaluation
- `src/api/middleware/authorization.ts` â€” global and namespace-aware scope enforcement
- `tests/access-control/run_access_control_tests.ts` â€” namespace-aware authorization coverage

---

## Database Schema â€” Quick Reference

Decay extension note:
- `knowledge_base` now also stores `lastAccessedAt` and `stability`
- decay helpers live in `src/lib/decay.ts`
- targeted decay tests live in `tests/decay/`
- the internal design note is `docs/internal/decay.md`
- consistency model documentation lives in `docs/internal/consistency_model.md`
- empirical consistency validation lives in `tests/consistency/`
- DB-backed temporal validation lives in `tests/temporal/`

### knowledge_base
| Column | Type | Notes |
|---|---|---|
| id | Int | Auto-increment primary key |
| entityType | String | Caller-defined: researcher, agent, system, etc. |
| entityId | String | Canonical identifier |
| key | String | What this entry describes |
| valueRaw | Json | Full exact value |
| valueSummary | String | Compressed for working memory loading |
| confidence | Int | 0â€“100 raw. Weighted by source reliability at resolution |
| source | String | Data source |
| validFrom | DateTime | When this row became the active truth interval |
| validUntil | DateTime? | Expiry for time-sensitive facts |
| lastAccessedAt | DateTime | Last time this fact was returned to an agent |
| stability | Float | Decay resistance for the forgetting pass |
| createdBy | String | Agent or system that wrote it |
| isProtected | Boolean | True for Staff Namespace entries |
| conflictLog | Json | History of contradictions |
| properties | Json | Caller-defined metadata escape hatch |
| embedding | vector(256)? | Optional embedding used by hybrid search ranking |

Primary index: `(entityType, entityId, key)` â€” unique constraint enforced.

### archive
Same as knowledge_base, plus:
| Column | Type | Notes |
|---|---|---|
| validFrom | DateTime | When this archived interval began |
| validUntil | DateTime? | When this archived interval stopped governing truth; NULL while escalation is pending |
| archivedAt | DateTime | When moved to Archive |
| archivedReason | Enum | `segment_closed` / `superseded` / `contradicted` / `escalated` / `expired` / `duplicate` |
| resolutionState | Enum | `not_applicable` / `pending` / `resolved` |
| resolutionOutcome | Enum | `not_applicable` / `challenger_won` / `original_retained` |
| supersededBy | Int? | ID of KB entry that replaced this |
| properties | Json | Caller-defined metadata |

### entity_relationships
| Column | Type | Notes |
|---|---|---|
| id | Int | Auto-increment primary key |
| fromType | String | Source entity type |
| fromId | String | Source entity ID |
| relationshipType | String | Caller-defined: MEMBER_OF, PART_OF, AUTHORED, etc. |
| toType | String | Target entity type |
| toId | String | Target entity ID |
| properties | Json | Caller-defined relationship metadata |
| createdBy | String | Who created this relationship |

Unique constraint: `(fromType, fromId, relationshipType, toType, toId)`.
Indexed on both `(fromType, fromId)` and `(toType, toId)` for fast traversal.

### entities
| Column | Type | Notes |
|---|---|---|
| entityType | String | Canonical entity type |
| entityId | String | Canonical entity ID |
| displayName | String | Human-readable label |
| createdAt | DateTime | Creation timestamp |

Primary key: `(entityType, entityId)`.

### entity_aliases
| Column | Type | Notes |
|---|---|---|
| id | Int | Auto-increment primary key |
| entityType | String | Alias type scope |
| aliasNorm | String | Normalized alias key |
| rawAlias | String | Raw alias text as observed |
| canonicalEntityType | String | Canonical target type |
| canonicalEntityId | String | Canonical target ID |
| source | String | Where alias came from (observe/query/write/etc.) |
| confidence | Int | Confidence attached to alias mapping |
| createdAt | DateTime | Creation timestamp |

Unique constraint: `(entityType, aliasNorm)`.
Indexed on `(canonicalEntityType, canonicalEntityId)`.

---

## Staff Namespace â€” Protected Entries

| Key | Contents |
|---|---|
| system / librarian / operating_rules | Write rules, conflict resolution behavior |
| system / librarian / source_reliability | Per-source reliability scores (auto-updated) |
| system / attendant / operating_rules | Handshake, relevance filtering, reconvene rules |
| system / archivist / operating_rules | Archive triggers, escalation processing rules |
| system / library / schema_version | Current schema version |
| system / library / initialization_log | When Library was initialized |
| system / auth / api_keys | Per-user API key registry (keyId + hashed secret + metadata) |
| system / ontology / core_schema | Canonical ontology base layer: core entity types, keys, relationships, normalization rules |
| system / ontology / extension_registry | Registered extension namespaces and status |
| system / ontology / candidate_terms | Repeated unknown terms staged for review |
| system / ontology / promotion_policy | Deterministic promotion thresholds and blocked auto-promotions |
| system / ontology / change_log | Append-only ontology governance log |

---

## SDK â€” Public API

```typescript
const iranti = new Iranti({ connectionString, llmProvider });

// Write atomic fact
await iranti.write({ entity, key, value, summary, confidence, source, agent, validFrom });

// Ingest raw content blob (auto-chunks into atomic facts)
await iranti.ingest({ entity, content, source, confidence, agent });

// Agent working memory
const brief = await iranti.handshake({ agentId, task, recentMessages });
await iranti.reconvene(agentId, { task, recentMessages });
const turn = await iranti.attend({ agentId, latestMessage, currentContext, entityHints });
const attendant = iranti.getAttendant(agentId);

// Session checkpoints and recovery
const checkpoint = await iranti.checkpoint({ agentId, task, recentMessages, checkpoint: { currentStep, nextStep, openRisks } });
const sessions = await iranti.listSessions();
const session = await iranti.inspectSession({ agentId });
const resumed = await iranti.resumeSession({ agentId, sessionId });
const completed = await iranti.completeSession({ agentId, sessionId });
const abandoned = await iranti.abandonSession({ agentId, sessionId });

// Query
const result = await iranti.query(entity, key);
const asOf = await iranti.query(entity, key, { asOf: new Date('2026-03-14T00:00:00Z') });
const history = await iranti.history(entity, key);
const all = await iranti.queryAll(entity);
const matches = await iranti.search({ query, entityType, limit });

// Relationships
await iranti.relate(fromEntity, relationshipType, toEntity, { createdBy });
const related = await iranti.getRelated(entity);
const deep = await iranti.getRelatedDeep(entity, depth);

// Agent registry
await iranti.registerAgent({ agentId, name, description, capabilities, model });
const record = await iranti.getAgent(agentId);
const knowers = await iranti.whoKnows(entity);
const agents = await iranti.listAgents();
await iranti.assignToTeam(agentId, teamId);

// Maintenance
await iranti.runMaintenance();
```

Entity format: `"entityType/entityId"` e.g. `"researcher/jane_smith"`

---

## Rules for Working in This Codebase

### For AI Agents and Coding Assistants
- Read this file before making any changes
- Never write directly to any DB table â€” all writes go through the Librarian
- Never modify entries where `isProtected = true`
- Never delete from the Archive table
- Never call provider SDKs directly â€” use `route()` or `complete()` from
  `src/lib/router.ts` and `src/lib/llm.ts`
- LLM provider fallback is automatic â€” configure via `LLM_PROVIDER_FALLBACK` env var,
  mock is always used as final safety net
- Follow CODE_STANDARDS.md in docs/engineering/
- Treat backward compatibility as a product requirement across CLI, API, SDK, config, and runtime metadata surfaces
- If a public or automation-facing surface changes, update the compatibility docs and add or adjust contract coverage
- When adding a new component or method, update this file

### For Humans
- All architectural decisions go in docs/decisions/ as individual files
- `.env` is never committed
- Escalation files in escalation/active/ are written by the Librarian â€”
  human resolution goes in the HUMAN RESOLUTION section only, change
  Status to RESOLVED when done
- The Staff Namespace (entityType = system) is only modified by seed.ts
  or explicit system operations (including API key registry scripts) â€” never by external agents
- Package publishing is driven by `.github/workflows/publish-packages.yml`; release tags and package versions must match

---

## Documentation Standards

### Doc Types and Where They Live

- **docs/guides/** â€” How-to guides for developers using Iranti. One file per
  topic, including Claude Code / MCP integration and Codex setup. Written for external developers, not internal contributors.
- **docs/decisions/** â€” Architectural decision records (ADRs). One file per
  decision. Named `NNN-short-title.md` e.g. `001-agpl-license.md`. Never
  deleted or edited after the fact â€” add a new ADR if a decision changes.
- **docs/features/** â€” One subfolder per feature. Each contains `spec.md`
  covering inputs, outputs, decision tree, edge cases, and test results.
  Current feature folders include Claude/Codex MCP integration, compatibility
  contracts, and memory lifecycle policy.
- **docs/engineering/** â€” Internal standards for contributors.
  `CODE_STANDARDS.md`, `COMMENTING_GUIDELINES.md`.
- **docs/internal/** â€” Internal design notes, validation artifacts, and release/backward-compatibility backlogs. `docs/internal/README.md` is the index for trust levels and categories inside this folder. Internal docs are supporting material, not canonical product contract, unless a guide/spec/decision explicitly points to them.
- **README.md** â€” Public-facing overview. Updated only when public API or
  onboarding flow changes.
- **AGENTS.md** â€” System context for AI agents and contributors. Updated
  whenever components, rules, file structure, or schema change.
- **Living Document (Iranti_Living_Document.docx)** â€” Full implementation
  history, decisions, and current state. Updated after every significant
  build session.

### What Triggers a Documentation Update

| Change Type | Required Updates |
|---|---|
| New SDK method | Update `src/sdk/index.ts` JSDoc, `docs/guides/quickstart.md`, README.md SDK section, AGENTS.md SDK table |
| New provider | Update `docs/guides/providers.md`, `.env.example`, AGENTS.md providers table |
| New feature | Create `docs/features/[feature-name]/spec.md`, update AGENTS.md file structure, update README.md if user-facing |
| Architectural decision | Create `docs/decisions/NNN-title.md` |
| Schema change | Update AGENTS.md schema section, update `docs/features/` spec if relevant |
| Breaking API change | Update README.md, `docs/guides/quickstart.md`, `clients/python/iranti.py` docstrings, bump version in `package.json` |
| Compatibility or deprecation policy change | Update `docs/decisions/007-compatibility-policy.md`, `docs/features/compatibility-contracts/spec.md`, and `docs/internal/compatibility_backlog.md` |
| New benchmark suite | Update AGENTS.md file structure and add methodology under `docs/internal/` |
| New internal summary/backlog/audit artifact | Update `docs/internal/README.md` and, if discovery expectations changed, `docs/README.md` |

### ADR Format

Every file in `docs/decisions/` must follow this exact structure:

```markdown
# NNN â€” Title

## Context
What situation or problem led to this decision?

## Decision
What was decided?

## Consequences
What are the results of this decision â€” good and bad?

## Alternatives Considered
What else was evaluated and why was it rejected?
```

### Feature Spec Format

Every `docs/features/*/spec.md` must follow this structure:

```markdown
# Feature Name

## Overview
One paragraph describing what the feature does and why it exists.

## Inputs
Table of inputs with types and descriptions.

## Outputs
Table of outputs with types and descriptions.

## Decision Tree / Flow
Step-by-step logic or flowchart in text form.

## Edge Cases
List of edge cases and how they are handled.

## Test Results
Summary of test output confirming the feature works.

## Related
Links to related docs, decisions, and source files.
```

### Crosschecking Checklist

Before committing any change, verify:

- [ ] Does AGENTS.md reflect the current file structure?
- [ ] Does AGENTS.md reflect the current schema?
- [ ] Does AGENTS.md reflect the current SDK API?
- [ ] If a new feature was added, does `docs/features/` have a spec?
- [ ] If an architectural decision was made, does `docs/decisions/` have an ADR?
- [ ] If the public API changed, is README.md updated?
- [ ] If a compatibility surface changed, were compatibility docs and contract tests updated?
- [ ] If a new provider was added, is `docs/guides/providers.md` updated?
- [ ] If onboarding steps changed, is `docs/guides/quickstart.md` updated?
- [ ] Is the Living Document updated with implementation notes?

### Living Document Rule

The Living Document (`Iranti_Living_Document.docx`) is the authoritative
record of implementation history. It is updated after every significant build
session. It is not a substitute for inline docs or AGENTS.md â€” it is the
audit trail. If the Living Document and AGENTS.md disagree, AGENTS.md is the
source of truth for current state.

Rules:
- Do not summarize or compress existing Living Document entries
- Add new entries at the end of the relevant section
- Never edit past entries â€” add corrections as new entries
- The Living Document is generated programmatically from `iranti_living_doc.js`
  â€” do not edit the `.docx` directly

---

## CLI Surface

Installed-package user flows are expected to work through the CLI without
manual env-file editing. Current CLI coverage includes:
- `iranti setup`
- `iranti install`
- `iranti instance create|list|show`
- `iranti run`
- `iranti configure instance|project`
- `iranti auth create-key|list-keys|revoke-key`
- `iranti list api-keys`
- `iranti add api-key`
- `iranti update api-key`
- `iranti remove api-key`
- `iranti doctor`
- `iranti status`
- `iranti upgrade`
- `iranti chat`
- `iranti resolve`
- `iranti mcp`
- `iranti claude-setup` / `iranti claude-setup --scan [dir]`
- `iranti claude-hook`
- `iranti codex-setup`
- `iranti integrate claude|codex`

---

## Escalation Folder

Unresolvable conflicts land in `escalation/active/` as markdown files.
Runtime root is configurable with `IRANTI_ESCALATION_DIR` and defaults to
`~/.iranti/escalation` if unset.
Each file has two sections:

**LIBRARIAN ASSESSMENT** â€” written by the Librarian. Contains entity,
existing and incoming values, confidence scores, reasoning, and
`**Status:** PENDING`.

**HUMAN RESOLUTION** â€” written by a human, with optional plain-language notes.
Change `**Status:** PENDING` to `**Status:** RESOLVED` when done and include
`### AUTHORITATIVE_JSON` with valid JSON. JSON is the commit source.

The Archivist watches for RESOLVED files, extracts the resolution via LLM,
writes to KB as authoritative truth (confidence = 100, source = HumanReview),
and moves the file to escalation/resolved/ with an archived copy.

---

## Current Build Status

| Phase | Description | Status |
|---|---|---|
| 0 â€” Architecture | Schema, PRD, docs | DONE |
| 1 â€” The Library | DB client, CRUD, seed script, relationships, registry | DONE |
| 2 â€” The Librarian | Conflict resolution, chunking, source reliability | DONE |
| 3 â€” The Attendant | Per-agent class, singleton registry, session persistence | DONE |
| 4 â€” The Archivist | Periodic scan, escalation processing | DONE |
| 5 â€” Integration | Full multi-agent loop, end-to-end tests | DONE |
| 6 â€” SDK | TypeScript SDK, full public API | DONE |
| 7 â€” Open Source | README, Docker onboarding, GitHub public | IN PROGRESS |
| 8 â€” Hosted Version | Cloud deployment, pricing | Not Started |
