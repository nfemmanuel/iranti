# Fact storage

**Status:** template  
**Group:** Memory and storage · **Phase:** 1  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

Stores any piece of knowledge as an atomic fact addressed by entity type, entity id, and key.

## Why it matters

This is the foundation everything else builds on. Every other feature — retrieval, decay, conflict detection, graph traversal — depends on facts being stored correctly and consistently.

## A fact in detail

A fact is identified by three things: **entity type + entity id + key**. Together these form its unique address.

Every fact carries:
- A confidence score (0–100), owned and maintained by iranti — not the host or the agent
- A source with provenance
- Timestamps: `createdAt`, `validFrom`, `validUntil` (optional), `lastAccessedAt`
- A `stabilityScore` that controls how quickly confidence decays
- A `session_id` linking it to the session that produced it
- Status: `active`, `archived`, `superseded`, `pending_resolution`, `protected`

## User stories

- As a developer using Claude Code, I want facts about my project to persist between sessions so that the agent remembers constraints and decisions from earlier work.
- As an agent builder, I want facts stored at a predictable entity address so that I can query them by known paths without understanding iranti internals.

## Acceptance criteria

- [ ] A fact can be written to the knowledge store with a full entity address (type + id + key)
- [ ] A fact can be read back by its entity address
- [ ] All required fields are present and correctly typed
- [ ] Confidence score defaults to 85 if not provided by the Attendant
- [ ] A session_id is required on every fact — writes without one are rejected
- [ ] Duplicate writes to the same address trigger conflict detection, not a silent overwrite
- [ ] Protected facts cannot be updated or archived through the normal write path

## Technical notes

_Fill in when ready to build (Phase 1). Cover: Prisma model, field types, index design, query function signatures._

## Dependencies

- Schema design complete (Phase 0)
- Shared TypeScript types defined (Phase 0)
- Entity registry in place (Phase 1)

## Open questions

_None specific to this feature. See [§13 of the PRD](../../rough-notes/iranti-core-prd.md#13-open-items) for system-level open items._

## Related specs

- [Session grouping](session-grouping.md) — Every fact requires a session_id
- [Knowledge graph](knowledge-graph.md) — Facts are nodes in the graph
- [Archive](../lifecycle/archive.md) — Facts are archived, never deleted
- [Conflict detection](../lifecycle/conflict-detection.md) — What happens on duplicate writes
- [Memory decay](../lifecycle/memory-decay.md) — How confidence changes over time
- [Schema](../../technical/schema.md) — Full data model
