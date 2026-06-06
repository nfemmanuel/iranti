# Bidirectional Attendant

**Status:** template  
**Group:** Intelligence · **Phase:** 3  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

The Attendant handles both retrieval and write routing simultaneously within each turn.

## Why it matters

The original design where agents drove writes produced inconsistent behaviour across hosts. Different agents made different write decisions. By making the Attendant bidirectional — handling both sides every turn — iranti owns memory decisions completely and produces consistent behaviour regardless of host.

## The two sides

**Retrieval side.** The Attendant reads the conversation stream, infers what the agent is working on, and surfaces relevant context from the knowledge store. It checks what is already in the context window before injecting anything. It runs two retrieval modes simultaneously: reactive (signal-triggered) and periodic (drift check every N turns).

**Write side.** The Attendant watches the same stream for signal worth storing and routes it to the Librarian. The agent does not call write tools manually. This is the core departure from the original iranti.

Both sides run every turn. They are not sequential — retrieval and write routing happen in parallel within the same turn.

## Per-agent instantiation

One Attendant instance exists per external agent per session. The Attendant knows which agent it is serving, which session it is in, and which project it is operating in. This scoping is what makes entity-level access control and session grouping work correctly.

## The handshake

At session start, the Attendant performs a handshake: it loads operating rules from the system namespace and builds the agent's initial working memory brief. This is what primes the agent with relevant context before any user message arrives.

## User stories

- As a developer, I want iranti to handle both storing and surfacing information automatically, without my having to tell the agent when to remember or recall.
- As an agent builder, I want a single Attendant instance per agent session that handles the full memory lifecycle, so that I do not need to wire up separate retrieval and write flows.

## Acceptance criteria

- [ ] One Attendant instance is created per agent per session at session start
- [ ] The Attendant runs both retrieval and write routing every turn, in parallel
- [ ] The Attendant performs a handshake at session start (load operating rules, build working memory brief)
- [ ] The retrieval and write sides share stream access but operate independently
- [ ] The Attendant correctly scopes all operations to the right agent, session, and project
- [ ] Bidirectional behaviour is consistent across MCP and SDK host types

## Technical notes

_Fill in when ready to build (Phase 3). Cover: Attendant class structure, session lifecycle management, how both sides access the stream, handshake implementation, per-agent scoping._

## Dependencies

- Library (Phase 1) — the Attendant reads from and writes to the Library
- Librarian write path (Phase 2) — write side routes to the Librarian
- Attendant retrieval: two-pass, context window observation, reactive retrieval, periodic drift check (all Phase 3)
- Attendant write: stream observation, write routing, rules handling (all Phase 3)

## Related specs

- [Autonomous write routing](autonomous-write-routing.md) — the Attendant's write side
- [Two-pass retrieval](../retrieval/two-pass-retrieval.md) — the Attendant's primary retrieval mechanism
- [Reactive retrieval](../retrieval/reactive-retrieval.md) — triggered by the Attendant on stream signal
- [Periodic drift check](../retrieval/periodic-drift-check.md) — the Attendant's heartbeat retrieval
- [Context window observation](../retrieval/context-window-observation.md) — runs before any injection
- [Rules and preferences](../memory-storage/rules-and-preferences.md) — the Attendant handles rule injection
- [Checkpoints](../memory-storage/checkpoints.md) — the Attendant writes and reads checkpoints
