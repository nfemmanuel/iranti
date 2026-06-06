# Session grouping

**Status:** template  
**Group:** Memory and storage · **Phase:** 0  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

Every fact is tagged with the session that produced it, enabling time-based retrieval.

## Why it matters

"What did we work on last Tuesday" cannot be answered without it. Session grouping is what makes iranti temporally aware rather than just a flat store of disconnected facts.

## How it works

Every session is a registered entity in the system. Every fact carries a `session_id` as a required foreign key. Sessions carry metadata: start time, host, project, and agent id. This makes the session itself queryable and traversable in the graph — not just a tag on facts.

## User stories

- As a developer, I want to ask the agent what we worked on during a specific session so that I can review decisions made earlier in the week.
- As a developer, I want the agent to have temporal awareness without my having to remember or specify session IDs manually.
- As an operator, I want to query all facts produced during a session for debugging and auditing purposes.

## Acceptance criteria

- [ ] Every fact has a required `session_id` field — writes without one are rejected
- [ ] Sessions are registered as entities in the entity table at session start
- [ ] A session entity includes: `startedAt`, `host`, `project`, `agentId`
- [ ] All facts from a given session can be queried by `session_id`
- [ ] Time-based queries work: all sessions in the last N days, all facts from those sessions
- [ ] Session entities appear as nodes in the knowledge graph

## Technical notes

_Fill in when ready to build (Phase 0 — part of schema design). Cover: session table definition, foreign key on facts table, query helpers._

## Dependencies

- Schema design complete (Phase 0) — session table must exist before facts table uses it
- Entity registry (Phase 1) — sessions register as entities

## Related specs

- [Fact storage](fact-storage.md) — session_id is a required field on every fact
- [Knowledge graph](knowledge-graph.md) — sessions are graph nodes connected to their facts
- [Agent registry](../observability/agent-registry.md) — sessions link to registered agents
- [Session ledger](../observability/session-ledger.md) — staff events are session-scoped
- [Schema](../../technical/schema.md) — session table definition
