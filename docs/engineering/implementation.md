# iranti-core Implementation Reference

> **This document is the single source of truth for every implementation decision in iranti-core.**
> It must be consulted before writing, changing, or reviewing any code.
> It must be updated whenever a decision changes.
> It exists to prevent knowledge drift across long sessions, context windows, and contributor handoffs.

---

## What iranti is

iranti is **automatic context engineering for AI agents**. It is an autonomous memory layer that sits between you and every AI host you use (Claude, ChatGPT, Gemini, etc.). It stores what matters, surfaces it at the right moment, and learns over time what to hold onto and what to let fade.

**Three categories of memory:**
- **Durable facts** — things that stay true across sessions (preferences, decisions, project state)
- **Rules and preferences** — how you want AI agents to behave (`always respond in English`, `never assume I'm a developer`)
- **Checkpoints** — where you left off in a long task so a new session can resume without re-explaining

**The core loop:**
1. Agent calls `iranti_attend` before responding — iranti injects relevant memory into context
2. Agent calls `iranti_write` after learning something — iranti stores it
3. Over time, iranti reinforces frequently-used facts and lets rarely-used ones decay

---

## What iranti is NOT

These are explicit out-of-scope boundaries. Do not let scope creep pull us in these directions early.

- **Not a chat history system.** We store durable facts, not raw message logs. Conversation history belongs in the host's own context window.
- **Not a search engine.** Retrieval in early phases is exact-match and entity-scoped. Semantic/vector search comes in Phase 3.
- **Not a rules engine.** iranti stores behavioral rules in a dedicated `rules` table and surfaces them for injection into agent context via `iranti_attend`. It does not evaluate, enforce, or act on them — that is the agent's job. Rules are plain natural language sentences that agents read and follow. The value of iranti's rules system is convergence: every AI host (Claude, ChatGPT, Gemini) sees the same rules on every `iranti_attend` call, which drives consistent behavior across platforms.
- **Not a multi-user SaaS (yet).** Phase 0-4 are single-user. Multi-user auth and tenancy is Phase 5.
- **Not a database for arbitrary app data.** Facts are about AI memory. Do not repurpose this as a general-purpose app database.

---

## Architecture overview

```
┌──────────────────────────────────────────────────────────────┐
│                        AI Hosts                              │
│   Claude    ChatGPT    Gemini    Dev CLI    (future: others) │
└──────────────────────┬───────────────────────────────────────┘
                       │ MCP protocol
                       ▼
┌──────────────────────────────────────────────────────────────┐
│                     MCP Server (Phase 1)                     │
│  iranti_attend  iranti_write  iranti_search  iranti_relate   │
└──────────────────────┬───────────────────────────────────────┘
                       │ function calls
                       ▼
┌──────────────────────────────────────────────────────────────┐
│                  Library Layer (Phase 0)                     │
│   agents.ts   sessions.ts   entities.ts   facts.ts          │
└──────────────────────┬───────────────────────────────────────┘
                       │ Drizzle ORM
                       ▼
┌──────────────────────────────────────────────────────────────┐
│               PostgreSQL (Docker Compose / hosted)           │
│  agents  sessions  entities  facts  fact_archive             │
└──────────────────────────────────────────────────────────────┘
```

**Technology choices:**
- **PostgreSQL** — primary database. Supports pgvector (Phase 3), Apache AGE for graph (Phase 2+), recursive CTEs.
- **Drizzle ORM** — query builder + type safety. No Rust proxy (better than Prisma for performance). Allows raw SQL when needed.
- **postgres.js** — the actual PostgreSQL driver. Lower overhead than `pg`/node-postgres.
- **Docker Compose** — local development database. One command: `pnpm db:up`.
- **TypeScript strict mode** — full strictness including `noUncheckedIndexedAccess`.
- **Vitest** — test runner.
- **ESLint 9 flat config** — linting with type-aware rules.

---

## Phase roadmap

### Phase 0 — Library Foundation (current)

**Goal:** A rock-solid data layer. No intelligence, no HTTP server, no MCP. Just the ability to store and retrieve facts reliably.

**Deliverables:**
- PostgreSQL schema: `agents`, `sessions`, `entities`, `facts`, `fact_archive`, `rules`
- Drizzle migrations (committed to `drizzle/` directory)
- CRUD library: `agents.ts`, `sessions.ts`, `entities.ts`, `facts.ts`, `rules.ts`
- Integration tests for all CRUD operations
- Docker Compose setup for local development

**Explicitly NOT in Phase 0:**
- No MCP server
- No HTTP API
- No conflict detection or resolution
- No semantic search or embeddings
- No decay calculations (but columns for Phase 4 data are present)
- No multi-user auth
- No entity aliases or relationships

**Status:** ✅ Complete. Schema, migrations (0000–0002), library CRUD, 46 integration tests, CI with PostgreSQL service — all committed on `iranti-core` (`7fadef5`).

---

### Phase 1 — MCP Server

**Goal:** Expose the library over the Model Context Protocol so AI agents can call iranti.

**Deliverables:**
- MCP server process (`src/mcp/server.ts`)
- Tools: `iranti_attend`, `iranti_write`, `iranti_search`, `iranti_archive`
- Agent handshake (auto-register agent on first call)
- Session management (open/close via MCP)
- Basic protocol enforcement (attend before write)

**Key decision — single-instance for Phase 1:** The MCP server is stateless in that all durable state lives in PostgreSQL. However, Phase 1 is designed for a **single MCP server instance** (one process, one user). Concurrent writes from multiple simultaneous instances are not prevented by Phase 1 code. Multi-instance concurrency (advisory locks, write serialization) is deferred to Phase 2. Do not run two Phase 1 servers against the same database expecting safe concurrent writes.

**Tools:**
- `iranti_attend` — inject relevant facts, rules, and the active checkpoint into the agent's context before responding
- `iranti_write` — store a learned fact
- `iranti_write_rule` — store a behavioral rule
- `iranti_archive` — mark a fact as no longer current

---

### Phase 2 — Intelligence Layer

**Goal:** iranti begins to understand what it stores, not just store it.

**Deliverables:**
- Conflict detection: writing a fact that contradicts an existing one triggers a resolution pass
- Entity relationship graph: store and query edges between entities
- `EntityRelationship` table (from old iranti: outbound/inbound traversal, `MEMBER_OF` teams, etc.)
- `WriteReceipt` table: idempotency for distributed writes
- `validFrom` / `validUntil` on facts: temporal validity windows
- `conflictLog` (JSON) on facts: append-only log of detected conflicts
- Contextual conflict detection (cross-entity consistency checks)
- Librarian: source reliability scoring — not all sources are equal

---

### Phase 3 — Cross-platform + Retrieval

**Goal:** iranti works on every AI host and can find relevant facts semantically.

**Deliverables:**
- Vector embeddings on facts (pgvector, 256 or 1536 dimensions — TBD)
- Hybrid search: lexical (full-text PostgreSQL) + vector (cosine similarity)
- Graph-bridged search: walk entity relationships to find nearby context
- `EntityAlias` table: one entity may have many names across platforms (user/niifemi = user/NF = user/oluwaniifemi)
- Surface-aware retrieval: optionally scope reads to facts from specific hosts
- Semantic fact tags: domain, intent, temporal scope (from old iranti)

---

### Phase 4 — Memory Lifecycle

**Goal:** iranti learns what to remember longer and what to forget.

**Deliverables:**
- Ebbinghaus forgetting curve: confidence decays as `confidence × e^(-(days_since_access / stability))`
- Hebbian reinforcement: each read increments `stabilityScore` by a configured amount (default +5, cap 365 days)
- Archivist daemon: scheduled scan that recalculates confidence for all live facts and archives those below threshold
- Archivist reasoning pass: AI-assisted proposals for which decaying facts to escalate vs. let expire
- Decay config: opt-in, all settings via environment variables (`IRANTI_DECAY_ENABLED`, `IRANTI_DECAY_STABILITY_BASE`, etc.)
- Initial stability seeded from source reliability: facts from high-reliability sources start with higher stability

**Why the columns exist from Phase 0:**
`stabilityScore`, `accessCount`, `lastAccessedAt`, and `confidence` are in the schema from the very beginning. Every fact write and every fact read populates these columns. By the time Phase 4 is implemented, there is months of data to work from. If we added these columns in Phase 4, we would have no historical signal.

---

### Phase 5 — Multi-user SaaS

**Goal:** iranti supports multiple independent users with auth, token management, and data isolation.

**Deliverables:**
- `users` table and `tokens` table (scoped API keys per surface)
- Row-level security on all fact queries
- User merge: cross-platform identity resolution (user/alice on Claude = user/alice@company on ChatGPT)
- Consumer MCP tokens (OAuth flow for non-developer users)
- Usage metering and rate limiting
- Admin dashboard

---

## Schema reference — Phase 0

### Table: `agents`

Every entity that writes facts must be a registered agent. Agents get a UUID that is tagged on every fact they write. This enables per-agent auditing and, in future phases, per-agent permissions.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | `gen_random_uuid()` |
| `name` | TEXT UNIQUE NOT NULL | Human-readable identifier. `registerAgent` is idempotent on name. |
| `description` | TEXT | Optional context about what this agent does. |
| `createdAt` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

**Key behavior:** `registerAgent(name)` is a get-or-create. Call it on every startup; if the agent already exists, it returns the existing record.

---

### Table: `rules`

Behavioral constraints on agents. Rules are injected into context before an agent responds, so the agent reads them and follows them.

Rules are fundamentally different from facts:

| | Facts | Rules |
|---|---|---|
| Format | key + value | plain natural language sentence |
| Write semantics | upsert (one value per key) | additive (multiple rules coexist) |
| Decay | yes (Phase 4) | never |
| Read side effects | updates access tracking | none |
| Purpose | observations about the world | imperatives on how to behave |

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `tenantId` | TEXT NOT NULL DEFAULT `'default'` | Tenant scoping seam. All Phase 0–4 rows use `'default'`. Phase 5 populates real tenant IDs. |
| `entityType` | TEXT NOT NULL | Scoping tier: `system`, `user`, `project` |
| `entityId` | TEXT NOT NULL | `global`, `nf`, `iranti-core`, etc. |
| `text` | TEXT NOT NULL | The rule in plain language. A full sentence the agent can read. |
| `isActive` | BOOLEAN NOT NULL DEFAULT TRUE | Deactivated rules are not injected. Kept for history. |
| `priority` | INTEGER NOT NULL DEFAULT 0 | Injection order. Higher = appears first. Suggested: 100+ critical, 50–99 strong, 1–49 soft, 0 default. |
| `source` | TEXT NOT NULL | What wrote this rule. |
| `agentId` | UUID FK | |
| `sessionId` | UUID FK | |
| `createdAt` | TIMESTAMPTZ NOT NULL | |
| `metadata` | JSONB | |

**No unique constraint.** Multiple rules per entity are normal and expected.

**Entity scoping convention:**
- `system/global` — always injected on every `iranti_attend` call
- `user/{id}` — injected whenever that user is the active user in session
- `project/{id}` — injected when that project is among the entity hints for the current turn

**Triggering model (Phase 1):**

`iranti_attend` receives a list of entity hints — which entities are in scope for this conversation turn. `getRulesForAttend(entityHints)` is called internally:

1. Always include `system/global` rules (de-duplicated)
2. Include active rules for any entity in the hints list
3. Return all matching rules ordered by `priority DESC`

The agent never picks rules manually. iranti decides what is relevant based on context scope.

---

### Table: `sessions`

A session groups everything that happens in one continuous interaction. Facts are tagged with a session ID so you can query "what did we learn in this session?"

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `agentId` | UUID FK → agents | Which agent owns this session. |
| `openedAt` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| `closedAt` | TIMESTAMPTZ | NULL = session still open. |
| `metadata` | JSONB | Optional bag of session-level context. |

**Key behavior:** Sessions are opened explicitly (`openSession`) and closed explicitly (`closeSession`). `getOpenSessions(agentId)` returns sessions that were never closed — useful for detecting crashed agents.

---

### Table: `entities`

An entity is the subject of a fact. `project/my-app`, `user/alice`, `system/global`. Entities are the namespace for facts — you cannot retrieve facts without specifying an entity.

| Column | Type | Notes |
|--------|------|-------|
| `entityType` | TEXT NOT NULL | Broad category: `project`, `user`, `system`, `team`, etc. |
| `entityId` | TEXT NOT NULL | Specific identifier within the type. |
| `label` | TEXT | Human-readable display name. Optional. |
| `createdAt` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

**Primary key:** `(entityType, entityId)` — composite.

**Key behavior:** `upsertEntity` is a get-or-create. You never need to create an entity before writing facts about it — `writeFact` can call `upsertEntity` internally. If `label` is provided on an existing entity, it is updated; otherwise it is left unchanged.

---

### Table: `facts`

The core primitive. One fact = one piece of information about one entity.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | Does NOT change on upsert. The UUID is stable for the lifetime of the fact. |
| `tenantId` | TEXT NOT NULL DEFAULT `'default'` | Tenant scoping seam. All Phase 0–4 rows use `'default'`. Phase 5 populates real tenant IDs. Part of the unique constraint. |
| `entityType` | TEXT NOT NULL | |
| `entityId` | TEXT NOT NULL | |
| `key` | TEXT NOT NULL | What this fact is about: `timezone`, `preferred_language`, `tech_stack`. |
| `value` | TEXT NOT NULL | The current value. Plain text. Structured data as JSON string. |
| `confidence` | REAL NOT NULL DEFAULT 1.0 | 0.0–1.0. Starts at 1.0, decays over time in Phase 4. |
| `source` | TEXT NOT NULL | **Free-text label** for what wrote this fact: `claude-code`, `chatgpt-session`, `manual`. This is not the surface enum — it is a human-readable provenance label. |
| `surface` | TEXT | **Validated enum** for which AI host platform wrote this fact: `claude`, `chatgpt`, `gemini`, `deepseek`, `dev_cli`, `web_ui`, `manual`. Nullable for writes not from a known host. Validated at write time by `assertValidSurface()` against `VALID_SURFACES`. |
| `agentId` | UUID FK → agents | **FK to registered agent**. NULL if written outside an agent session. Enables per-agent auditing. |
| `sessionId` | UUID FK → sessions | NULL if not in a session. |
| `isProtected` | BOOLEAN NOT NULL DEFAULT FALSE | If true, `writeFact` will refuse to overwrite. Only `adminOverrideFact` can change protected facts (Phase 2). |
| `isArchived` | BOOLEAN NOT NULL DEFAULT FALSE | True = this fact is inactive. Does not appear in normal reads. |
| `createdAt` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | Set on creation, never updated. |
| `updatedAt` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | Updated on every **write**. Distinct from `lastAccessedAt` — `updatedAt` only changes when the value changes; `lastAccessedAt` changes on reads. |
| `lastAccessedAt` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | Updated on every **read** (`readFact`, `readFactsByEntity`). Feeds Phase 4 decay. |
| `stabilityScore` | REAL NOT NULL DEFAULT 1.0 | How resistant this fact is to decay. Incremented on every read in Phase 4. |
| `accessCount` | INTEGER NOT NULL DEFAULT 0 | Lifetime read count. Feeds Phase 4 Hebbian reinforcement. |
| `metadata` | JSONB | Free-form extra data. Used by agents for provenance, context, etc. |

**Unique constraint:** `(tenantId, entityType, entityId, key)` — one active value per key per entity per tenant.

**Provenance — three distinct fields:**
- `source` (TEXT) — a free-text label describing *what* wrote the fact. Not validated. Examples: `"claude-code-session"`, `"manual"`, `"iranti-cli"`.
- `surface` (TEXT enum) — the AI host *platform* that was active when the fact was written. Validated at write time against `VALID_SURFACES`. Examples: `"claude"`, `"chatgpt"`, `"gemini"`.
- `agentId` (UUID FK) — the registered iranti agent that wrote the fact. Enables per-agent fact queries and future per-agent permissions.

**Key behaviors:**
- Writing a fact with the same `(entityType, entityId, key)` as an existing fact will: (1) snapshot the old value to `fact_archive` with `archivedReason = 'superseded'`, then (2) update the fact in place. The UUID does not change.
- Writing a fact with `isProtected = true` in place will throw an error. Protected facts can only be overwritten by an explicit admin operation (Phase 2).
- Reading a fact (`readFact`, `readFactsByEntity`) always updates `lastAccessedAt` and increments `accessCount` as a side effect.
- Archiving a fact (`archiveFact`) copies the current value to `fact_archive` with `archivedReason = 'archived_by_user'`, then sets `isArchived = true`. This is irreversible in Phase 0.

---

### Table: `fact_archive`

Every time a fact's value changes, or a fact is manually archived, a snapshot of the fact at that moment is written here. This table is append-only. It is the history of every fact that has ever existed.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `factId` | UUID NOT NULL FK → facts | The fact this is a snapshot of. Use this to query history for a given fact. |
| `tenantId` | TEXT NOT NULL DEFAULT `'default'` | Tenant scoping seam. Denormalized from the parent fact for direct querying without a join. |
| `entityType` | TEXT NOT NULL | Denormalized for direct querying without a join. |
| `entityId` | TEXT NOT NULL | |
| `key` | TEXT NOT NULL | |
| `value` | TEXT NOT NULL | The value at the time of archiving (the old value, before it was changed). |
| `confidence` | REAL NOT NULL | Confidence at the time of archiving. |
| `source` | TEXT NOT NULL | Source at the time of archiving. |
| `surface` | TEXT | Surface at the time of archiving. |
| `sessionId` | UUID | |
| `agentId` | UUID | |
| `metadata` | JSONB | |
| `stabilityScore` | REAL NOT NULL | |
| `accessCount` | INTEGER NOT NULL | |
| `archivedAt` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | When this snapshot was taken. |
| `archivedReason` | TEXT NOT NULL | `'superseded'` (overwritten by new value) or `'archived_by_user'` (manually archived). |

**Indexes:**
- `(factId, archivedAt DESC)` — get full history of a specific fact
- `(tenantId, entityType, entityId, key, archivedAt DESC)` — get history of a fact by entity+key (without needing factId); tenantId-scoped for Phase 5 isolation

**History query pattern:**
```sql
-- Full history of a specific fact:
SELECT * FROM fact_archive WHERE fact_id = '<uuid>' ORDER BY archived_at DESC;

-- Most recent previous value for an entity+key:
SELECT * FROM fact_archive
WHERE entity_type = 'user' AND entity_id = 'alice' AND key = 'timezone'
ORDER BY archived_at DESC LIMIT 1;
```

---

## Key design decisions

### Why Drizzle over Prisma

Prisma uses a Rust binary proxy (Query Engine) that sits between your application and the database. This adds latency and memory overhead. Drizzle is a TypeScript-only query builder that talks directly to the database driver. Better performance, no binary proxy to manage.

Drizzle also produces better SQL for complex queries (recursive CTEs, lateral joins, custom aggregate functions) that we will need in Phase 2+ for graph traversal and hybrid search. Prisma wraps these behind raw SQL escape hatches that lose type safety.

### Why postgres.js over pg (node-postgres)

`postgres.js` is faster in benchmarks, has a cleaner tagged-template API, and has first-class TypeScript support. `pg` is older and has more quirks around connection handling.

### Why a separate `fact_archive` table rather than a soft-delete column

The `isArchived` boolean approach loses old values permanently. If you overwrite `user/alice/timezone` from `UTC+1` to `UTC+2`, there is no record that it was ever `UTC+1`. The separate archive table preserves the full history of every value change, which is what "tracing a fact through time" requires. It also lets the future archivist daemon store richer metadata (decay reason, conflict resolution outcome, etc.) without polluting the active facts table.

### Why `tenantId` exists from Phase 0 as a seam

Phase 5 adds multi-tenancy. Without a `tenantId` column, Phase 5 requires a migration that adds the column to a potentially large `facts` table and rewrites the unique constraint — both expensive operations under load.

By adding `tenantId TEXT NOT NULL DEFAULT 'default'` to `facts`, `fact_archive`, and `rules` from Phase 0, and including it in the unique constraint from day one, Phase 5 becomes a populate-and-reassign operation: existing rows get `tenantId = 'default'`, new tenants get their own IDs. No structural migration required.

Cost in Phase 0: one extra TEXT column per row with a static default. That is essentially free.

### Why facts are never hard-deleted

A hard delete is irreversible. `isArchived = true` is permanent in Phase 0, but the data survives in `fact_archive`. In Phase 5 when we add user data deletion (GDPR), we can implement a proper deletion flow that purges both tables. Until then, no data is ever lost.

### Why `stabilityScore`, `accessCount`, `lastAccessedAt`, and `confidence` exist from Phase 0

Phase 4 (memory decay + Hebbian reinforcement) needs historical access data to function. If we added these columns in Phase 4, the archivist would have zero signal for any facts written before Phase 4 shipped. By adding them in Phase 0 and populating them on every read from the start, Phase 4 has complete data from day one.

### Why `surface` is on facts from Phase 0

The core value proposition of iranti is cross-platform memory. Every fact should carry provenance: which host wrote it. Without `surface`, you cannot answer "what did Claude know that ChatGPT didn't?" or filter out stale facts from a host you no longer use. Adding `surface` later means a migration on a potentially large table and incomplete provenance for historical facts.

### Why `isProtected` is on facts from Phase 0

User-defined rules (preferences, constraints on agent behavior) should not be overwritable by agents. A protected fact can only be changed by an admin operation. This is one boolean column that is free to add now and expensive to retrofit when the `facts` table has millions of rows.

---

## Lessons from iranti v0 (main branch)

The original iranti grew organically over time. Reading it is like reading the result of months of production learning. These are the patterns we are intentionally preserving and those we are deferring.

### What we kept

| Pattern | Why |
|---------|-----|
| `(entityType, entityId, key)` unique constraint | One active value per key per entity. Clean upsert target. |
| Separate archive table with reason codes | History without polluting the live table. |
| `stabilityScore` starting at a base, incremented on access | Hebbian reinforcement. Old iranti default was 30 (days), we use 1.0 (normalized). |
| `surface` enum on facts | Every fact has a host origin. |
| `isProtected` flag | User rules and preferences cannot be overwritten. |
| Agent registration before writes | Every write is attributable to a named agent. |
| Ebbinghaus formula for decay | `confidence × e^(-(days / stability))`. Proven model from cognitive science. |
| Source reliability seeding stability | Facts from trusted sources start with higher stability. |

### What we deferred (and which phase picks it up)

| Feature | Phase | Reason for deferral |
|---------|-------|---------------------|
| `EntityAlias` | Phase 3 | Requires cross-platform identity resolution logic. Too complex for Phase 0. |
| `EntityRelationship` | Phase 2 | Graph traversal requires Cypher/recursive CTE plumbing not needed until intelligence layer. |
| `WriteReceipt` | Phase 2 | Idempotency for distributed writes. Not needed until concurrent agent scenarios. |
| `validFrom` / `validUntil` | Phase 2 | Temporal queries add complexity to every read. Defer until conflict detection exists. |
| `conflictLog` (JSON on facts) | Phase 2 | Conflict detection is Phase 2. An empty log from Phase 0 would be misleading. |
| Embeddings / pgvector | Phase 3 | Requires an embedding provider and a vector index. Too much infrastructure for Phase 0. |
| `User` / `Token` auth | Phase 5 | Single-user until we know there is a multi-user product to build. |
| `StaffEvent` audit log | Phase 2 | Full event sourcing is powerful but expensive. Start simple. |
| `valueRaw` (JSON) + `valueSummary` (text) | Phase 2 | Two-field value storage is richer but adds complexity. Single text field is sufficient for Phase 0. |
| Semantic fact tags | Phase 3 | Requires LLM call at write time. Out of scope for Phase 0. |

### What we improved over v0

| v0 pattern | iranti-core approach | Why |
|------------|---------------------|-----|
| `confidence` as Int 0–100 | `confidence` as Real 0.0–1.0 | Normalized floats compose better with the Ebbinghaus formula. v0 had a mismatch between the 0-100 storage and the 0-1 decay math. |
| Prisma | Drizzle + postgres.js | No binary proxy, better complex SQL, better performance. |
| Integer PKs | UUID PKs | No sequential enumeration vulnerability. Safe across distributed nodes. |
| Single monolithic archive table | `fact_archive` (simple, Phase 0) + richer archive (Phase 2) | Start simple, add complexity when it's earned. |
| No `tenantId` until multi-user migration | `tenantId TEXT NOT NULL DEFAULT 'default'` from Phase 0 | Eliminates a breaking structural migration when Phase 5 ships. The column and unique constraint are in place; Phase 5 just populates non-default values. |
| No surface validation (application accepted any string) | `VALID_SURFACES` constant + `assertValidSurface()` in `facts.ts` | The `surface` column only contains known AI host values. Prevents silent data drift as new hosts are added — unknown surfaces fail loudly. |
| One timestamp (`lastAccessedAt`) tracking all mutations | `updatedAt` (writes) + `lastAccessedAt` (reads) | Two distinct signals. `updatedAt` answers "when was this fact last written?" `lastAccessedAt` answers "when was this fact last read?" Phase 4 decay uses `lastAccessedAt`. Auditing uses `updatedAt`. |

---

## Current status

**Phase 0 is complete and committed** (`7fadef5` — 29 files, 4740 insertions). Phase 1 (MCP server) is next.

| Item | Status |
|------|--------|
| Schema written | ✅ `src/db/schema.ts` (6 tables) |
| DB connection | ✅ `src/db/connection.ts` |
| Library CRUD | ✅ agents.ts, sessions.ts, entities.ts, facts.ts, rules.ts |
| `fact_archive` support in facts.ts | ✅ writeFact and archiveFact both snapshot to archive |
| `src/db/migrate.ts` script | ✅ Node.js migrator (drizzle-kit migrate was silently failing on Windows) |
| Migration 0000 — base tables | ✅ `drizzle/0000_legal_ultimates.sql` applied |
| Migration 0001 — rules table | ✅ `drizzle/0001_next_black_bolt.sql` applied |
| Migration 0002 — tenantId seam + updatedAt | ✅ `drizzle/0002_exotic_doctor_doom.sql` applied |
| tenantId on facts, fact_archive, rules | ✅ `DEFAULT 'default'`, included in unique constraint |
| updatedAt on facts | ✅ Distinct from lastAccessedAt |
| Surface validation | ✅ `VALID_SURFACES` + `assertValidSurface()` in facts.ts |
| All 6 tables live | ✅ iranti_dev on localhost:5435 |
| Integration tests | ✅ 46/46 passing (5 test files) |
| CI PostgreSQL service | ✅ `.github/workflows/ci.yml` with `services: postgres:17-alpine` |
| Implementation reference doc | ✅ This file |
| Phase 0 committed | ✅ commit `7fadef5` on `iranti-core` |

**Docker note:** iranti-core uses port 5435 (not 5432) because the host machine has native PostgreSQL processes on both 5432 and 5433. The `docker-compose.yml` maps `5435:5432`. The `.env` DATABASE_URL uses port 5435.

---

## Pending decisions

These items require a decision before the relevant phase begins. They are listed here so they are not forgotten.

| Decision | Phase | Options | Current lean |
|----------|-------|---------|--------------|
| Embedding model and dimensions | Phase 3 | OpenAI text-embedding-3-small (1536d), or local model (256d) | OpenAI for now, switch if cost is an issue |
| pgvector vs Qdrant vs Chroma | Phase 3 | All three existed in v0. pgvector is simplest (same DB). | pgvector — fewer moving parts |
| Graph: recursive CTE vs Apache AGE | Phase 2 | Recursive CTE is pure SQL, no extension. AGE is Cypher but adds an extension dep. | Recursive CTE for Phase 2, revisit if query complexity grows |
| MCP transport | Phase 1 | stdio (local) or HTTP+SSE (remote) | stdio for Phase 1, HTTP for Phase 5 |
| Surface enum: string vs PostgreSQL enum type | Phase 0 ✅ | PostgreSQL enum is type-safe but hard to extend; text column is flexible | TEXT with application-level validation via `VALID_SURFACES` constant + `assertValidSurface()` in `facts.ts`. No Zod dependency needed. |
