# GDPR compliance

**Status:** deferred  
**[Back to map](../MAP.md)** · **[PRD §13](../rough-notes/iranti-core-prd.md#13-open-items)**

---

> Explicitly deferred. Required before any commercial deployment in Europe or any cloud account launch. Requires legal review.

## What this is

The implementation and documentation required to operate iranti in compliance with GDPR (General Data Protection Regulation) for users in the European Union.

## Why it matters

Any commercial deployment in Europe requires GDPR compliance. The cloud account, if it ever exists, requires it regardless of region — European users will use it. Non-compliance is a legal and reputational risk.

## What the PRD requires

- Right-to-deletion implementation at the fact level — users can request removal of specific stored information. The schema must support this from the start.
- Formal GDPR data processing agreement (DPA) template for commercial deployment.
- Data residency considerations for European users.

## What we know

**Schema support.** The fact schema must support explicit deletion at the fact level. "Deletion" in iranti's archive model means: the content is removed but a tombstone record remains (so the system knows a deletion happened without knowing what was deleted). The schema must accommodate this from Phase 0 even though full GDPR compliance ships later.

**Analytics.** Usage analytics must never include session content. Only behavioural metadata crosses the wire. This constraint is already built into the analytics design.

**Cloud account.** The cloud account introduces the highest GDPR exposure. Data residency, the right to be forgotten, and the data processing agreement all apply most acutely there.

## Known open questions

- What constitutes a "fact deletion" in the archive model — tombstone, full removal, or content nullification?
- What is the data residency model for European users? (EU-hosted infrastructure, or data transfer mechanisms?)
- What does the DPA template need to cover for iranti's specific data model?
- Who is the Data Controller and who is the Data Processor in the iranti + user relationship?
- What are the required data retention limits?
- How does a user submit a right-to-deletion request through iranti?

## Prerequisites before writing this spec

- Cloud account spec underway (GDPR exposure is highest there)
- Legal review from a GDPR-qualified counsel
- Data residency infrastructure decisions made

## Related docs

- [Cloud account](cloud-account.md) — highest GDPR exposure point
- [Cloud encryption architecture](cloud-encryption.md) — encryption is part of GDPR compliance
- [Security architecture](../technical/security-architecture.md) — the broader security model
- [Usage analytics](../specs/observability/usage-analytics.md) — must comply with GDPR

---

_Come back here when the prerequisites are met and legal review has started._
