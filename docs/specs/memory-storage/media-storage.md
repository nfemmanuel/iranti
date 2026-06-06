# Media storage

**Status:** deferred  
**Group:** Memory and storage · **Phase:** deferred  
**[Back to map](../../MAP.md)** · **[PRD §13](../../rough-notes/iranti-core-prd.md#13-open-items)**

---

> This feature is explicitly out of scope for the initial build. The schema should accommodate it from the start even though it ships later. A full spec must be written before build begins.

## What it is

Images, documents, and audio stored in object storage with metadata and a generated description in the knowledge base.

## Why it matters

Agents work with more than text and iranti should extend to everything the user shares. Documents, diagrams, screenshots, and voice recordings are all potential sources of context that currently fall outside iranti's reach.

## What we know so far

**Storage model:** Media files go to object storage (e.g. S3). The knowledge base holds the metadata and a generated text description for each item — not the media itself.

**Retrieval model:** The description and metadata surface first on retrieval. The Attendant escalates to the actual media under two conditions:
1. The user signals dissatisfaction with what the description provided
2. The Attendant judges the information gap cannot be closed without the real content

**Audio:** Audio requires transcription at ingest time to be searchable.

**Schema:** The schema must accommodate media from the start, even though media storage ships later. See [schema](../../technical/schema.md).

## Open questions before writing the spec

- Who decides when to re-inject actual media vs. just the description — the Attendant or an explicit user action?
- How does audio transcription integrate at ingest time — synchronous or async?
- What are the LLM call costs at ingest for generating descriptions?
- Which object storage provider is in scope for the initial media build?
- How does media interact with the cloud account and encryption model?

## Prerequisites before writing this spec

- iranti-core done enough (§13 of the [iranti-core PRD](../../rough-notes/iranti-core-prd.md))
- Cloud account spec complete — media storage likely lives alongside cloud backup
- Object storage provider decision made

## Related specs

- [Fact storage](fact-storage.md) — media metadata is stored as facts
- [Cloud account](../../deferred/cloud-account.md) — media and cloud backup are closely related
