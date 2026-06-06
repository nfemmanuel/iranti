# Agent registry

**Status:** template  
**Group:** Observability and accounts · **Phase:** 7  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

Agents are registered entities with profiles, stats, and tracked activity.

## Why it matters

Knowing which agent wrote what fact is necessary for source reliability scoring and conflict attribution. Without a registry, "source" is an opaque string. With it, iranti can reason about which agents have proven reliable and which have not.

## What the registry tracks per agent

- Agent id and host type (Claude Code, Codex, SDK, etc.)
- Registration timestamp and last active timestamp
- Session history (session ids the agent participated in)
- Fact contribution stats: total facts written, conflicts won, conflicts lost
- Reliability score (derived from conflict outcomes, used by source reliability scoring)
- Project bindings (which projects this agent has been active in)

## How registration works

At session start, the host registers itself with iranti as part of the handshake. The registration includes: agent id, host type, and any metadata the host provides. If the agent has been seen before, its record is updated. If it is new, a profile is created.

## User stories

- As an operator, I want to see which agents have been most active in a project so that I understand the provenance of stored knowledge.
- As an operator, I want to see an agent's reliability score so that I can understand how much weight its facts carry in conflict resolution.
- As iranti's Librarian, I want to look up the source reliability score for an agent so that I can weight its facts correctly at write time.

## Acceptance criteria

- [ ] Agents are registered at session start as part of the handshake
- [ ] The registry tracks: id, host type, registration time, last active time, session history, fact stats, reliability score
- [ ] `iranti status` includes active agent count and recent agent activity
- [ ] Agent profiles are queryable via CLI or API
- [ ] Reliability scores are accessible to the Librarian for use in conflict resolution

## Technical notes

_Fill in when ready to build (Phase 7). Cover: agent registry schema, how reliability score is derived and updated, how the Librarian accesses the registry at write time._

## Dependencies

- Source reliability scoring in place (Phase 2) — the registry is what reliability scores are stored in
- Handshake in place (Phase 3) — registration happens at handshake time

## Related specs

- [Source reliability scoring](../intelligence/source-reliability.md) — uses agent reliability scores
- [Session grouping](../memory-storage/session-grouping.md) — sessions link to registered agents
- [Bidirectional Attendant](../intelligence/bidirectional-attendant.md) — Attendant performs registration at handshake
