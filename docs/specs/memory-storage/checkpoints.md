# Checkpoints

**Status:** template  
**Group:** Memory and storage · **Phase:** 3  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

Compressed task summaries written at meaningful session moments.

## Why it matters

Allows session recovery and faster bulk context retrieval than assembling the same picture from dozens of individual fact lookups. Checkpoints carry forward from the original iranti unchanged — they worked well and the model is sound.

## How they work

The Attendant writes a checkpoint at meaningful moments in a session: at the end of a task, when the session is about to be interrupted, or when the Attendant detects that enough has happened to warrant a compressed summary.

A checkpoint contains:
- A summary of the task state at the moment of writing
- A reference to the session and agent that produced it
- Key facts that were active at the time, for fast retrieval
- Enough context for another session or agent to resume from this position

When context about a whole task is needed, retrieving a single checkpoint is faster than assembling the equivalent from dozens of individual fact lookups.

## User stories

- As a developer, I want to resume a task in a new session without having to re-explain what was being worked on.
- As a developer, I want a new host or model to be able to pick up from where the previous session left off.
- As an agent, I want to retrieve a checkpoint to get a bulk summary of task state without running N individual fact retrievals.

## Acceptance criteria

- [ ] The Attendant can write a checkpoint at any point in a session
- [ ] A checkpoint is written automatically at meaningful session moments (end of task, session interruption)
- [ ] A checkpoint can be retrieved to restore task context in a new session
- [ ] Retrieving a checkpoint is faster than retrieving the equivalent individual facts
- [ ] Checkpoints are associated with a session and an agent
- [ ] Checkpoints are not subject to memory decay — they are fixed summaries

## Technical notes

_Fill in when ready to build (Phase 3). Cover: checkpoint schema, when the Attendant decides to write one, retrieval path, relationship to individual facts._

## Dependencies

- Fact storage in place (Phase 1)
- Attendant retrieval side in place (Phase 3)

## Related specs

- [Fact storage](fact-storage.md) — checkpoints reference facts
- [Bidirectional Attendant](../intelligence/bidirectional-attendant.md) — the Attendant writes checkpoints
- [Session grouping](session-grouping.md) — checkpoints are session-scoped
