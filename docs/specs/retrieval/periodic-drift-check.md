# Periodic drift check

**Status:** template  
**Group:** Retrieval · **Phase:** 3  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

A configurable heartbeat retrieval that fires every N turns, catching slow drift that reactive retrieval misses.

## Why it matters

Gradual context loss does not always announce itself. Reactive retrieval catches the obvious moments — a new entity mention, a topic shift, an explicit reference. It does not catch the slow drift that accumulates over many turns without a clear signal. The periodic check is the backstop.

## How it works

Every N turns (configurable), the Attendant runs a lightweight drift check regardless of what the stream contains. This is not a full retrieval — it compares what iranti knows against what is currently in the context window and surfaces corrections if anything has become stale.

N is configurable. The right default is not yet known and will become clearer through real usage observation.

## User stories

- As a developer in a long session, I want the agent to catch context drift before it causes problems, not just respond to explicit signals.
- As an operator, I want to be able to tune the drift check frequency for different workload types.

## Acceptance criteria

- [ ] The Attendant runs a drift check every N turns, where N is configurable
- [ ] The drift check is lightweight — it does not run a full retrieval, only checks for staleness
- [ ] Corrections are surfaced when stale context is detected
- [ ] The turn counter resets after a drift check fires
- [ ] Drift check events are logged in the session ledger with the correction-to-injection ratio
- [ ] N has a sensible default chosen before Phase 3 ships

## Technical notes

_Fill in when ready to build (Phase 3). Cover: turn counter implementation, what "lightweight" means in practice (scope of the check), default N value and rationale._

## Dependencies

- Attendant retrieval side in place (Phase 3)
- Context window observation in place (Phase 3)
- Session ledger in place (Phase 7) — for logging drift check events

## Open questions

From [§13 of the PRD](../../rough-notes/iranti-core-prd.md#13-open-items):

**Periodic drift check frequency.** The N in "every N turns" is configurable but needs a default. Too low adds overhead for no benefit. Too high lets drift accumulate. The right default will become clear through usage observation, but a starting value needs to be chosen and defended before shipping.

## Related specs

- [Reactive retrieval](reactive-retrieval.md) — the first retrieval trigger; both run simultaneously
- [Context window observation](context-window-observation.md) — runs after drift check retrieval
- [Session ledger](../observability/session-ledger.md) — correction-to-injection ratio is tracked here
- [Usage analytics](../observability/usage-analytics.md) — correction-to-injection ratio is a product metric
