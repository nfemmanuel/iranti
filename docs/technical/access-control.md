# Access control

**Status:** template  
**Needed by:** Phase 5  
**[Back to map](../MAP.md)**

---

## Purpose

Define the entity namespace model, permission grants, and delegation rules for iranti-core. This is separate from the broader [security architecture](security-architecture.md) because access control has enough complexity to deserve its own document.

## The namespace model

Facts are addressed by entity type and entity id. Access is granted at the namespace level: `entityType/entityId/`. An agent with access to `project/iranti/` can see any fact in that namespace.

### Three ownership categories

| Namespace pattern | Owner | Default access |
|---|---|---|
| `user/<userId>/` | The user | That user and their agents only |
| `project/<projectId>/` | The project owner | Owner and explicitly granted agents |
| `system/` | iranti | No external access |

### What "access" means

- **Read access** — the agent can retrieve facts from this namespace
- **Write access** — the Attendant can route writes to this namespace on the agent's behalf
- Revocation takes effect immediately at the API layer

## Permission grants (v1)

The initial model is simple:
- A namespace owner can grant or revoke read and write access for another user or agent
- No delegation in v1 — access grants are flat (owner only grants)

## Deferred: team collaboration access model

The following are deferred until real team use cases make requirements clear:
- Who else (besides the owner) can grant access
- Access delegation (user A can grant access that user B holds)
- Fine-grained permission tiers beyond read/write
- What happens when a team member leaves a project

See [team collaboration](../deferred/team-collaboration.md).

## Enforcement

Access is enforced at the API layer. Every API request is checked against the permission model before any query runs. A request to a namespace without access receives:
- An access error (not a "namespace not found" — the error is honest)
- No knowledge from that namespace

The [session ledger](../specs/observability/session-ledger.md) records access denials.

## Questions to resolve before implementing

- How are permission grants stored? (separate table, or on the entity record?)
- What is the exact error format for access denial?
- How is namespace ownership established? (who is the first owner of a project namespace?)
- How does revocation propagate to active sessions?

## Related docs

- [Security architecture](security-architecture.md) — the broader security model
- [Team collaboration](../deferred/team-collaboration.md) — multi-user access design (deferred)
- [Session ledger](../specs/observability/session-ledger.md) — access denials are logged
