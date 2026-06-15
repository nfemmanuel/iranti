# iranti-core Implementation Reference

> **This document is the living retrospective: the record of every implementation decision actually made in iranti-core, and why.**
> It must be consulted before writing, changing, or reviewing any code, and updated whenever a decision changes.
> It exists to prevent knowledge drift across long sessions, context windows, and contributor handoffs.
>
> **It is one of four planning documents** — see the [backlog](../backlog.md) for how they fit together. In short: the [master PRD](../rough-notes/iranti-core-prd.md) holds the vision, the [phase PRDs](../prds/phases/) are the contract for each phase (written before build), the [backlog](../backlog.md) is the forward queue, and this file is the past-tense record of what shipped. Forward planning lives in the backlog and PRDs; this file documents what is built.
>
> **Phase numbering:** this file uses the executed scheme (0, 1, 1.1, 1.2, 2, …). It differs from the master PRD §12 scheme; the [backlog](../backlog.md#phase-numbering--reconciled) holds the authoritative mapping.

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
│                  MCP Server (Phase 1–1.2)                    │
│  attend  write  write_rule  archive  search  checkpoint      │
│  history  query  write_issue            (9 tools, stdio)     │
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

**Status:** ✅ Built and verified. 89/89 tests passing plus an end-to-end stdio smoke test (`scripts/smoke-mcp.mjs`).

**Deliverables (as built):**
- MCP server process (`src/mcp/server.ts`) — stdio transport, `@modelcontextprotocol/sdk`
- Tools: `iranti_attend`, `iranti_write`, `iranti_write_rule`, `iranti_archive`
- Deterministic extraction (`src/mcp/extractor.ts`) — see below
- Checkpoints (`src/library/checkpoints.ts`) — see below
- Agent handshake (auto-register + open session on first tool call, first-call-wins)
- Best-effort session cleanup on SIGINT/SIGTERM — hosts usually kill the process, so leaked sessions are expected and detectable via `getOpenSessions()`

**Key decision — `iranti_attend` is bidirectional.** v0's biggest failure mode was that storing was a separate step (`iranti_write`) the agent had to remember — and agents forget. Phase 1's attend both writes and reads in one call: it extracts structured artifacts (URLs, file paths) from the incoming message and stores them as facts, then returns rules + recent facts + the active checkpoint. Extraction is server-side so every host gets identical behavior.

**Extraction design (learned from v0's auto-capture noise):**
- Conservative: regex-only — URLs and file paths. Semantic extraction (decisions, preferences) waits for the Phase 2 intelligence layer. Wrong facts are worse than missing facts.
- Collision-safe keys: `shared_url:<12-hex content hash>` — a static key like `shared_url` would make every new URL overwrite the previous one (facts upsert on entity+key).
- Deduped within message, capped at 10 artifacts per attend call.
- Tagged with `source = "iranti_attend_extract"` so noisy extracts are bulk-cleanable.

**Attend response is bounded:** at most 10 facts per entity hint, 20 total, ordered by `updatedAt DESC` (via `readRecentFactsByEntity`, which access-tracks only the rows it returns). "Return everything" stops scaling within weeks — the cap is the contract.

**Checkpoints (Phase 1 implementation):** a checkpoint is a fact with the reserved key `checkpoint`. Zero schema changes; inherits history, tenancy, and provenance from facts. One checkpoint per entity (upsert semantics); `getActiveCheckpoint(hints)` returns the most recently written across the entities in scope, and attend returns it separately from regular facts. Checkpoint facts are exempt from Phase 4 decay by convention — the archivist must skip `key = 'checkpoint'`. A dedicated table with richer structure is a Phase 2 candidate.

**Key decision — single-instance for Phase 1:** The MCP server is stateless in that all durable state lives in PostgreSQL. However, Phase 1 is designed for a **single MCP server instance** (one process, one user). Concurrent writes from multiple simultaneous instances are not prevented by Phase 1 code. Multi-instance concurrency (advisory locks, write serialization) is deferred to Phase 2. Do not run two Phase 1 servers against the same database expecting safe concurrent writes.

**Dropped from the original sketch:** `iranti_search` (semantic search is Phase 3 — exact-match retrieval via attend covers Phase 1) and "attend before write" protocol enforcement (hosts can't be forced to order calls; instruction files per host handle this — see `hosts.md`).

**Host integration:** see `docs/engineering/hosts.md` for per-host profiles, the capability matrix, and the recommended rollout order. Headline: 8 of 15 surfaces work with Phase 1 stdio alone (all developer tools); every consumer surface (claude.ai, mobile, ChatGPT, Gemini app) needs hosted HTTP transport — consider pulling single-user HTTP forward from Phase 5 to ~Phase 2.x (after write serialization).

---

### Phase 1.1 — Tool Realignment

**Goal:** bring the tool surface up to what real use needs and start correcting attend's retrieval ordering.

**Status:** ✅ Shipped. 104/104 tests + 16/16 stdio smoke checks. PRD: `docs/prds/phases/phase-1.1-tool-realignment.md`.

**What changed — tool surface 4 → 9.** Added `iranti_search` (full-text ILIKE over key+value, optionally entity-scoped — reinstating what Phase 1 deferred), `iranti_checkpoint` (dedicated checkpoint tool with a description that tells the agent what to record), `iranti_history` (full change history of a fact via `fact_archive`), `iranti_query` (exact entity+key lookup, access-tracked), and `iranti_write_issue` (structured issues/todos as JSON facts, key `issue:<slug>` from the title, upsert by title). Kept the original four.

**The load-bearing change — retrieval moved from recency to relevance.** Phase 1 ordered facts by `updatedAt DESC`. Phase 1.1 introduced `readRelevantFactsByEntity`: tokenize the message (stop-word filter, min 3 chars), score each fact by keyword overlap (key match 2×, value 1×), pull a 3×-limit candidate pool (max 50), rank by score then recency, access-track only returned rows. A subtle bug was caught: attend re-sorted the merged facts by recency *after* the library ranked them, undoing the ranking — the merge sort is now conditional (no-op when a message is present, recency when absent). **Known limitation:** with multiple entity hints + a message, facts order by hint order, not cross-entity relevance — deferred to Phase 3 (embeddings). This is the first rung of the relevance ladder: entity scope → **keyword** → vector.

**No schema change.** Tool surface only; attend internally swapped `readRecentFactsByEntity` → `readRelevantFactsByEntity`.

---

### Phase 1.2 — Context Window Observation

**Goal:** stop re-injecting what the agent can already see. First slice of master PRD §8.

**Status:** ✅ Shipped. 109/109 tests + 17/17 stdio smoke checks. PRD: `docs/prds/phases/phase-1.2-context-window-observation.md`.

**What changed.** `iranti_attend` gained an optional `currentContext` parameter (the agent's visible window). When present, facts whose value already appears in the window are suppressed **before** the `MAX_TOTAL_FACTS` cap — so the injected budget fills with facts the agent does not already hold — and the response reports an `alreadyPresent` count for token-saving measurement. Presence is a normalized-substring check with an 8-char floor (short values would false-positive) and a 160-char probe (long values still match a verbatim copy). The active checkpoint and all rules are exempt from suppression. Backward compatible: no `currentContext` → Phase 1.1 behaviour exactly.

**Scope boundary.** Phase 1.2 only *suppresses* already-present facts. Detecting and *correcting* stale values in the window (§8's correction case) needs staleness reasoning that doesn't exist yet → Phase 3 (CORE-17). This was the first feature built under the PRD-first process.

---

### Phase 2a — Graph Foundation & Write Safety

**Goal:** graph substrate for learned relevance + serialized writes to close the concurrent-snapshot race.

**Status:** ✅ Shipped. 125/125 tests + 19/19 stdio smoke checks. PRD: `docs/prds/phases/phase-2a-graph-and-write-safety.md`. CORE-5/6/7/8.

**What changed.**

*Write safety (CORE-5):* `writeFact` opens every transaction with `SELECT pg_advisory_xact_lock(hashtext('tenant/type/id/key')::bigint)`. The `::bigint` cast avoids PostgreSQL's ambiguity between the single-bigint and two-int overloads. Concurrent writes to the same `(tenant, entity, key)` are serialized: the second writer reads the first writer's committed value before snapshotting it, so `fact_archive` never contains two snapshots of the same value for the same transition.

*`knowledge_edges` table (CORE-6):* A new table with columns `source_type`, `source_id`, `target_type`, `target_id`, `relation`, `weight` (real), `co_access_count` (int), and a six-column unique constraint (`tenant_id`, `source_type`, `source_id`, `target_type`, `target_id`, `relation`). Two indexes: one on (source_type, source_id) and one on (target_type, target_id). Migration: `drizzle/0003_slimy_donald_blake.sql`.

*`GraphBackend` interface + `PostgresGraphBackend` (CORE-6):* `src/graph/index.ts` exports the interface and a singleton `graph` instance. Four methods: `addEdge` (insert-or-upsert), `reinforceEdge` (strengthen or create), `getNeighbors` (depth-1 flat query or recursive CTE for depth>1), `getEdge` (exact lookup). All methods use Drizzle's standard query builder except `getNeighbors` which uses `db.execute(sql\`...\`)` for the compound OR condition — Drizzle's relational and standard query builders silently drop `or()` with nested `and()` in some combinations.

*Co-access edges (CORE-7):* `attend` records `co_access` edges among all returned facts after assembling the response — fire-and-forget (`void recordAttendEdges(...).catch(...)`), never on the response path. Guard: `returnedFacts.length >= 2 || rules.length > 0`. All-pairs among returned facts → `co_access` edges. `co_access` pairs are canonically ordered by `"type/id"` string so (A,B) and (B,A) always collapse to the same row.

*Governs edges (CORE-8):* `recordAttendEdges` also creates directed `governs` edges from every active rule to every returned fact. These are directional (rule→fact, not canonicalized). Groundwork for graph-proximity rule triggering in Phase 3.

**Key decisions.**

| Decision | Choice | Why |
|---|---|---|
| Advisory lock scope | Per `(tenant, entity_type, entity_id, key)` — not per entity | Narrowest lock that prevents duplicate archive snapshots. Different keys on the same entity don't serialize. |
| `hashtext(key)::bigint` | Explicit `::bigint` cast | Without cast, PostgreSQL sees two overloads (`bigint` and `(int, int)`) and may choose the wrong one. |
| Canonical pair ordering | Lexicographic on `"type/id"` string | Deterministic, language-agnostic, works across entity types. |
| `getNeighbors` raw SQL | `db.execute(sql\`...\`)` | Drizzle's OR+AND compound conditions were silently dropped by both the relational and standard query builders in this version (0.45.2). Raw SQL is the reliable path. |
| `governs` edges fire for single-fact attend | Yes, when `rules.length > 0` | A rule that fired alongside a fact governs that fact regardless of how many other facts were returned. The co_access guard (≥2 facts) is separate from the governs guard (rules.length > 0). |

---

### Phase 2b — The Librarian

**Goal:** judgment on the write path — iranti stops taking every fact at face value.

**Status:** ✅ Shipped. 158/158 tests + 21/21 stdio smoke checks. PRD: `docs/prds/phases/phase-2b-librarian.md`. CORE-9/10/11.

**What changed.**

*Schema (migration 0004):* Two new tables: `source_reliability(source PK, wins, losses, score, updated_at)` and `escalations(id, tenant_id, entity_type, entity_id, key, existing_fact_id, existing_value, new_value, existing_source, new_source, reason, status, created_at)`.

*Source reliability (CORE-10, `src/library/source-reliability.ts`):* `score = wins / (wins + losses)`, initialised at 0.5 (neutral). `recordOutcome(winner, loser)` does two parallel upserts after each supersession. Default score for unknown sources: 0.5. `ESCALATION_THRESHOLD = 0.2`: the existing source must exceed the new source by more than 0.2 before a write is blocked.

*Conflict detection (CORE-9, `src/library/conflicts.ts`):* Two layers:
- **Minimal (same-key)** — runs synchronously inside `writeFact`'s transaction. When a value is changing, `checkConflict` compares source reliability scores. Gap > 0.2 → `"escalate"`: block the write, create an escalation record + markdown file in `iranti-escalations/`, return the existing fact unchanged. Gap ≤ 0.2 → `"supersede"`: continue to archive + upsert, call `recordSupersession` (best-effort async, updates reliability scores).
- **Deep (cross-key)** — runs fire-and-forget after the upsert, never blocks. `runDeepConflictCheck` applies six negation-pattern regexes (`/\bnot\s+(?:use|using)\s+(\w+)/i`, etc.) to extract a negated term, then scans other facts for the same entity. Each candidate contradiction increments `comprehensionMetrics.deepConflictsDetected` and logs a warning. **Never auto-resolves** — this is a metric, not a resolution pass.
- `comprehensionMetrics` export: in-process counters (`minimalConflictsChecked`, `supersessions`, `escalations`, `deepConflictsDetected`). Phase 2.5 wires these into the `attend_log` health views.

*Semantic extraction (CORE-11, `src/extract/index.ts`):* `ExtractorBackend` interface with two implementations:
- `HeuristicExtractor` — always-on, deterministic. 5 decision patterns (`"decided to use"`, `"we chose"`, `"decision:"`, `"going with"`, `"we're using/adopting"`) → key `decision:<slug>`. 4 preference patterns (`"I prefer"`, `"always use/want/do"`, `"never use/do"`, `"I want you to always"`) → key `preference:<slug>`. Confidence: 0.85. Deduplicates on key.
- `LocalLlmExtractor` — optional, config-gated (`IRANTI_EXTRACTOR=local`). Calls `${IRANTI_LLM_ENDPOINT}/chat/completions` (default Ollama at `localhost:11434`) with 8s timeout via `AbortSignal.timeout(8000)`. Merges with heuristic results, heuristic wins on key collision. Degrades gracefully to heuristic-only on any error. Confidence: 0.80.
- `extractor` singleton selected by `IRANTI_EXTRACTOR` env. Default: `heuristic`.

*Integration into attend (`src/mcp/tools/attend.ts`):* `extractAndStore` helper runs fire-and-forget after the response is assembled. Calls `extractor.extract(message)`, upserts the primary entity if any facts are extracted, writes each fact via `writeFact`. Facts surface on the **next** `attend` (async; never blocks this response). The `iranti_attend` test for MCP consumers passes this silently.

**Key decisions.**

| Decision | Choice | Why |
|---|---|---|
| LLM proposes facts, never adjudicates (D3) | Conflict resolution is purely deterministic | Keeps every outcome explainable and reproducible from the `source_reliability` table alone. |
| Deep conflict detection is a metric, not resolution | Increments counter, logs, never auto-resolves | "If iranti can reliably detect contradictions, that is evidence it comprehends its content" — this metric becomes a product KPI in Phase 2.5. |
| Escalation threshold 0.2 | Existing source must be meaningfully more trusted | Prevents a marginally-better-known source from blocking all updates. Equal or similar sources → supersede (today's behaviour). |
| `checkConflict` runs inside the transaction | Consistency: reliability check + write are atomic | Prevents TOCTOU: reading the score outside the transaction could see a stale value if another write races. |
| `createEscalation` writes markdown to `iranti-escalations/` | Human-readable audit trail alongside the DB record | Phase 4's `iranti resolve` CLI reads these files; they survive database migrations and are easy to inspect without a query tool. |
| `runDeepConflictCheck` is fire-and-forget | Never blocks writes | Deep check is inherently best-effort (heuristic). Latency on the hot path is non-negotiable. |
| `EDGE_SETTLE_MS = 400ms` in `graph.test.ts` | Increased from 150ms | Phase 2b adds `conflicts.test.ts` + `semantic-extract.test.ts` which saturate the pool under parallel test load. 150ms was enough in isolation; 400ms is enough under concurrent load. |

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

**Phases 0 through 2a are complete and verified.** Phase 0 (`7fadef5`, supplements `3321c8c`) — library foundation. Phase 1 (`b506a38`) — MCP server, bidirectional attend, checkpoints. Phase 1.1 — tool surface 4→9 and keyword-relevance retrieval. Phase 1.2 — context window observation (`currentContext` suppression). Phase 2a — graph substrate (`knowledge_edges`), write serialization (advisory lock), co-access + governs edge recording in attend. Current totals: **125/125 vitest tests + 19/19 end-to-end stdio smoke checks.** Forward work is tracked in the [backlog](../backlog.md); host integration profiles live in `docs/engineering/hosts.md`.

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
| `knowledge_edges` table | ✅ `src/db/schema.ts`, migration `0003_slimy_donald_blake.sql` |
| `GraphBackend` interface | ✅ `src/graph/index.ts` — addEdge, reinforceEdge, getNeighbors, getEdge |
| Advisory lock in writeFact | ✅ `pg_advisory_xact_lock(hashtext(key)::bigint)` at transaction start |
| Co-access edge recording | ✅ fire-and-forget in attend, all-pairs among returned facts |
| Governs edge recording | ✅ rule→fact directed edges when rule+fact co-fire in attend |
| Phase 2a test suite | ✅ 125/125 (16 graph tests + 109 prior tests) |
| Phase 2a smoke test | ✅ 19/19 checks (checks 14+15 added for 2a) |

**Docker note:** iranti-core uses port 5435 (not 5432) because the host machine has native PostgreSQL processes on both 5432 and 5433. The `docker-compose.yml` maps `5435:5432`. The `.env` DATABASE_URL uses port 5435.

---

## ⚠️ Documentation debt (flagged 2026-06-12)

This file fell behind after Phase 2a. The records below are **NOT yet backfilled** —
listed so the gap is explicit rather than silently missing. Each must be written from the
**actual code** (commit history + `src/`), not from memory, before it is trusted:

- [ ] **Phase 2b — The Librarian** (conflict detection, source reliability, semantic extraction). Shipped; record TODO.
- [ ] **Phase 2.5 — HTTP + telemetry** (CORE-12/13/14/27/28/29). Shipped; record TODO.
- [ ] **Phase 3 — The Attendant** (CORE-15/16/17/30/31/32/33/34). Shipped; record TODO.

Until backfilled, treat the [phase PRDs](../prds/phases/) + commit history as the source of
truth for 2b/2.5/3, and the [decision register](../decisions/open-decisions.md) for open decisions.

---

## Session 2026-06-12 — audit, extraction research, decision register

Code-verified record of this session's work (all verifiable in the working tree):

**Phase 3 review fixes (working tree, uncommitted):**
- CI image `postgres:17-alpine` → `pgvector/pgvector:pg17` (`.github/workflows/ci.yml`) — migration 0010 needs the `vector` extension.
- Removed the dead drift-heartbeat apparatus from `src/mcp/tools/attend.ts` (`DRIFT_DEFAULT`, `getDriftN`, module-global `turnCount`, `isDriftTurn`); stale-context corrections now require `currentContext`.
- `incrementTurnCount` made fire-and-forget so a DB error can't abort metric persistence.
- `readArchivedValuesByFactIds` (`src/library/facts.ts`) given deterministic `ORDER BY archived_at DESC, id DESC`.
- Fixed 16 pre-existing ESLint errors the broken CI image had masked — CI is now typecheck + lint green.
- Collapsed 4 budget-filter passes into one `fitsBudget` helper; extracted `extractSingleCapture` in `src/extract/index.ts`.

**Master PRD reword:** §2 agnosticism line → *behavior-agnostic / invocation-tiered* (`docs/rough-notes/iranti-core-prd.md`).

**Diagnostic scripts added (`scripts/`, not part of the build):**
- `extraction-eval.mts` — heuristic extractor over real Claude+Codex transcripts.
- `extraction-compare.mts` — heuristic vs LLM (old chunker prompt) A/B.
- `extraction-local-eval.mts` — local Ollama (qwen2.5:7b) quality test.
- `mock-extract-eval.mts` — old `iranti@0.4.1` mock extractor over real transcripts.
- `overhead-report.mts` — `attend_log` injection-token distribution.

**Measured findings (same 50-msg real sample; see register OD-2 + AX-*):**
- iranti-core regex heuristic: **0 facts**.
- old `iranti@0.4.1` mock extractor: **0 facts** (it's a benchmark stub — 9 fixture-specific patterns).
- LLM (Haiku, old chunker prompt): 3–13 facts/msg, clean exact-lookup slots.
- local `qwen2.5:7b` (schema-constrained, temp 0, seed): 133 facts / 50 msgs, ~50% precision, confidence pinned to 1.0 (broken), ~24 s/msg.
- **Conclusion:** deterministic pattern extraction does not generalize to real language; the LLM is required for recall; store-side guardrails (AX-1 normalizeKey, AX-4 grounding, AX-7 transient-durable, AX-6 golden-corpus) are what buy precision. Determinism lives downstream, never in extraction.

**Environment:** Ollama 0.30.6 installed (winget); `qwen2.5:7b` pulled. The MCP server serving this session is the **old published `iranti@0.4.1`** (global npm → `localhost:3500`), NOT this repo.

**Process instituted:** the [decision register](../decisions/open-decisions.md) — open decisions OD-1..4 + augmentation experiments AX-1..8, each gated on a proven-improvement test.

---

## Pending decisions

> **Superseded:** open decisions now live in the [decision register](../decisions/open-decisions.md).
> The table below is retained as historical record; new decisions go in the register.

These items require a decision before the relevant phase begins. They are listed here so they are not forgotten.

| Decision | Phase | Options | Current lean |
|----------|-------|---------|--------------|
| Embedding model and dimensions | Phase 3 | OpenAI text-embedding-3-small (1536d), or local model (256d) | OpenAI for now, switch if cost is an issue |
| pgvector vs Qdrant vs Chroma | Phase 3 | All three existed in v0. pgvector is simplest (same DB). | pgvector — fewer moving parts |
| Graph: recursive CTE vs Apache AGE | Phase 2 | Recursive CTE is pure SQL, no extension. AGE is Cypher but adds an extension dep. | Recursive CTE for Phase 2, revisit if query complexity grows |
| MCP transport | Phase 1 | stdio (local) or HTTP+SSE (remote) | stdio for Phase 1, HTTP for Phase 5 |
| Surface enum: string vs PostgreSQL enum type | Phase 0 ✅ | PostgreSQL enum is type-safe but hard to extend; text column is flexible | TEXT with application-level validation via `VALID_SURFACES` constant + `assertValidSurface()` in `facts.ts`. No Zod dependency needed. |
