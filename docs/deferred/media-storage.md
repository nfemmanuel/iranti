# Media storage

**Status:** deferred  
**[Back to map](../MAP.md)** · **[PRD §13](../rough-notes/iranti-core-prd.md#13-open-items)**

---

> Explicitly deferred. Schema should accommodate media from the start even though it ships later. A full spec is required before build begins.

## What this is

Images, documents, and audio stored in object storage (e.g. S3) with metadata and generated descriptions stored in the knowledge base.

## Why it matters

Agents work with more than text. Documents, diagrams, screenshots, code files, and voice recordings are all sources of context that should be storable and retrievable through iranti.

## What we know from the PRD

- Media files go to object storage. The knowledge base holds metadata and a generated text description — not the media itself.
- Retrieval surfaces the description first. Escalation to actual media happens when:
  1. The user signals dissatisfaction with the description
  2. The Attendant judges the information gap cannot be closed without the real content
- Audio requires transcription at ingest time to be searchable.
- The schema must accommodate media from the start even though it ships later.

## Open questions before writing this spec

- Who decides when to escalate to actual media — the Attendant automatically, or an explicit user signal only?
- How is audio transcription integrated at ingest? Synchronous (blocks write) or asynchronous (description comes later)?
- What are the LLM call costs for generating media descriptions at ingest?
- Which object storage provider is in scope for the initial media build?
- How does media interact with the cloud account and encryption model — are media files encrypted separately?
- What is the maximum media file size?
- How does a user request deletion of specific media?

## Schema accommodation

Even though media storage ships later, the schema should include:
- A `media` table with: id, factId (FK), objectStoragePath, mimeType, description, transcription (nullable), ingestedAt
- The `facts` table should support a `mediaId` reference

See [schema.md](../technical/schema.md).

## Prerequisites before writing this spec

- iranti-core done enough
- Cloud account spec complete (if media will be cloud-backed)
- Object storage provider decision made

---

_Come back here when the prerequisites are met._
