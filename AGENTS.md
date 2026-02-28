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
The knowledge base itself. PostgreSQL database with two tables:
- `knowledge_base` — active truth. What agents read from and write to.
- `archive` — challenged truth. Superseded or contradicted entries with full
  provenance. Never deleted.

There is also a protected Staff Namespace: entries where `entityType = 'system'`.
No agent can write here. Only the Librarian can, during initialization or
explicit rule updates.

### The Librarian
The agent that manages the Library. All writes from external agents go through
the Librarian — never directly to the database. Responsibilities:
- Receives findings from agents, decides how to store them
- Checks new findings for conflicts with existing entries
- Resolves conflicts (deterministic for simple cases, model-assisted for
  ambiguous ones)
- Writes unresolvable conflicts to the Escalation Folder with status PENDING
- Runs the initialization pass on a blank Library
- Logs every decision with a reason — nothing is silently overwritten

### The Attendant
A lightweight agent assigned one-per-external-agent. Manages that agent's
working memory. Serves the agent, not the user. Responsibilities:
- Handshake on agent startup: reads AGENTS.md and MCP config, queries the
  Librarian for relevant rules and task context, delivers a working memory
  brief to the agent
- Relevance filtering: loads only what is relevant to the current task, not
  the full KB
- Reconvene: periodically updates working memory as task context shifts
- Context recovery: if context window runs low, re-reads operating rules from
  the Staff Namespace rather than hallucinating behavior

Context inference method: observes the agent's recent messages to infer
current task — does not require the agent to explicitly signal task type.

### The Archivist
A periodic cleanup agent. Does not run on every write. Runs on a schedule or
when conflict flags exceed a threshold. Responsibilities:
- Scans for expired, low-confidence, flagged, and duplicate entries
- Merges duplicates into single canonical entries
- Moves challenged entries to the Archive with full provenance
- Reads the Escalation Folder for RESOLVED entries, writes them to the KB as
  authoritative (confidence = 100, source = 'HumanReview'), archives the log

The Archivist never deletes. Worst case of bad reasoning is a messy Archive,
not lost knowledge.

---

## File Structure
```
iranti/
├── src/
│   ├── library/        — DB client, query helpers, seed logic
│   ├── librarian/      — Librarian agent logic
│   ├── attendant/      — Attendant agent logic
│   ├── archivist/      — Archivist agent logic
│   └── sdk/            — TypeScript SDK for external developers
├── prisma/
│   ├── schema.prisma   — Database schema (KnowledgeEntry, Archive)
│   └── migrations/     — Auto-generated migration history
├── scripts/
│   └── seed.ts         — Seeds the Staff Namespace on fresh Library init
├── escalation/
│   ├── active/         — Unresolved conflicts awaiting human review
│   ├── resolved/       — Processed by Archivist, pending archive
│   └── archived/       — Long-term conflict log storage
├── docs/
│   ├── engineering/    — Code standards, commenting guidelines
│   └── decisions/      — One file per major architectural decision
├── AGENTS.md           — This file
├── docker-compose.yml  — Spins up PostgreSQL for local dev
└── .env                — Local environment variables (never committed)
```

---

## Database Schema — Quick Reference

### knowledge_base
| Column | Type | Notes |
|---|---|---|
| id | Int | Auto-increment primary key |
| entityType | String | 'researcher', 'agent', 'rule', 'system', etc. |
| entityId | String | Canonical identifier for the specific entity |
| key | String | What this entry describes |
| valueRaw | Json | Full exact value |
| valueSummary | String | Compressed version for working memory |
| confidence | Int | 0–100 |
| source | String | Who wrote this |
| validUntil | DateTime? | When to re-verify |
| createdBy | String | Which Staffer wrote it |
| isProtected | Boolean | True for Staff Namespace entries |
| conflictLog | Json | History of contradictions on this entry |

Primary index: `(entityType, entityId, key)` — unique constraint enforced.

### archive
Same as knowledge_base, plus:
| Column | Type | Notes |
|---|---|---|
| archivedAt | DateTime | When moved to Archive |
| archivedReason | String | superseded / contradicted / expired / duplicate |
| supersededBy | Int? | ID of the KB entry that replaced this one |

---

## Rules for Working in This Codebase

### For AI Agents and Coding Assistants
- Read this file before making any changes
- Never write directly to the `knowledge_base` or `archive` tables —
  all writes go through the Librarian
- Never modify entries where `isProtected = true`
- Never delete from the Archive table
- Follow CODE_STANDARDS.md in docs/engineering/
- Follow COMMENTING_GUIDELINES.md in docs/engineering/
- When adding a new component, update this file

### For Humans
- All architectural decisions go in docs/decisions/ as individual files
- .env is never committed
- Escalation files in escalation/active/ are written by the Librarian —
  human resolution goes in the HUMAN RESOLUTION section only
- The Staff Namespace (entityType = 'system') is only seeded by scripts/seed.ts

---

## Escalation Folder

Unresolvable conflicts land in escalation/active/ as individual markdown files.
Each file has two sections:

**LIBRARIAN ASSESSMENT** — written by the Librarian. Contains the conflict,
confidence scores, reasoning, and status (PENDING or RESOLVED).

**HUMAN RESOLUTION** — written by a human or prompt engineer in plain language.
No code required. When complete, change status to RESOLVED.

The Archivist watches for RESOLVED files, writes the resolution to the KB as
authoritative truth, and moves the file to escalation/resolved/.

---

## Current Build Status

| Phase | Description | Status |
|---|---|---|
| 0 — Architecture | Schema, PRD, docs | Done |
| 1 — The Library | DB client, CRUD, seed script | In Progress |
| 2 — The Librarian | Agent logic, conflict detection | Not Started |
| 3 — The Attendant | Handshake, relevance filtering | Not Started |
| 4 — The Archivist | Periodic scan, archive logic | Not Started |
| 5 — Integration | Full multi-agent loop | Not Started |
| 6 — SDK | TypeScript SDK, docs | Not Started |
| 7 — Open Source | GitHub public, README | Not Started |
| 8 — Hosted Version | Cloud deployment, pricing | Not Started |