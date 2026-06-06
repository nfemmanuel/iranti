# Context window observation

**Status:** template  
**Group:** Retrieval · **Phase:** 3  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

The Attendant checks the current context window before injecting anything, to avoid redundancy and surface corrections.

## Why it matters

Re-injecting what is already present wastes tokens. Letting stale information persist causes drift. The inject-or-stay-silent decision must be relative to what is currently in the window, not absolute.

## How it works

Before any injection, the Attendant reads the agent's current context window state. It compares what it intends to inject against what is already present:

- **Accurate information already present** — stay silent. Re-injection would be redundant.
- **Missing information** — inject it.
- **Stale or inaccurate information** — surface a correction, not an addition.

The host must provide read access to the current context window, or report its state as part of the retrieval request.

## User stories

- As a developer, I want iranti to avoid duplicating context that is already in the agent's window, keeping token usage lean.
- As a developer, I want iranti to correct stale information in the agent's context when it detects a mismatch, rather than silently letting the agent work from wrong assumptions.

## Acceptance criteria

- [ ] The Attendant can read or receive a report of the current context window state before injecting
- [ ] Facts already accurately present in the window are not re-injected
- [ ] Stale or inaccurate facts in the window trigger a correction injection, not a new-fact injection
- [ ] The inject/correct/stay-silent decision is logged in the session ledger
- [ ] The behaviour degrades gracefully if the host cannot provide window state (defaults to inject)

## Technical notes

_Fill in when ready to build (Phase 3). Cover: how hosts report window state, the comparison algorithm, the correction injection format, fallback behaviour._

## Dependencies

- Attendant retrieval side in place (Phase 3)
- MCP tool surface designed (Phase 5) — the MCP surface must expose a way for the host to report window state

## Open questions

From [§13 of the PRD](../../rough-notes/iranti-core-prd.md#13-open-items):

**Context window observation reliability.** The inject-or-stay-silent decision depends on the host surfacing window state. If hosts do not surface this reliably, the Attendant either over-injects (redundant context) or misses corrections (stale context persists). This is a host-integration risk, not an iranti-internal one.

## Related specs

- [Two-pass retrieval](two-pass-retrieval.md) — retrieval happens before observation
- [Bidirectional Attendant](../intelligence/bidirectional-attendant.md) — observation is the Attendant's job
- [MCP host support](../integration/mcp-host-support.md) — hosts must cooperate for this to work
- [Session ledger](../observability/session-ledger.md) — inject/correct/silent decisions are logged
