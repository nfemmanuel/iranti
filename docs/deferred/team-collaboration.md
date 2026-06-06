# Team collaboration

**Status:** deferred  
**[Back to map](../MAP.md)** · **[PRD §13](../rough-notes/iranti-core-prd.md#13-open-items)**

---

> Explicitly deferred. Requires the access grant and delegation model from [security architecture](../technical/security-architecture.md) to be fully designed first.

## What this is

Multiple users writing to a shared project namespace. Team members share accumulated memory about a project, with appropriate access controls governing who can read, write, and manage the namespace.

## Why it matters

iranti's value compounds on teams. When multiple developers work on the same project, the knowledge accumulated from one developer's sessions is immediately available to others. Decisions made, approaches that failed, constraints established — shared instantly across the whole team without anyone having to explain them.

## What we know from the PRD

- Access is enforced at the namespace level (`project/projectId/`)
- The namespace owner can grant and revoke read or write access
- The rules governing who else can grant access, delegation, and finer-grained permission tiers are deferred until real use cases make the requirements clear
- When a team member leaves a project, their access is revoked and subsequent requests fail with an access error

## Known open questions

- Can a team member grant access to another team member, or is only the owner allowed?
- What happens to facts written by a team member after their access is revoked — are they kept or archived?
- Are there permission tiers beyond read/write? (e.g. can-view-archive, can-resolve-conflicts, can-manage-access)
- Who is the initial owner of a project namespace — the person who creates it?
- How do teams manage shared vs. personal memory in the same project? Can a user keep some facts project-private?

## Prerequisites before writing this spec

- iranti-core done enough and used by at least one multi-person team
- Access grant and delegation model designed and reviewed (see [access-control.md](../technical/access-control.md))
- Real use cases from actual team usage

---

_Come back here when the prerequisites are met and there are real team use cases to design against._
