# Schema

**Status:** template  
**Needed by:** Phase 0  
**[Back to map](../MAP.md)**

---

> The schema must be designed and reviewed before any Phase 1 code is written. Get it right here first.

## Purpose

Full PostgreSQL schema design for iranti-core: the knowledge store, archive, entity system, relationship graph, rules store, and staff events table. This is the data foundation everything else builds on.

## Design constraints

- Every fact must have a `session_id`
- Every fact must have `lastAccessedAt` and `stabilityScore` for the decay model
- The archive is a separate table — nothing in the knowledge store is ever deleted
- The relationship table must support recursive CTE traversal for the graph backend
- The system namespace must be separate and inaccessible to external queries
- Media storage must be accommodatable from the start (even if media ships later)
- All timestamps are UTC

## Tables to design

### facts

The primary knowledge store. All active facts.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `entityType` | string | Entity type (project, agent, file, session, ...) |
| `entityId` | string | Specific instance |
| `key` | string | What about this entity is recorded |
| `value` | jsonb | The fact's content |
| `confidence` | integer | 0–100, maintained by iranti |
| `stabilityScore` | float | Controls decay speed |
| `source` | string | Provenance identifier |
| `status` | enum | active, protected |
| `session_id` | uuid | FK to sessions table — required |
| `createdAt` | timestamp | |
| `validFrom` | timestamp | |
| `validUntil` | timestamp | nullable |
| `lastAccessedAt` | timestamp | Updated on retrieval |

Unique index on `(entityType, entityId, key)`.

### archive

Permanent record of all archived facts.

_Same columns as facts, plus:_

| Column | Type | Notes |
|---|---|---|
| `archivedAt` | timestamp | |
| `archiveReason` | enum | decayed, expired, superseded, pending_resolution |
| `originalId` | uuid | FK to original facts.id |

### sessions

Every session that iranti has been part of.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `agentId` | uuid | FK to agents table |
| `project` | string | Project identifier |
| `host` | string | Host type |
| `startedAt` | timestamp | |
| `endedAt` | timestamp | nullable |

### entities

Entity registry for alias resolution and graph node management.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `entityType` | string | |
| `entityId` | string | |
| `aliases` | string[] | Alternative identifiers |
| `createdAt` | timestamp | |

### relationships

Relationship graph. Used by the PostgreSQL graph backend for recursive CTE traversal.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `fromFactId` | uuid | FK to facts.id |
| `toFactId` | uuid | FK to facts.id |
| `relationshipType` | enum | temporal_cooccurrence, entity_overlap, semantic_similarity |
| `confidence` | float | Updated by Hebbian reinforcement |
| `createdAt` | timestamp | |
| `lastReinforcedAt` | timestamp | |

### rules

Rules and preferences store. Separate from facts.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `entityType` | string | Scope (project, user, global) |
| `entityId` | string | |
| `trigger` | jsonb | Context match condition |
| `content` | text | The rule text |
| `source` | string | |
| `createdAt` | timestamp | |

### checkpoints

Task summaries for session recovery.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `session_id` | uuid | FK to sessions |
| `agentId` | uuid | |
| `summary` | text | |
| `keyFactIds` | uuid[] | Facts active at checkpoint time |
| `createdAt` | timestamp | |

### staff_events (session ledger)

Permanent audit trail. Never decays.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `session_id` | uuid | |
| `agent` | string | librarian, attendant, archivist |
| `eventType` | string | |
| `entityAddress` | string | nullable — entity involved, no value |
| `reason` | text | Why the event occurred |
| `timestamp` | timestamp | |

### agents

Agent registry.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `hostType` | string | |
| `reliabilityScore` | float | |
| `registeredAt` | timestamp | |
| `lastActiveAt` | timestamp | |

## Open questions for schema design

_Fill in during Phase 0 design:_
- Exact enum values for all enum types
- Index strategy for retrieval queries (what needs to be fast?)
- How the system namespace is technically isolated (separate schema, separate table, or flag?)
- Media table design (what columns, what references object storage?)
- Full-text search setup for similarity retrieval

## Related specs

- [Fact storage](../specs/memory-storage/fact-storage.md)
- [Session grouping](../specs/memory-storage/session-grouping.md)
- [Knowledge graph](../specs/memory-storage/knowledge-graph.md)
- [Archive](../specs/lifecycle/archive.md)
- [Session ledger](../specs/observability/session-ledger.md)
