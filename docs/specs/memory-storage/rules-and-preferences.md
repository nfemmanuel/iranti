# Rules and preferences

**Status:** template  
**Group:** Memory and storage · **Phase:** 3  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

User-defined rules stored separately from facts, triggered by context rather than retrieved by similarity.

## Why it matters

Agents should follow consistent user preferences without being re-told them each session. Storing rules the same way as facts causes them to compete with facts on retrieval — which was one of the problems with the original iranti. Rules fire when their context matches, not when their content is similar to the current query.

## How rules differ from facts

| | Facts | Rules and preferences |
|---|---|---|
| **Retrieval** | Similarity search | Context-triggered injection |
| **Decay** | Yes — confidence decreases over time | No — rules do not decay |
| **Storage** | knowledge store | Separate rules store |
| **Who creates** | Attendant infers from stream | User defines explicitly (or Attendant detects preference from stream) |
| **When they fire** | When relevant to a query | When the current context matches the rule's trigger condition |

## Examples

- "Always run tests before committing" — fires when the agent is about to commit code
- "Use British English in all documentation" — fires when the agent is writing documentation
- "Prefer functional programming patterns in this project" — fires when the agent is writing code for this project

## User stories

- As a developer, I want my preferences and working rules to apply automatically without repeating them at the start of every session.
- As an agent, I want to receive rule injections at the right moment rather than having rules compete with facts for context window space.

## Acceptance criteria

- [ ] Rules are stored in a separate structure from facts
- [ ] Rules are not subject to memory decay
- [ ] Rules are not retrieved by similarity search — they fire by context match
- [ ] When the Attendant detects a context match, the rule is injected into the agent's context
- [ ] Rules can be associated with a project, a user, or both
- [ ] Rules can be created explicitly by the user and inferred by the Attendant from observed preferences in the stream

## Technical notes

_Fill in when ready to build (Phase 3). Cover: rules schema, trigger condition format, injection mechanism, how the Attendant evaluates context matches._

## Dependencies

- Fact storage in place (Phase 1) — rules use a related but separate storage model
- Attendant write side in place (Phase 3) — Attendant detects preferences in stream
- Attendant retrieval side in place (Phase 3) — Attendant injects rules at context match

## Related specs

- [Fact storage](fact-storage.md) — rules are not facts but live in a related system
- [Bidirectional Attendant](../intelligence/bidirectional-attendant.md) — the Attendant handles rule detection and injection
- [Autonomous write routing](../intelligence/autonomous-write-routing.md) — rules can be written without agent intervention
