# Autonomous write routing

**Status:** template  
**Group:** Intelligence · **Phase:** 3  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

The Attendant decides what from the stream is worth storing and routes it to the Librarian without agent intervention.

## Why it matters

Consistent memory decisions across all hosts require iranti to own that judgment. If the agent drives writes, different agents make different decisions about what to store and when — producing an inconsistent, incomplete knowledge store. The Attendant taking over this responsibility is one of the defining features of the rebuild.

## How it works

The Attendant reads everything that passes through the session stream — user messages, agent responses, tool calls, file contents, anything the host surfaces. It classifies content as either signal (worth storing) or noise (not worth storing). Signal is routed to the Librarian. Noise is discarded.

The signal/noise distinction is iranti's most consequential quality judgment. The Attendant must make it well:
- **Too conservative** — the knowledge store is sparse and recall suffers
- **Too aggressive** — the store fills with low-value facts and retrieval becomes noisy

## What counts as signal

- Decisions made (architectural, technical, process)
- Constraints established (must use X, cannot do Y, deadline is Z)
- Approaches that failed (tried X, it did not work because Y)
- User preferences expressed (I prefer functional patterns, always run tests before committing)
- Key facts from shared files or documents
- Task summaries and significant milestones

## What counts as noise

- Idle chatter and pleasantries
- Confirmations and acknowledgements ("ok", "got it", "sounds good")
- Redundant re-statements of already-stored facts
- Internal agent reasoning that produces no durable output

## User stories

- As a developer, I want iranti to automatically capture decisions and constraints from my sessions without my having to explicitly tell it to remember something.
- As an agent builder, I want the write path to work the same way regardless of which host is in use, so that memory behaviour is consistent across my product.

## Acceptance criteria

- [ ] The Attendant reads the full session stream on the write side
- [ ] Signal is classified and routed to the Librarian without any agent intervention
- [ ] Noise is discarded without writing
- [ ] The signal/noise classification is logged in the session ledger (classification reason, not content)
- [ ] The write path produces consistent results across different host types

## Technical notes

_Fill in when ready to build (Phase 3). Cover: stream access mechanism, classification model (rule-based vs. LLM-based vs. hybrid), what constitutes a "write call" to the Librarian, how this interacts with the Librarian's write path._

## Dependencies

- Librarian write path in place (Phase 2)
- Attendant stream access in place (Phase 3)

## Open questions

From [§13 of the PRD](../../rough-notes/iranti-core-prd.md#13-open-items):

**Attendant write-routing quality.** If the Attendant misclassifies too much as noise, the knowledge store is sparse. If it routes too much as signal, the store fills with low-value facts. This is the most consequential quality question in the whole system and will require real usage data to tune.

**What exactly counts as the stream.** Does it include tool call outputs? File contents read by the agent? Only messages and responses? The answer affects what the Librarian receives and how much it has to filter.

## Related specs

- [Bidirectional Attendant](bidirectional-attendant.md) — write routing is the Attendant's write side
- [Conflict detection](../lifecycle/conflict-detection.md) — Librarian handles conflicts on what the Attendant routes
- [Session ledger](../observability/session-ledger.md) — routing decisions are logged
