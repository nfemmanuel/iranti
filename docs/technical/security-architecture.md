# Security architecture

**Status:** template  
**Needed by:** Phase 5  
**[Back to map](../MAP.md)**

---

## Purpose

Define the security model for iranti-core: access control, encryption at rest and in transit, PII handling, and the audit trail. This document is the source of truth for security decisions. Anything not covered here is not in scope for the initial build.

## What iranti must protect

Iranti stores memory — decisions, preferences, constraints, and context accumulated over time. This is among the most sensitive data a person generates while working with AI agents. The security model must treat it accordingly.

## Access control

Memory is organised into entity namespaces. Access is enforced at the namespace level, not at the individual fact level.

Three natural ownership categories:
- **Personal memory** — user's own entity namespace. Only that user and their agents can access it.
- **Project memory** — project entity namespace. Namespace owner can grant and revoke read/write access for other users and their agents.
- **System memory** — belongs to iranti. Not accessible to external agents or users.

Access is enforced at the API layer. A request to a namespace without access returns an error. Revoked access takes effect immediately.

**Deferred:** Access grant delegation, who can grant access, finer-grained permission tiers. See [access control](access-control.md).

## Encryption

**In transit:** All API communication over HTTPS. No plaintext transmission.

**At rest (local):** Local iranti stores are not encrypted by default in v1. The user's operating system's disk encryption is the assumed baseline.

**Cloud backup (deferred):** User-held encryption keys. Iranti's servers store ciphertext only. Server-side intelligent retrieval is not possible on encrypted backups — see [cloud encryption architecture](../deferred/cloud-encryption.md) for the full design.

## PII and data minimisation

Iranti stores what it observes in sessions. Some of that will include PII. The system does not need to detect or redact PII automatically in v1, but:
- The schema must support explicit deletion at the fact level (right to deletion)
- Users can request removal of specific stored information
- This is required for GDPR compliance when the cloud account launches

Usage analytics must never include session content. Only behavioural metadata crosses the wire.

## API authentication

- API keys for all external access
- Session-scoped tokens for host registration
- CLI uses local credentials

_Design the full authentication model here._

## Audit trail

The [session ledger](../specs/observability/session-ledger.md) provides a permanent record of all staff events. Separate from the knowledge store, not subject to decay.

## Open items for future specs

- Detailed access grant and delegation model for team projects → [team collaboration](../deferred/team-collaboration.md)
- Cloud encryption architecture → [cloud-encryption.md](../deferred/cloud-encryption.md)
- Right-to-deletion implementation at the fact level → [GDPR compliance](../deferred/gdpr-compliance.md)
- Formal GDPR data processing agreement

## Related specs

- [Access control](access-control.md) — detailed permission model
- [Cloud encryption architecture](../deferred/cloud-encryption.md) — cloud-specific encryption
- [GDPR compliance](../deferred/gdpr-compliance.md) — right to deletion and compliance
