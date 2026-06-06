# Cloud account

**Status:** deferred  
**[Back to map](../MAP.md)** · **[PRD §13](../rough-notes/iranti-core-prd.md#13-open-items)**

---

> Explicitly deferred. Do not start building until the cloud encryption and GDPR specs are complete. High GDPR sensitivity.

## What this is

Optional user account enabling cloud backup of local memory, cross-device sync, and a richer analytics surface for opted-in users.

## Why it matters

- Users who switch machines or lose their device lose all accumulated memory without cloud backup
- Cross-device sync enables iranti on multiple machines to share the same knowledge
- Cloud accounts create a natural opt-in analytics surface (more detailed than anonymous telemetry)
- This is the foundation for any future paid product tier

## What we know from the PRD

- Encryption key is user-held. Iranti's servers store ciphertext only.
- Server-side intelligent retrieval is not possible on encrypted backups — decryption must happen client-side.
- This architectural constraint shapes the whole cloud design significantly.
- GDPR compliance is required before this ships commercially in Europe.

## Known open questions

- What is the client-side decryption flow? How does the Attendant process encrypted remote content?
- What is the key management model? How does the user hold a key without risk of locking themselves out?
- Does cross-device sync require the server to hold decrypted content temporarily for sync operations?
- What is the billing model?
- What are the data residency requirements for European users?
- How does a user delete their account and all associated data?

## Prerequisites before writing this spec

- iranti-core done enough and in real production use
- [Cloud encryption architecture](cloud-encryption.md) spec complete
- [GDPR compliance](gdpr-compliance.md) spec complete
- Legal review of data processing requirements

---

_Come back here when the prerequisites are met._
