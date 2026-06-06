# Cloud encryption architecture

**Status:** deferred  
**[Back to map](../MAP.md)** · **[PRD §13](../rough-notes/iranti-core-prd.md#13-open-items)**

---

> Explicitly deferred. Must be complete before the cloud account spec can be written, and before any cloud backup code is built.

## What this is

The technical architecture for encrypting iranti memory with user-held keys for cloud backup. The design must solve the fundamental tension: the encryption key is user-held, but the Attendant needs to reason over the content.

## The core constraint

User-held encryption means iranti's servers store ciphertext only. The server cannot read the content. This is the right privacy decision. It creates a real architectural problem: how does the Attendant retrieve and reason over memory if it cannot decrypt it?

## The implication from the PRD

"The architectural consequence of this decision is that server-side intelligent retrieval is not possible on encrypted cloud memory — decryption must happen on the user's side before the Attendant can reason over the content."

This shapes the cloud backup architecture significantly. It likely means:
- The Attendant runs locally and decrypts content locally before retrieval
- The cloud is a backup store, not a live retrieval endpoint
- Sync brings encrypted content down to the local machine first

## Known open questions

- What encryption standard? (AES-256 is the obvious choice — confirm)
- Where is the key stored on the user's machine? (OS keychain, file, derived from password?)
- What happens if the user loses their key? Is there a recovery mechanism, and what are the security tradeoffs?
- Does cross-device sync require the cloud to ever hold decrypted content? If so, how is that managed?
- How are encrypted backups structured? (entire knowledge store as one blob, or individual fact-level encryption?)
- What is the key rotation model?

## Prerequisites before writing this spec

- iranti-core done enough
- Security architecture reviewed and stable
- Legal review of encryption requirements for GDPR compliance in Europe

## Related docs

- [Cloud account](cloud-account.md) — depends on this spec being complete first
- [Security architecture](../technical/security-architecture.md) — the broader security model
- [GDPR compliance](gdpr-compliance.md) — encryption is a core part of GDPR compliance

---

_Come back here when the prerequisites are met._
