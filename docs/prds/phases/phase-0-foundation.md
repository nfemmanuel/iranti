# PRD: Phase 0 — Library Foundation

**Status:** shipped (retroactive)
**Phase:** 0 · **Date:** 2026-06-10 (authored) · **Author:** Claude (retroactive, from implementation record)
**Related:** master PRD §12 (Phase 0: Foundation), §7 (memory primitives & data model), [implementation.md](../../engineering/implementation.md)

---

> **Retroactive PRD.** Phase 0 shipped before the PRD-first process existed (instituted June 2026). This document is reconstructed from the implementation record — `implementation.md`, `src/db/schema.ts`, and commits `7fadef5` (+ supplements `3321c8c`) — so the project history is complete and auditable. It describes what was built, not a forward plan.

## 1. Summary

Phase 0 delivers iranti-core's data layer: a PostgreSQL schema of six tables (`agents`, `sessions`, `entities`, `facts`, `fact_archive`, `rules`), Drizzle migrations `0000`–`0002`, and a typed CRUD library (`agents.ts`, `sessions.ts`, `entities.ts`, `facts.ts`, `rules.ts`) that can store a fact, read it back, archive it, and query by entity and by session against a running database. There is no intelligence, no HTTP server, and no MCP surface in this phase — just a layer that stores and retrieves reliably, with full value history preserved in an append-only archive and the columns Phase 4's decay model will need populated from the very first write. It shipped with Docker Compose for local development, 46 integration tests, and CI running against a Postgres service. This is the foundation every later phase calls into.

## 2. Problem & motivation

Master PRD §1 names the root problem iranti exists to solve: AI agents have no reliable external store of what has happened, so context is ephemeral and its degradation is invisible until it causes damage. Every feature in the master PRD — the Attendant's retrieval, the Librarian's write path, the Archivist's decay, the knowledge graph — assumes a durable, queryable store underneath it. None of that can be built, or even tested against real behaviour, until that store exists and is correct.

Master PRD §12 makes this explicit: *"Everything else blocks on this. Get it right before writing anything else… Nothing else starts until Phase 0 is complete and reviewable."* The motivation for Phase 0 is therefore not a user-facing feature but the precondition for all of them — a data layer solid enough that the intelligence layers above it never have to question whether a fact was stored, whether its history survived, or whether the provenance is attributable.

A second, equally important driver comes from the rebuild rationale (master PRD §0): iranti v0 was vibecoded and its internals were not fully understood. Phase 0 is the chance to lay the schema down deliberately, with every decision recorded, so the founder and future hires can reason about it without archaeology.

## 3. Goals & non-goals

**Goals**
- A PostgreSQL schema covering the Phase 0 memory primitives: agents, sessions, entities, facts, a fact archive, and rules.
- A typed CRUD library over that schema: register agents, open/close sessions, upsert entities, write/read/archive facts, write/read rules.
- Full value history: every fact value change is preserved, never lost.
- The decay/provenance columns Phase 4 and Phase 3 depend on (`stabilityScore`, `accessCount`, `lastAccessedAt`, `confidence`, `surface`) present and populated from the first write, so later phases inherit historical signal rather than starting blind.
- Forward seams for Phase 5 tenancy that cost nothing now and avoid a breaking migration later.
- Reproducible local setup (Docker Compose) and a green CI run against a real Postgres.

**Non-goals**
- **No MCP server, no HTTP API.** The transport layer is Phase 1.
- **No intelligence.** No conflict detection, no resolution, no write routing, no relevance filtering. The library stores what it is told and returns what it is asked for.
- **No semantic search or embeddings.** Retrieval is exact-match and entity-scoped. pgvector is Phase 3.
- **No decay calculations.** The columns that feed decay exist and are populated, but no decay math runs. The Ebbinghaus curve and Hebbian reinforcement are Phase 4.
- **No multi-user auth or row-level security.** Single-user throughout. The `tenantId` seam is present but every row is `'default'`. Auth is Phase 5.
- **No entity aliases, relationships, or graph.** Aliases are Phase 3; relationships and the graph are Phase 2.

## 4. Scope

**In**
- Schema (`src/db/schema.ts`): six tables — `agents`, `sessions`, `entities`, `facts`, `fact_archive`, `rules` — as the single source of truth for structure and inferred types.
- Drizzle migrations `0000` (base tables), `0001` (rules table), `0002` (tenantId seam + updatedAt), committed under `drizzle/` and applied to a live database.
- A Node.js migrator (`src/db/migrate.ts`) used in place of `drizzle-kit migrate`, which was silently failing on Windows.
- DB connection module (`src/db/connection.ts`) over postgres.js.
- CRUD library: `agents.ts` (get-or-create registration), `sessions.ts` (open/close, open-session detection), `entities.ts` (get-or-create upsert), `facts.ts` (write with upsert + archive snapshot, read with access tracking, archive), `rules.ts` (additive writes, entity-scoped reads).
- `fact_archive` integration: both `writeFact` (on supersede) and `archiveFact` (on manual archive) snapshot the prior value with a reason code.
- Surface validation: `VALID_SURFACES` constant + `assertValidSurface()` in `facts.ts`, applied at write time.
- Docker Compose for the local Postgres, mapped to host port 5435.
- 46 integration tests across 5 test files; CI workflow with a `postgres:17-alpine` service.

**Out (deferred)**
- MCP server, tools, bidirectional attend, checkpoints → **Phase 1**.
- Conflict detection/resolution, entity relationships, `WriteReceipt`, temporal validity (`validFrom`/`validUntil`), `conflictLog`, source reliability scoring → **Phase 2**.
- Embeddings/pgvector, hybrid + graph-bridged search, `EntityAlias`, surface-aware retrieval, semantic tags → **Phase 3**.
- Memory decay (Ebbinghaus), Hebbian reinforcement, the Archivist daemon → **Phase 4**.
- `users`/`tokens` tables, row-level security, identity merge, metering → **Phase 5**.

## 5. Design decisions & rationale

- **Drizzle over Prisma → why:** Prisma ships a Rust binary proxy (the Query Engine) that sits between the application and the database, adding latency and a binary to manage. Drizzle is a TypeScript-only query builder that talks to the driver directly. It also emits cleaner SQL for the recursive CTEs and lateral joins Phase 2+ graph traversal and Phase 3 hybrid search will need, where Prisma forces a raw-SQL escape hatch that loses type safety. *Alternative rejected:* Prisma — better DX for simple CRUD, but the proxy overhead and the complex-query ceiling do not fit where iranti is going.

- **postgres.js over pg (node-postgres) → why:** lower per-query overhead, a cleaner tagged-template API, and first-class TypeScript support. `pg` is older with more connection-handling quirks. *Alternative rejected:* `pg` — the incumbent, but no advantage here and more rough edges.

- **A separate `fact_archive` table over a soft-delete column → why:** an `isArchived` boolean alone loses old values permanently — overwriting `user/alice/timezone` from `UTC+1` to `UTC+2` would erase that it was ever `UTC+1`. "Tracing a fact through time" (master PRD §7 lifecycle) requires the full history of every value change, which only an append-only archive preserves. It also gives the future Archivist a place to record richer per-snapshot metadata (decay reason, conflict outcome) without polluting the live `facts` table. *Alternative rejected:* soft-delete flag only — cheaper, but throws away exactly the history the product is built to keep. (Note: `isArchived` still exists on `facts` as the active/inactive flag; the archive table is additive to it, not a replacement.)

- **`tenantId TEXT NOT NULL DEFAULT 'default'` as a Phase-5 seam, in the unique constraint from day one → why:** Phase 5 adds multi-tenancy. Without the column, Phase 5 must add it to a potentially large `facts` table *and* rewrite the unique constraint — both expensive under load, and the constraint rewrite is a breaking structural migration. By landing the column on `facts`, `fact_archive`, and `rules` now, and including it in `facts`'s unique key from the start, Phase 5 becomes populate-and-reassign: existing rows stay `'default'`, new tenants get real IDs, no structural migration. The cost today is one TEXT column with a static default — essentially free. *Alternative rejected:* add tenancy in Phase 5 — defers cost into exactly the moment (a live, populated, multi-user table) when it is most expensive and most risky.

- **Surface validation via `VALID_SURFACES` + `assertValidSurface()`, not a Postgres enum type → why:** the `surface` column must only ever hold known AI-host values (`claude`, `chatgpt`, `gemini`, `deepseek`, `dev_cli`, `web_ui`, `manual`); unknown surfaces should fail loudly rather than drift silently into the data, as they did in v0 (which accepted any string). A native Postgres enum is type-safe but painful to extend — adding a host means an `ALTER TYPE` migration. A TEXT column with an application-level allowlist gives the same loud-failure guarantee while staying trivially extensible, and needs no Zod dependency. *Alternative rejected:* Postgres enum type — type-safe at the DB layer but too rigid for a list that grows every time a new host is supported.

- **`updatedAt` (writes) distinct from `lastAccessedAt` (reads) → why:** v0 conflated all mutation into one `lastAccessedAt`, so it could not answer "when was this fact last *written*?" separately from "when was it last *read*?". These are two different signals: Phase 4 decay keys off read recency (`lastAccessedAt`), while auditing and "is this value stale?" key off write recency (`updatedAt`). `createdAt` is set once and never changes; `updatedAt` changes only on writes; `lastAccessedAt` changes only on reads. *Alternative rejected:* one timestamp for everything (v0) — cheaper but loses the read/write distinction both decay and audit need.

- **UUID primary keys over integer → why:** integer PKs are sequentially enumerable (an information-leak / scraping vector) and collide across distributed nodes. UUIDs (`gen_random_uuid()`) are safe to expose and safe to generate independently anywhere — important once writes can originate from multiple agents. A fact's UUID is also stable across upserts, so external references survive a value change. *Alternative rejected:* serial integers (v0) — simpler and smaller, but enumerable and not distribution-safe.

- **Decay columns present from Phase 0 (`stabilityScore`, `accessCount`, `lastAccessedAt`, `confidence`) → why:** Phase 4's decay and reinforcement need historical access data to function. If these columns were added in Phase 4, the Archivist would have zero signal for every fact written before Phase 4 shipped. Populating them on every read/write from day one means Phase 4 inherits months of real signal instead of starting cold. The same reasoning lands `surface` (cross-platform provenance) and `isProtected` (overwrite guard) early — both are one-column adds now and expensive retrofits against a large table later. *Alternative rejected:* add lifecycle columns when the lifecycle ships — clean in theory, but guarantees a blind cold start exactly when the feature most needs data.

- **Facts are never hard-deleted → why:** a hard delete is irreversible. In Phase 0, `isArchived = true` is permanent, but the data survives in `fact_archive` — nothing is ever lost (master PRD §7: *"The archive is permanent. Nothing is ever deleted."*). When Phase 5 adds GDPR fact-level deletion, it can purge both tables deliberately; until then the default is total preservation. *Alternative rejected:* allow hard delete now — simpler, but throws away recoverability the product's auditability principle (master PRD §2) depends on.

- **`confidence` as REAL 0.0–1.0, not Int 0–100 (v0) → why:** v0 stored confidence as an integer 0–100 but ran 0–1 decay math, a standing unit mismatch. Normalized floats compose directly with the Ebbinghaus formula `confidence × e^(-(days / stability))`. *Alternative rejected:* Int 0–100 — the v0 choice, retired because the storage and the math disagreed.

## 6. Schema / API changes

Six tables. All structure lives in `src/db/schema.ts`; Drizzle infers every TypeScript type from it.

| Table | Purpose | Identity |
|---|---|---|
| `agents` | Every writer of facts is a registered agent (a Claude Code session, a script, a job). UUID tagged on every fact written. | UUID PK; `registerAgent(name)` is get-or-create. |
| `sessions` | Groups one continuous interaction; facts are tagged with it for time-based queries. | UUID PK; FK → `agents`. Opened/closed explicitly; `getOpenSessions` detects crashes. |
| `entities` | The subject a fact is about — the namespace: `project/my-app`, `user/alice`, `system/global`. | Unique on `(entityType, entityId)`; `upsertEntity` is get-or-create. |
| `facts` | The core primitive: one piece of information about one entity. Upsert on the unique key; UUID stable across upserts. | **Unique on `(tenantId, entityType, entityId, key)`.** |
| `fact_archive` | Append-only history. Every supersede or manual archive snapshots the prior value with a reason code. Never updated, only inserted. | FK → `facts`; indexed by `(factId, archivedAt)` and `(tenantId, entityType, entityId, key, archivedAt)`. |
| `rules` | Behavioral imperatives in plain language, injected by attend (Phase 1). Additive (no unique constraint), priority-ordered, never decay. | Indexed by `(entityType, entityId, isActive)`. |

**Facts — the load-bearing constraint:** `unique("facts_tenant_entity_key_uniq").on(tenantId, entityType, entityId, key)`. One current value per key per entity per tenant. A write to an existing `(tenant, entity, key)` is an upsert: the old value is snapshotted to `fact_archive` with `archivedReason = 'superseded'`, then the row is updated in place — the UUID does not change. Including `tenantId` from day one is the Phase-5 seam (see §5).

**Facts — provenance is three distinct fields:** `source` (free-text label of *what* wrote it, unvalidated, e.g. `"claude-code-session"`), `surface` (validated host-platform enum via `assertValidSurface()`, e.g. `"claude"`), and `agentId` (FK to the registered agent). They answer three different questions and are not interchangeable.

**Facts — read side effects:** `readFact` / `readFactsByEntity` always update `lastAccessedAt` and increment `accessCount`. Reading is a write to the access-tracking columns; this is the signal Phase 4 consumes.

**Library API (CRUD surface, no transport):** `registerAgent`; `openSession` / `closeSession` / `getOpenSessions`; `upsertEntity`; `writeFact` / `readFact` / `readFactsByEntity` / `archiveFact` (+ `getFactHistoryByKey` over the archive); `writeRule` / `getRulesForAttend`. No HTTP, no MCP — these are TypeScript functions.

## 7. Acceptance criteria

- [x] Schema defines all six tables (`agents`, `sessions`, `entities`, `facts`, `fact_archive`, `rules`) as the single source of truth, with inferred types.
- [x] Migrations `0000`–`0002` are committed under `drizzle/` and apply cleanly to a live database.
- [x] You can write a fact, read it back, archive it, and query by entity and by session against a running PostgreSQL instance (master PRD §12 "The Library" done-bar).
- [x] Writing to an existing `(tenantId, entityType, entityId, key)` upserts in place, snapshots the old value to `fact_archive` with `archivedReason = 'superseded'`, and leaves the fact UUID unchanged.
- [x] `archiveFact` snapshots the current value with `archivedReason = 'archived_by_user'` and sets `isArchived = true`; no row is ever hard-deleted.
- [x] Reading a fact updates `lastAccessedAt` and increments `accessCount`.
- [x] `surface` writes are validated against `VALID_SURFACES`; an unknown surface fails loudly.
- [x] `tenantId` is `NOT NULL DEFAULT 'default'` on `facts`, `fact_archive`, and `rules`, and is part of the `facts` unique constraint.
- [x] `registerAgent`, `upsertEntity`, and session open are get-or-create / explicit as specified.
- [x] 46 integration tests pass; CI runs them against a real Postgres service.

## 8. Deltas from the master PRD

This phase diverges from the master PRD's build sequence in two honest, recorded ways.

- **Foundation and "The Library" folded into one Phase 0.** Master PRD §12 lists **Phase 0: Foundation** (schema design, Docker Compose, shared types, the `GraphBackend` interface, the system seed script) and a separate **Phase 1: The Library** (the schema as migrations plus the read/write/archive/query functions). The executed plan combined the foundation work *and* the library CRUD into a single shipped Phase 0, because the schema and the CRUD over it were tightest to build and test together — you cannot meaningfully review the schema without the queries that exercise it. The master PRD's "Phase 1: The Library" done-bar ("write a fact, read it back, archive it, and query by entity and by session in a running PostgreSQL instance") is therefore the bar this combined Phase 0 was held to and met.
  - Two §12 Phase-0 line items were intentionally *not* pulled into this phase: the **`GraphBackend` interface** (deferred to Phase 2, where the first graph implementation lands) and the **system-namespace seed script** (not yet built). Neither blocks the data layer; both are tracked for their owning phase. The master PRD also names Prisma for "The Library"; the executed plan uses Drizzle + postgres.js instead (see §5).

- **Phase-numbering schemes differ between documents, and are not reconciled here.** `implementation.md` uses a numbering scheme (Phase 0 = Library Foundation, Phase 1 = MCP Server, Phase 2 = Intelligence, Phase 3 = Cross-platform + Retrieval, Phase 4 = Memory Lifecycle, Phase 5 = Multi-user SaaS) that does **not** line up with master PRD §12's sequence (which puts MCP integration at Phase 5 and the Librarian/Attendant/Archivist at 2/3/4). This PRD follows the `implementation.md` scheme because that is the scheme the codebase, commits, and other phase PRDs use. The mismatch between the two documents is real and is **flagged, not resolved** — reconciling the master PRD §12 sequence with the implementation scheme is a backlog item, out of scope for a retroactive Phase 0 PRD.

## 9. Risks & open questions

- **The two phase-numbering schemes will keep causing confusion until reconciled.** Anyone reading master PRD §12 alongside `implementation.md` or these phase PRDs sees two different maps of the same project. Flagged in §8; the reconciliation is a standing backlog item, not closed here.
- **Surface allowlist drift.** `VALID_SURFACES` is an application-level constant. Adding a new host means editing it; forgetting to means honest writes from a new surface fail loudly (the intended failure mode, but it is a manual step). Acceptable for single-user Phase 0; revisit if host onboarding becomes frequent.
- **`isArchived` is irreversible in Phase 0.** A manually archived fact cannot be un-archived through the library. The data survives in `fact_archive`, so this is recoverable by hand, but there is no un-archive path until a later phase needs one.
- **Open:** the master PRD §12 Phase-0 `GraphBackend` interface and system seed script are not built. They are assigned to Phase 2 and a later seed task respectively; this is recorded so they are not silently lost.

## 10. Verification

- **46 integration tests across 5 test files**, run against a real PostgreSQL (not a mock), covering agent registration, session lifecycle, entity upsert, fact write/read/archive with history, surface validation, the upsert→archive snapshot path, and rule writes/reads.
- **All six tables live** in `iranti_dev` on `localhost:5435` with migrations `0000`–`0002` applied.
- **CI** (`.github/workflows/ci.yml`) runs the suite against a `postgres:17-alpine` service container, so the full data layer is verified on every push, not just locally.
- **Migrator note:** verification uses a hand-rolled Node migrator (`src/db/migrate.ts`) because `drizzle-kit migrate` was silently failing on Windows — caught and worked around during Phase 0.
- **Docker note:** the local stack runs on host port **5435** (`docker-compose.yml` maps `5435:5432`, and `.env`'s `DATABASE_URL` uses 5435) because the host machine already runs native PostgreSQL on 5432 and 5433.

## Changelog

- 2026-06-10 — authored retroactively from the implementation record (`implementation.md`, `src/db/schema.ts`).
- _shipped (actual):_ commit `7fadef5` on `iranti-core` — schema, migrations `0000`–`0002`, library CRUD, `fact_archive` support, 46/46 integration tests, CI with a Postgres service. Supplements (tenantId seam, `updatedAt`, surface validation, docs) in `3321c8c`.
