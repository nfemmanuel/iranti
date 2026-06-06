# System self-awareness

**Status:** template  
**Group:** Observability and accounts · **Phase:** 7  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

Iranti maintains its own version, metrics, connected sessions, and operational state as a distinct memory category.

## Why it matters

A system that cannot report on its own state is difficult to operate and debug. System memory is iranti's knowledge of itself — separate from session memory (what iranti has learned from observations) and not subject to the same decay and archiving rules.

## System memory vs session memory

| | Session memory | System memory |
|---|---|---|
| **Source** | Observed from agent sessions | Maintained by iranti about itself |
| **Grows** | As sessions accumulate | As iranti operates |
| **Subject to decay** | Yes | No |
| **Subject to archiving** | Yes | No (except version history) |
| **Accessible to agents** | Yes, within permissions | No — internal only |

## What system memory contains

- Iranti version (current and history)
- Operating rules (loaded at handshake time)
- Protected entries (facts that must always be available)
- Connected sessions (active and recent)
- Operational metrics (call volume, error rate, last Archivist cycle)
- Graph backend status (which implementation is active)
- Knowledge store size and health

## The seed script

System memory is seeded at initialisation. The seed script writes the initial operating rules, version, and protected entries to the system namespace. This runs as part of Phase 0 setup.

## User stories

- As an operator, I want `iranti status` to give me a clear picture of iranti's current state without reading any session content.
- As an agent, I want my Attendant to load operating rules from system memory at handshake time so that it knows how iranti expects to be used.

## Acceptance criteria

- [ ] A system namespace exists that is inaccessible to external agents
- [ ] System memory is seeded correctly by the Phase 0 seed script
- [ ] `iranti status` reads from system memory to display: version, connected sessions, knowledge store size, last Archivist cycle, graph backend active
- [ ] Operating rules are loadable from system memory at handshake time
- [ ] System memory is not subject to decay or archiving

## Technical notes

_Fill in when ready to build (Phase 7, though seed script is Phase 0). Cover: system namespace definition, protected entries schema, how operating rules are stored and loaded, what `iranti status` reads._

## Dependencies

- Schema design complete (Phase 0) — system namespace defined from the start
- Seed script running (Phase 0)
- Session ledger in place (Phase 7) — status reads from ledger for recent events

## Related specs

- [Fact storage](../memory-storage/fact-storage.md) — system memory uses the same storage layer with a protected namespace
- [Session ledger](session-ledger.md) — operational metrics in status come partly from the ledger
- [Schema](../../technical/schema.md) — system namespace and seed script
