# Session ledger

**Status:** template  
**Group:** Observability and accounts · **Phase:** 7  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

Structured audit trail of all staff events within a session.

## Why it matters

Operators need to inspect what iranti did and when, both for debugging and for accountability. The ledger is the record of every decision iranti made — what it wrote, what it retrieved, what it injected, when conflicts were detected — all with timestamps and reasons.

## What the ledger records

Every significant event from the Staff:

**Attendant events:**
- Stream signal detected (without content)
- Retrieval triggered (reactive or periodic)
- Injection decision: inject, correct, or stay silent
- Write routed to Librarian

**Librarian events:**
- Fact written (entity address, confidence, source — no value)
- Conflict detected (both fact addresses, resolution outcome)
- Conflict escalated (escalation file created)

**Archivist events:**
- Fact archived (id, reason: decayed, expired, superseded)
- Escalation processed (id, resolution applied)
- Cycle completed (count of facts archived, decayed, escalated)

## What the ledger does not record

- Fact values or content
- Message content of any kind
- Anything that would allow reconstruction of what a user was working on

The ledger records system behaviour, not user data.

## Permanent record

The ledger is separate from the knowledge store and is not subject to decay or archiving rules. It is a permanent record of system behaviour. This is intentional — you need to be able to go back and understand what the system did even after facts have been archived or superseded.

## User stories

- As an operator, I want to inspect the session ledger to understand why iranti made a specific retrieval or injection decision.
- As a developer, I want to query the ledger to find all conflict escalations in the last week for audit purposes.

## Acceptance criteria

- [ ] All Staff events (Attendant, Librarian, Archivist) are written to the ledger with timestamps and reasons
- [ ] Ledger entries never include fact values or message content
- [ ] The ledger is queryable by session, time range, event type, and entity
- [ ] The ledger is not subject to decay — entries are permanent
- [ ] Ledger storage is separate from the knowledge store (different table)
- [ ] `iranti status` can report ledger size and recent event counts

## Technical notes

_Fill in when ready to build (Phase 7). Cover: ledger schema (events table), event type taxonomy, write performance (high-frequency writes), retention policy (permanent but may need archiving for storage)._

## Dependencies

- All Staff implemented (Phases 2–4) — ledger records events from all three

## Related specs

- [Usage analytics](usage-analytics.md) — analytics are derived from ledger events
- [Bidirectional Attendant](../intelligence/bidirectional-attendant.md) — primary source of ledger events
- [Schema](../../technical/schema.md) — ledger table definition
