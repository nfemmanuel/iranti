# Cloud account and backup

**Status:** deferred  
**Group:** Observability and accounts · **Phase:** deferred  
**[Back to map](../../MAP.md)** · **[PRD §13](../../rough-notes/iranti-core-prd.md#13-open-items)**

---

> Explicitly out of scope for the initial build. Requires a full privacy and encryption spec before any build starts. High GDPR sensitivity.

## What it is

Optional user account enabling cloud backup of local memory and cross-device sync.

## Why it matters

Gives users portability and resilience. Creates a natural opt-in analytics surface. If a user's machine fails, their accumulated memory is not lost.

## What we know so far

**User-held encryption keys.** For users who back up to cloud, the encryption key is user-held. Iranti's servers store ciphertext and cannot read the content. This gives users full ownership of their data and makes a server-side breach meaningless from a content exposure standpoint.

**Architectural consequence.** Server-side intelligent retrieval is not possible on encrypted cloud memory. Decryption must happen on the user's side before the Attendant can reason over the content. This shapes the cloud backup architecture significantly.

**GDPR.** Cloud accounts introduce significant GDPR exposure. Right-to-deletion, data residency, and the formal data processing agreement all need to be resolved before any build starts.

## Open questions before writing the spec

- What is the client-side decryption flow? How does the Attendant process encrypted remote content?
- What is the key management model? How does the user hold a key without the risk of locking themselves out?
- Does cross-device sync require the cloud to hold decrypted data temporarily?
- What is the billing model for cloud accounts?
- What are the data residency options for European users?

## Prerequisites before writing this spec

- iranti-core done enough
- Cloud encryption architecture spec complete (see [deferred/cloud-encryption.md](../../deferred/cloud-encryption.md))
- GDPR compliance spec complete (see [deferred/gdpr-compliance.md](../../deferred/gdpr-compliance.md))
- Legal review of data processing requirements

## Related specs

- [Cloud encryption architecture](../../deferred/cloud-encryption.md) — must be complete first
- [GDPR compliance](../../deferred/gdpr-compliance.md) — must be complete first
- [Media storage](../memory-storage/media-storage.md) — closely related; media backup likely part of the cloud account
