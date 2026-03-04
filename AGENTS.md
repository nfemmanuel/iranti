# AGENTS.md — Iranti System Context

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

Product type: IaaS (Infrastructure as a Service)
License: AGPL

---

## The Staff — System Components

Iranti has four internal components collectively called The Staff:

### The Library
The knowledge base itself. PostgreSQL database with five core tables:
- `knowledge_base` — active truth. What agents read from and write to.
- `archive` — challenged truth. Superseded or contradicted entries with full
  provenance. Never deleted.
- `entity_relationships` — directional relationships between entities. Caller-
  defined relationship types (MEMBER_OF, PART_OF, AUTHORED, etc.).
- `entities` — canonical entity identity registry (`entityType + entityId`).
- `entity_aliases` — normalized aliases mapped to canonical entities for
  resolution across detector/extractor/query variants.

There is also a protected Staff Namespace: entries where `entityType = 'system'`.
No agent can write here. Only the seed script and explicit system operations
can. The Staff Namespace holds operating rules for all Staffers and system
metadata including source reliability scores.

### The Librarian
The agent that manages the Library. All writes from external agents go through
the Librarian — never directly to the database. Responsibilities:
- Receives findings from agents, decides how to store them
- Chunks raw content blobs into atomic facts before writing
- Loads source reliability scores and applies weighted confidence to all writes
- Checks new findings for conflicts with existing entries
- Resolves conflicts deterministically when confidence gap >= 10 points
- Uses LLM reasoning (conflict_resolution task type) for ambiguous conflicts
- Escalates genuinely unresolvable conflicts to the Escalation Folder
- Updates agent stats after every write
- Logs every decision with a reason — nothing is silently overwritten

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
  a DB round trip — the Attendant is a fast cache, the Librarian owns truth
- Context recovery: after 20 LLM calls, re-reads operating rules from Staff
  Namespace rather than hallucinating behavior. Resets call counter

Context inference method: observes the agent's recent messages to infer
current task — does not require the agent to explicitly signal task type.

### The Archivist
A periodic cleanup agent. Does not run on every write. Runs on a schedule or
when conflict flags exceed a threshold. Responsibilities:
- Archives expired entries (validUntil has passed)
- Archives low confidence entries (below threshold)
- Reads Escalation Folder for RESOLVED files, extracts resolution via LLM,
  writes to KB as authoritative (confidence = 100, source = HumanReview)
- Moves resolved files to escalation/resolved/, archives copy to
  escalation/archived/ with timestamp

The Archivist never deletes. Worst case of bad reasoning is a messy Archive,
not lost knowledge.

---

## LLM Abstraction Layer

All model calls go through `src/lib/llm.ts` and `src/lib/router.ts`. Never
call a provider SDK directly from component code.

### Task Types and Model Routing
Each LLM call declares a task type. The router selects the appropriate model:

| Task Type | Default Model | Reason |
|---|---|---|
| classification | gemini-2.0-flash-001 | Fast, cheap |
| relevance_filtering | gemini-2.0-flash-001 | Fast enough |
| conflict_resolution | gemini-2.5-pro | Needs careful reasoning |
| summarization | gemini-2.0-flash-001 | Well within fast model capability |
| task_inference | gemini-2.0-flash-001 | Lightweight classification |

Override any model via environment variable (e.g. `CONFLICT_MODEL=claude-opus-4`).

### Providers
Providers live in `src/lib/providers/`. Current implementations:
- `mock.ts` — hardcoded responses for local dev and testing (default)
- `gemini.ts` — Google Gemini via REST API
- `claude.ts` — Anthropic Claude (stub, ready for API key)

Switch provider by setting `LLM_PROVIDER` in `.env`. Swap is a one-line
config change — no code changes required.

---

## Source Reliability Learning

The Librarian tracks per-source reliability scores in the Staff Namespace
under `system / librarian / source_reliability`. Scores are used to compute
weighted confidence: `confidence × 0.7 + confidence × reliability × 0.3`.

- Default score: 0.5 (neutral, used for unknown sources)
- Range: 0.1 – 1.0
- Win delta: +0.03 per resolution won
- Loss delta: -0.02 per resolution lost
- Human override delta: +/- 0.08
- Decay rate: 0.005 toward neutral per update cycle

Scores update automatically after every conflict resolution. Over hundreds of
resolutions, trusted sources score higher and their findings carry more weight.

---

## Agent Registry

Agents are first-class entities in the Library. Each registered agent has:
- `agent / agentId / profile` — name, description, capabilities, model
- `agent / agentId / stats` — totalWrites, totalRejections, totalEscalations,
  avgConfidence, lastSeen, isActive
- `agent / agentId / attendant_state` — persisted Attendant working memory

Stats update automatically on every `librarianWrite` call. No manual tracking
needed. `whoKnows(entityType, entityId)` returns every agent that has written
a fact about a given entity.

---

## File Structure

```
iranti/
├── src/
│   ├── library/
│   │   ├── client.ts           — Prisma singleton
│   │   ├── queries.ts          — All KB read/write operations
│   │   ├── entity-resolution.ts — Canonical entity resolution + alias mapping
│   │   ├── relationships.ts    — Entity relationship graph
│   │   └── agent-registry.ts  — Agent profiles, stats, whoKnows
│   ├── librarian/
│   │   ├── index.ts            — librarianWrite, librarianIngest
│   │   ├── chunker.ts          — Raw content → atomic EntryInput facts
│   │   └── source-reliability.ts — Reliability scores, weighted confidence
│   ├── attendant/
│   │   ├── index.ts            — Re-exports + legacy functional API
│   │   ├── AttendantInstance.ts — Per-agent stateful class
│   │   └── registry.ts         — Singleton map, getAttendant()
│   ├── archivist/
│   │   └── index.ts            — runArchivist(), escalation processing
│   ├── lib/
│   │   ├── llm.ts              — LLMProvider interface, completeWithFallback(), fallback chain
│   │   ├── router.ts           — route() by TaskType, model profiles
│   │   └── providers/
│   │       ├── mock.ts         — Local dev provider
│   │       ├── gemini.ts       — Google Gemini provider
│   │       ├── claude.ts       — Anthropic Claude provider (stub)
│   │       ├── openai.ts       — OpenAI provider
│   │       ├── groq.ts         — Groq provider
│   │       ├── mistral.ts      — Mistral AI provider
│   │       └── ollama.ts       — Ollama local provider
│   ├── sdk/
│   │   └── index.ts            — Iranti class, public API
│   ├── api/
│   │   ├── server.ts           — Express REST API server
│   │   ├── middleware/
│   │   │   └── auth.ts         — API key authentication
│   │   └── routes/
│   │       ├── knowledge.ts    — Write, ingest, query, relationships, resolution
│   │       ├── agents.ts       — Agent registration and management
│   │       └── memory.ts       — Handshake, reconvene, whoKnows, maintenance
│   └── types.ts                — Shared TypeScript types
├── prisma/
│   ├── schema.prisma           — KnowledgeEntry, Archive, EntityRelationship, Entity, EntityAlias
│   └── migrations/             — Migration history
├── scripts/
│   ├── seed.ts                 — Seeds Staff Namespace
│   ├── demo.ts                 — Full system demo with two agents
│   ├── test-librarian.ts       — Librarian smoke tests
│   ├── test-attendant.ts       — Attendant smoke tests
│   ├── test-archivist.ts       — Archivist smoke tests
│   ├── test-chunker.ts         — Chunker + ingest tests
│   ├── test-reliability.ts     — Source reliability learning tests
│   ├── test-relationships.ts   — Knowledge graph tests
│   ├── test-registry.ts        — Agent registry tests
│   ├── test-sdk.ts             — Full SDK smoke tests
│   ├── test-integration.ts     — End-to-end integration test
│   ├── test-fallback.ts        — LLM provider fallback chain test
│   └── test-contracts.ts       — API/SDK/client contract drift checks
├── escalation/
│   ├── active/                 — Unresolved conflicts (PENDING)
│   ├── resolved/               — Processed by Archivist
│   └── archived/               — Long-term conflict log
├── docs/
│   ├── engineering/            — CODE_STANDARDS.md, COMMENTING_GUIDELINES.md
│   └── decisions/              — One file per architectural decision
├── clients/
│   └── python/
│       ├── iranti.py           — Python HTTP client for REST API
│       ├── test_client.py      — Python client smoke test
│       └── README.md           — Python client documentation
├── AGENTS.md                   — This file
├── docker-compose.yml          — PostgreSQL for local dev
└── .env                        — Local environment (never committed)
```

---

## Database Schema — Quick Reference

### knowledge_base
| Column | Type | Notes |
|---|---|---|
| id | Int | Auto-increment primary key |
| entityType | String | Caller-defined: researcher, agent, system, etc. |
| entityId | String | Canonical identifier |
| key | String | What this entry describes |
| valueRaw | Json | Full exact value |
| valueSummary | String | Compressed for working memory loading |
| confidence | Int | 0–100 raw. Weighted by source reliability at resolution |
| source | String | Data source |
| validUntil | DateTime? | Expiry for time-sensitive facts |
| createdBy | String | Agent or system that wrote it |
| isProtected | Boolean | True for Staff Namespace entries |
| conflictLog | Json | History of contradictions |
| properties | Json | Caller-defined metadata escape hatch |

Primary index: `(entityType, entityId, key)` — unique constraint enforced.

### archive
Same as knowledge_base, plus:
| Column | Type | Notes |
|---|---|---|
| archivedAt | DateTime | When moved to Archive |
| archivedReason | String | superseded / contradicted / expired / duplicate |
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

## Staff Namespace — Protected Entries

| Key | Contents |
|---|---|
| system / librarian / operating_rules | Write rules, conflict resolution behavior |
| system / librarian / source_reliability | Per-source reliability scores (auto-updated) |
| system / attendant / operating_rules | Handshake, relevance filtering, reconvene rules |
| system / archivist / operating_rules | Archive triggers, escalation processing rules |
| system / library / schema_version | Current schema version |
| system / library / initialization_log | When Library was initialized |

---

## SDK — Public API

```typescript
const iranti = new Iranti({ connectionString, llmProvider });

// Write atomic fact
await iranti.write({ entity, key, value, summary, confidence, source, agent });

// Ingest raw content blob (auto-chunks into atomic facts)
await iranti.ingest({ entity, content, source, confidence, agent });

// Agent working memory
const brief = await iranti.handshake({ agent, task, recentMessages });
await iranti.reconvene(agentId, { task, recentMessages });
const attendant = iranti.getAttendant(agentId);

// Query
const result = await iranti.query(entity, key);
const all = await iranti.queryAll(entity);

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
- Never write directly to any DB table — all writes go through the Librarian
- Never modify entries where `isProtected = true`
- Never delete from the Archive table
- Never call provider SDKs directly — use `route()` or `complete()` from
  `src/lib/router.ts` and `src/lib/llm.ts`
- LLM provider fallback is automatic — configure via `LLM_PROVIDER_FALLBACK` env var,
  mock is always used as final safety net
- Follow CODE_STANDARDS.md in docs/engineering/
- When adding a new component or method, update this file

### For Humans
- All architectural decisions go in docs/decisions/ as individual files
- `.env` is never committed
- Escalation files in escalation/active/ are written by the Librarian —
  human resolution goes in the HUMAN RESOLUTION section only, change
  Status to RESOLVED when done
- The Staff Namespace (entityType = system) is only modified by seed.ts
  or explicit system operations — never by external agents

---

## Documentation Standards

### Doc Types and Where They Live

- **docs/guides/** — How-to guides for developers using Iranti. One file per
  topic. Written for external developers, not internal contributors.
- **docs/decisions/** — Architectural decision records (ADRs). One file per
  decision. Named `NNN-short-title.md` e.g. `001-agpl-license.md`. Never
  deleted or edited after the fact — add a new ADR if a decision changes.
- **docs/features/** — One subfolder per feature. Each contains `spec.md`
  covering inputs, outputs, decision tree, edge cases, and test results.
- **docs/engineering/** — Internal standards for contributors.
  `CODE_STANDARDS.md`, `COMMENTING_GUIDELINES.md`.
- **README.md** — Public-facing overview. Updated only when public API or
  onboarding flow changes.
- **AGENTS.md** — System context for AI agents and contributors. Updated
  whenever components, rules, file structure, or schema change.
- **Living Document (Iranti_Living_Document.docx)** — Full implementation
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

### ADR Format

Every file in `docs/decisions/` must follow this exact structure:

```markdown
# NNN — Title

## Context
What situation or problem led to this decision?

## Decision
What was decided?

## Consequences
What are the results of this decision — good and bad?

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
- [ ] If a new provider was added, is `docs/guides/providers.md` updated?
- [ ] If onboarding steps changed, is `docs/guides/quickstart.md` updated?
- [ ] Is the Living Document updated with implementation notes?

### Living Document Rule

The Living Document (`Iranti_Living_Document.docx`) is the authoritative
record of implementation history. It is updated after every significant build
session. It is not a substitute for inline docs or AGENTS.md — it is the
audit trail. If the Living Document and AGENTS.md disagree, AGENTS.md is the
source of truth for current state.

Rules:
- Do not summarize or compress existing Living Document entries
- Add new entries at the end of the relevant section
- Never edit past entries — add corrections as new entries
- The Living Document is generated programmatically from `iranti_living_doc.js`
  — do not edit the `.docx` directly

---

## Escalation Folder

Unresolvable conflicts land in `escalation/active/` as markdown files.
Each file has two sections:

**LIBRARIAN ASSESSMENT** — written by the Librarian. Contains entity,
existing and incoming values, confidence scores, reasoning, and
`**Status:** PENDING`.

**HUMAN RESOLUTION** — written by a human in plain language. No code
required. Change `**Status:** PENDING` to `**Status:** RESOLVED` when done.

The Archivist watches for RESOLVED files, extracts the resolution via LLM,
writes to KB as authoritative truth (confidence = 100, source = HumanReview),
and moves the file to escalation/resolved/ with an archived copy.

---

## Current Build Status

| Phase | Description | Status |
|---|---|---|
| 0 — Architecture | Schema, PRD, docs | DONE |
| 1 — The Library | DB client, CRUD, seed script, relationships, registry | DONE |
| 2 — The Librarian | Conflict resolution, chunking, source reliability | DONE |
| 3 — The Attendant | Per-agent class, singleton registry, session persistence | DONE |
| 4 — The Archivist | Periodic scan, escalation processing | DONE |
| 5 — Integration | Full multi-agent loop, end-to-end tests | DONE |
| 6 — SDK | TypeScript SDK, full public API | DONE |
| 7 — Open Source | README, Docker onboarding, GitHub public | IN PROGRESS |
| 8 — Hosted Version | Cloud deployment, pricing | Not Started |
