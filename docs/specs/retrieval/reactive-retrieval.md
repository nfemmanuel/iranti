# Reactive retrieval

**Status:** template  
**Group:** Retrieval · **Phase:** 3  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

Retrieval fires automatically when the stream contains a signal that memory is needed.

## Why it matters

Agents should not have to ask for relevant context. The Attendant detects the moments when memory is needed and acts without being prompted.

## What counts as a retrieval signal

A reactive retrieval fires when the Attendant detects any of the following in the stream:
- A new entity is mentioned that iranti has stored facts about
- The topic shifts significantly from what was previously active
- A complex question arrives that is likely to require prior context
- The user references something from a prior session ("like we discussed before", "remember when we...")

## User stories

- As a developer, I want the agent to automatically have relevant context when I reference something from a previous session, without my having to ask.
- As an agent, I want to receive memory injections precisely when I need them, not on every turn regardless of context.

## Acceptance criteria

- [ ] The Attendant detects entity mentions in the stream and checks for stored facts
- [ ] The Attendant detects topic shifts and triggers retrieval when they occur
- [ ] Retrieval fires on explicit references to prior sessions or prior work
- [ ] Reactive retrieval does not fire on every turn — only on signal
- [ ] Retrieval trigger events are logged in the session ledger

## Technical notes

_Fill in when ready to build (Phase 3). Cover: what constitutes a "signal", how the Attendant reads the stream, detection algorithm, how this coordinates with periodic drift check._

## Dependencies

- Fact storage in place (Phase 1)
- Attendant write side in place (Phase 3) — the Attendant reads the stream for both sides
- Two-pass retrieval in place (Phase 3)

## Related specs

- [Periodic drift check](periodic-drift-check.md) — the second retrieval trigger, runs independently
- [Bidirectional Attendant](../intelligence/bidirectional-attendant.md) — Attendant handles both triggers
- [Two-pass retrieval](two-pass-retrieval.md) — what happens after the trigger fires
- [Context window observation](context-window-observation.md) — what happens before injection
