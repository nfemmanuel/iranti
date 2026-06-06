# Protocol enforcement

**Status:** template  
**Group:** Observability and accounts · **Phase:** 7  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

Configurable enforcement of the handshake and attend turn cycle.

## Why it matters

Hosts that skip the protocol produce degraded memory behaviour. If a host does not call the handshake at session start, the Attendant never gets its operating rules. If a host does not run the attend cycle each turn, the periodic drift check never fires. Enforcement catches this early and makes the problem visible rather than silently degrading.

## The protocol

The correct cycle per session:
1. **Handshake** at session start — load operating rules, build working memory brief, register agent
2. **Attend (pre-response)** each turn before the agent responds — retrieval triggers, context window check, injection
3. **Attend (post-response)** each turn after the agent responds — write routing, ledger event

A host that skips any step breaks the memory cycle for that turn or session.

## Enforcement levels

| Level | Behaviour |
|---|---|
| **Off** | No enforcement. Protocol violations are ignored silently. |
| **Warn** | Protocol violations are logged to the session ledger. No request is blocked. |
| **Enforce** | Protocol violations return an error. The host must fix the violation before proceeding. |

The default is `warn`. The level is configurable per project.

## User stories

- As an agent builder, I want iranti to warn me when my integration skips the protocol so that I can catch integration errors during development.
- As an operator, I want to enforce the protocol strictly in production so that hosts that skip it fail loudly rather than silently degrading memory quality.

## Acceptance criteria

- [ ] Protocol enforcement is configurable at three levels: off, warn, enforce
- [ ] Violations are logged to the session ledger regardless of enforcement level
- [ ] In enforce mode, a skipped handshake returns an error that prevents further interaction for that session
- [ ] In warn mode, a skipped attend call is logged but the session continues
- [ ] `iranti status` shows the current enforcement level for the project
- [ ] The default enforcement level is `warn`

## Technical notes

_Fill in when ready to build (Phase 7). Cover: violation detection implementation, error format for enforce mode, how enforcement level is stored and read per project._

## Dependencies

- Handshake in place (Phase 3)
- Session ledger in place (Phase 7)

## Related specs

- [Session ledger](session-ledger.md) — violations are logged here
- [Bidirectional Attendant](../intelligence/bidirectional-attendant.md) — the protocol is the Attendant's turn cycle
- [MCP host support](../integration/mcp-host-support.md) — MCP hosts must conform to the protocol
