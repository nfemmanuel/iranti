# PRD: OD-4 — Media Ingest (semantic object storage)

**Status:** shipped
**Phase:** OD-4 (Media track) · **Date:** 2026-06-27 · **Author:** NF + Claude
**Related:** master PRD §13 (open items / media), [decision register](../../decisions/open-decisions.md) OD-4 (Decided) + OD-2, CORE-30 (`media_objects` schema), [attend tool](../../../src/mcp/tools/attend.ts), [facts library](../../../src/library/facts.ts), [GraphBackend](../../../src/graph/index.ts)

> Seeded from an earlier deferred draft at `C:\Users\NF\Documents\Iranti\iranti-core\docs\deferred\media-storage.md` (a pre-iranti-core path, schema-accommodation notes only). That draft predates the CORE-30 `media_objects` table and the OD-4 "build now" decision; it is reconciled against the current schema and decisions here. See Changelog.

---

## 1. Summary
CORE-30 shipped a **hollow** `media_objects` table — an `object_url` pointer and a `description_text` column with **no storage behind it and no read/write path** (schema.ts:610 "Schema-only. No read/write path in Phase 3."). This phase makes media a first-class durable memory: a **StorageBackend abstraction with a local-filesystem backend now and an S3-compatible backend later** (same shape as `GraphBackend` — interface + default local impl, config-gated, mirroring OD-2's local-default/cloud-later posture), plus a **semantic-tagging ingest step** that runs a vision model over each stored object to fill `description_text` + tags. The hard requirement (OD-4 Decided): every object is retrievable *as memory* via its description/tags through the same `iranti_attend` / search path facts use — not dumb blob storage. Justification: media artifacts (e.g. the bug-report screenshots used this session) are durable context.

## 2. Problem & motivation
Master PRD §13 and OD-4 (Decided): agents work with more than text — screenshots, diagrams, documents are real sources of context. Today iranti can store the *pointer* but cannot:
- accept raw bytes and persist them anywhere (no put/get path exists);
- describe an image so it is findable (the `description_text` column is never populated);
- surface a relevant image through retrieval (no media branch in `attend` / `searchFacts`).

Without this, the screenshots a user pastes during a bug report vanish the moment the window scrolls — exactly the durable-memory gap iranti exists to close. OD-4 was overridden from "defer" to "build now" because the present use case is real.

## 3. Goals & non-goals
**Goals**
- A `StorageBackend` interface with a **local-FS backend** that persists raw bytes and returns a stable pointer, structured so an **S3 backend slots in without changing callers** (GraphBackend house style).
- An **ingest pipeline**: raw bytes + mime + entity address → store bytes → vision-describe → write `description_text` + tags into the existing `media_objects` row → make it retrievable.
- A **vision/description step**, local-default (Ollama `llava` / `qwen2.5-vl`), consistent with OD-2; degrades gracefully when unavailable, exactly as the LLM extractor does (extract/index.ts:222).
- **Retrieval surfaces media as memory**: a relevant image appears through `iranti_attend` / search **by its description/tags**, carrying the description + a pointer — never the bytes.
- Config gating via `IRANTI_*` env vars, consistent with `IRANTI_EXTRACTOR` / `IRANTI_EMBEDDINGS`.

**Non-goals**
- Audio transcription and PDF/document text extraction (the seed draft mentions a `transcription` column; **deferred** — this phase is images-first; the mechanism generalizes later).
- Cloud/S3 backend **implementation** (interface-ready now, built when Phase-5 cloud lands — mirrors OD-2/OD-3).
- A frontier **cloud** vision tier (scoped out by the same logic as OD-2/AX-8: local-default now, cloud escalation only on a measured gap).
- Per-object encryption, max-file-size policy, and user-driven deletion UX (seed-draft open questions) — flagged as open questions, not built here.
- Dense **vector** retrieval of media (the `facts.embedding` column is still gated off; media retrieval is keyword-on-description for this phase, see §5).

## 4. Scope
**In**
- `src/media/storage.ts` — `StorageBackend` interface + `LocalFsStorageBackend` (default), selected by env (mirrors `buildExtractor()` / the `graph` singleton).
- `src/media/index.ts` — the ingest pipeline (`ingestMedia(...)`) orchestrating store → describe → persist row.
- `src/media/vision.ts` — `VisionBackend` interface + `LocalLlmVisionBackend` (Ollama, `llava`/`qwen2.5-vl`) + a `NullVisionBackend` fallback; selected by env.
- `src/library/media.ts` — DB read/write helpers over `media_objects` (`writeMediaObject`, `readMediaByEntity`, `searchMedia`), reusing `normalizeKey` for the `key` column (AX-1 boundary rule).
- A media branch in retrieval: `searchMedia` (keyword over `description_text` + tags) and a peripheral/companion surfacing in `iranti_attend` (§5).
- An `iranti_ingest_media` MCP tool (or extension of an existing ingest tool) accepting bytes/path + mime + entity hint + optional key.

**Out (deferred)**
- Audio transcription, document text extraction → a later media sub-phase.
- S3/minio backend impl → Phase-5 cloud (interface is built now).
- Cloud vision tier → only on a measured local-quality gap (OD-2 logic).
- Vector retrieval of media descriptions → when `IRANTI_EMBEDDINGS` graduates from gated to default.
- Escalation-to-bytes policy (when the Attendant returns the actual image, not just the description) → flagged open (§9); this phase always returns description + pointer.

## 5. Design decisions & rationale
Each as **decision → why → alternative rejected**.

- **StorageBackend interface, local-FS default, S3-ready — mirror `GraphBackend`.**
  Methods: `put(bytes, { mime, ext? }) → { ref }`, `get(ref) → bytes`, `delete(ref)`, `resolveUrl(ref) → string`. A module-level `storage: StorageBackend` singleton is imported everywhere (exactly like `export const graph` in graph/index.ts:401 and `export const extractor` in extract/index.ts:250). **Why:** the house style already proves interface-+-default-impl-+-singleton makes the backend swappable by reassignment/DI without touching callers; OD-4 explicitly asks for "the same pattern as GraphBackend." **Rejected:** hard-coding `fs` calls in the ingest path (would weld callers to local disk and force a rewrite for S3).

- **`object_url` holds a backend-resolvable reference, not a raw OS path.**
  For local-FS, `object_url = "file://<relative-path-under-media-root>"` (e.g. `file://default/user/alice/screenshot-login-flow/<uuid>.png`); `resolveUrl()` joins it against the configured media root. For S3 later, the same column holds `s3://bucket/key` and `resolveUrl()` returns a (possibly signed) https URL. **Why:** keep the column backend-portable and avoid leaking absolute machine paths into the DB; the `file://` + relative-path convention means switching backends never rewrites stored rows' *shape*, only their scheme. **Rejected:** storing an absolute filesystem path (non-portable, breaks on machine move and is meaningless to an S3 backend).
  **Windows colon encoding (shipped).** On Windows, `:` is illegal in filesystem paths but valid in semantic keys (e.g. `screenshot:login`). `LocalFsStorageBackend` encodes `:` as `__` in the on-disk path component (e.g. `screenshot:login` → `screenshot__login` in the directory name). The `object_url` stored in the DB reflects this encoding so that `resolveUrl()` can round-trip it correctly. This encoding is local-FS-only; the semantic `key` column in `media_objects` retains the original `:` form (normalized via AX-1 `normalizeKey`, not path-encoded).

- **Files live under a configured media root, addressed by entity + key + uuid.**
  Disk layout: `<IRANTI_MEDIA_ROOT>/<tenant>/<entityType>/<entityId>/<normalizedKey>/<uuid>.<ext>`. **Why:** entity-scoped directories mirror the `media_objects_entity_idx` (tenant, entityType, entityId) and make on-disk browsing/debugging match the logical address; the uuid prevents collisions when the same key is re-ingested. **Rejected:** a flat content-addressed blob store (simpler dedup but loses the human-legible entity layout NF values for auditability per master §2).

- **Ingest = store-then-describe; the vision step is OFF the response path (fire-and-forget), consistent with extraction.**
  `ingestMedia` (1) `storage.put` the bytes and write the `media_objects` row immediately with `description_text = null`, then (2) fire-and-forget the vision call which updates the row with `description_text` + tags. **Why:** this is exactly how `attend` runs extraction — facts are written, then `void (async () => …)()` runs the LLM off the response path (attend.ts:587) so latency is unchanged; a 24s/msg local model (measured, per EA-1 note) must never block the caller. **Rejected:** synchronous describe-before-return (blocks the user on a slow local vision model; the bytes are already safely stored, so the description can arrive moments later).

- **Vision unavailable → degrade, don't fail (mirror the LLM extractor's `catch`).**
  If the vision endpoint is unreachable/times out, the object is still stored with `description_text = null` and a `metadata.visionStatus = "pending"|"failed"` marker; a later re-describe can fill it. **Why:** byte-identical to extract/index.ts:222 ("Endpoint unreachable, timeout, JSON parse error — degrade") — the durable artifact (bytes) is never lost just because the optional enrichment failed. **Rejected:** rejecting the ingest when vision is down (would lose the very artifact we're trying to make durable).

- **Vision model: local-default (Ollama `llava` / `qwen2.5-vl`), cloud deferred — settles the OD-4 sub-decision via OD-2.**
  Default endpoint reuses the Ollama base (`IRANTI_LLM_ENDPOINT`, http://localhost:11434), model via `IRANTI_VISION_MODEL` (default `llava`). **Why:** OD-2 already decided local-default/cloud-opt-in for the LLM tier; media tagging is the same trust/cost/privacy tradeoff, so it inherits the same answer for free. A cloud vision tier is a future AX-8-style escalation only if local tagging quality is measured insufficient. **Rejected:** cloud-default (breaks the free/private/no-signup onboarding OD-2/OD-3 protect).
  **Vision response parsing — `parseLlmJson` (shared, shipped).** The vision backend (`src/media/vision.ts`) parses the Ollama vision model's JSON response using `parseLlmJson` from `src/library/llm-json.ts` (commit 35e4e0a6). This is the same shared helper used by the LLM extractor (AX-2); it strips markdown fences and handles malformed LLM JSON. Using it here keeps the fence-strip fix in one place across both backends.

- **Key scheme: `(entity, normalizeKey(key))`, identical addressing to facts.**
  A media object is addressed exactly like a fact slot — `entity` + a normalized semantic `key` (e.g. `screenshot:login-flow`, `diagram:architecture` per the schema.ts:622 examples). The `key` is passed through `normalizeKey` at the write boundary (AX-1 rule). **Why:** one addressing model across facts and media means retrieval, dedup, and the eventual graph edges all work the same way; AX-1 already mandates normalization at every write/read boundary. **Rejected:** a media-only ad-hoc key format (fragments the addressing model and re-introduces the AX-1 defect for media).

- **Searchability: keyword over `description_text` + tags now; companion-fact and embeddings deferred.**
  `searchMedia` does `ilike` over `description_text` (and a `tags` field in `metadata`) — the same mechanism `searchFacts` uses over `facts.value`/`facts.key` (facts.ts:649-656). Tags are stored in the existing `metadata` jsonb (no new column). **Why:** `description_text` is documented as "plain-text caption/description for keyword retrieval" (schema.ts:623); keyword-on-description reaches retrieval-as-memory with zero new infra. The `facts.embedding` HNSW path is still gated off (`IRANTI_EMBEDDINGS`), so vector media search waits for that to graduate. **Rejected (for now):** writing a **companion fact** (a `media:<key>` fact pointing at the object) — considered, because it would make media fall out of the existing `attend` fact path for free; deferred as an *option* (see §9) because it duplicates the row and risks the FM-1 re-injection class if done carelessly. The chosen path keeps media in its own table and joins it in at retrieval.

- **Retrieval surfaces description + pointer, never bytes.**
  `iranti_attend` gains an optional media tier: when the message keyword-matches a media object's `description_text`/tags for an in-scope entity, the response carries `{ entity, key, description, mime, objectUrl, tags: string[] }` — the **description and a pointer**, not the binary. (`relation?` was specced here but is NOT populated in the shipped code; `tags: string[]` is returned and was omitted from the original spec — see §6 correction.) **Why:** the seed draft's core rule ("retrieval surfaces the description first … escalation to actual media happens when the gap can't be closed") and FM-1 ("never re-inject a verbatim … block") both say the bytes are not injected context; the description is the memory, the pointer is the escape hatch. **Rejected:** embedding image bytes/base64 in the attend response (blows the token budget and violates the description-first contract).

- **Config-gated, additive, mirrors `IRANTI_EXTRACTOR`/`IRANTI_EMBEDDINGS`.**
  `IRANTI_MEDIA_BACKEND` (`local` default | `s3`), `IRANTI_MEDIA_ROOT` (path), `IRANTI_VISION` (`off` default | `local`), `IRANTI_VISION_MODEL`. **Why:** every optional capability in iranti is a config flip, not a migration (the embeddings column note, schema.ts:209: "enabling is a config flip, not a migration"); ingest works with vision `off` (stores bytes, null description). **Rejected:** always-on vision (forces an Ollama dependency on every install).

## 6. Schema / API changes
**Existing columns reused (no migration needed for the core path).** `media_objects` already has everything the ingest pipeline writes (drizzle/0009_hesitant_kulan_gath.sql, schema.ts:625):

| Column | Used for |
|---|---|
| `id` (uuid) | object id |
| `tenant_id` | tenant scope (default `'default'`) |
| `entity_type`, `entity_id` | entity address; backs `media_objects_entity_idx` |
| `key` | semantic slot, normalized via `normalizeKey` (e.g. `screenshot:login-flow`) |
| `object_url` (notNull) | backend-resolvable ref: `file://…` (local) / `s3://…` (later) |
| `mime_type` (notNull) | IANA type, e.g. `image/png` |
| `description_text` (nullable) | vision-generated caption; **null until/if vision runs** |
| `metadata` (jsonb) | **tags** (`metadata.tags: string[]`), `visionStatus`, `visionModel`, `bytes`, `sha256` |
| `created_at` | ingest time |

**New code (no DDL):**
- `StorageBackend` interface + `LocalFsStorageBackend` (`src/media/storage.ts`), `storage` singleton.
- `VisionBackend` interface + `LocalLlmVisionBackend` + `NullVisionBackend` (`src/media/vision.ts`), `vision` singleton.
- `ingestMedia()` pipeline (`src/media/index.ts`).
- `writeMediaObject` / `readMediaByEntity` / `searchMedia` (`src/library/media.ts`).
- `AttendResult` gains an optional `media: Array<{ entity; key; description; mime; objectUrl; tags: string[] }>` field (additive; existing consumers unaffected). **Correction vs spec:** the PRD design in §5 listed a `relation?` field in the media array shape; the shipped code does NOT populate `relation?`. The `tags: string[]` field IS returned by the shipped code but was omitted from the original spec. The actual shipped shape is `{ entity, key, description, mime, objectUrl, tags: string[] }` — no `relation?`.
- New MCP tool `iranti_ingest_media` (bytes-or-path + mime + entityHint + optional key).

**Open / flagged additions (NOT built here):**
- A `tags text[]` column (vs `metadata.tags` jsonb) — **deferred**; jsonb avoids a migration and matches how facts carry `rawKey` in metadata. Flag if tag querying needs a GIN index later.
- A `transcription` column / FK back-reference from `facts` (seed-draft idea) — **deferred** with audio.

## 7. Acceptance criteria
- [ ] `StorageBackend` is an interface with a `LocalFsStorageBackend` default and a module-level `storage` singleton; a test swaps in an in-memory fake backend without changing any caller.
- [ ] `LocalFsStorageBackend.put` writes bytes under `IRANTI_MEDIA_ROOT/<tenant>/<entityType>/<entityId>/<normalizedKey>/<uuid>.<ext>` and returns a `file://`-prefixed relative ref; `get(ref)` round-trips the exact bytes; `resolveUrl(ref)` yields an absolute path/URL.
- [ ] `ingestMedia(bytes, mime, entity, key?)` writes a `media_objects` row **synchronously** (bytes persisted, `object_url`+`mime_type` set, `description_text` null) and returns the row id **before** the vision call completes.
- [ ] The vision/describe step runs **fire-and-forget** (off the ingest return path); when it completes it updates `description_text` + `metadata.tags` on the same row.
- [ ] With vision **unavailable** (endpoint down/timeout), ingest still succeeds: row stored, `description_text` null, `metadata.visionStatus = "failed"` (no throw to caller) — mirrors the extractor's degrade.
- [ ] `key` is stored normalized: ingesting under `Screenshot:Login Flow` and `screenshot:login-flow` addresses the **same** `(entity, key)` slot (AX-1 round-trip parity).
- [ ] `searchMedia(query, {entity})` returns objects whose `description_text` or `metadata.tags` keyword-match the query, scoped to entity when provided (parity with `searchFacts`).
- [ ] `iranti_attend` with a message that matches a stored object's description for an in-scope entity returns it in `media[]` carrying **description + objectUrl + mime + tags**, and **never the raw bytes / base64**. (Shipped shape: `{ entity, key, description, mime, objectUrl, tags: string[] }` — `relation?` not populated; see §6.)
- [ ] Vision is **off by default** (`IRANTI_VISION` unset → `NullVisionBackend`); ingest works with vision off (stores bytes, null description).
- [ ] Backend + vision selection is env-gated (`IRANTI_MEDIA_BACKEND`, `IRANTI_VISION`) with the same fallback shape as `IRANTI_EXTRACTOR`.
- [ ] No new migration is required for the core path (all writes target existing `media_objects` columns); if any column is added it is called out and the migration applies cleanly.
- [ ] Full suite + `pnpm typecheck` + `pnpm lint` green.

## 8. Deltas from the master PRD
None in spirit — this realizes master §13's deferred media item and the schema CORE-30 pre-placed. It **advances** media from "schema-only" (schema.ts:612) to a working ingest+retrieval path. Sequencing delta: OD-4 (Decided) explicitly runs this **parallel to the AX extraction track and does not block AX-1**; this PRD honors that (no dependency on unshipped AX-2…AX-8).

## 9. Risks & open questions
- **Local vision quality / latency.** `llava` on consumer CPU may be slow and produce weak tags. Mitigation: fire-and-forget (never blocks), `visionStatus` allows re-describe, cloud tier deferred to a measured gap (OD-2 logic). **Open:** acceptance threshold for "good enough" tags before a cloud tier is justified.
- **Escalation-to-bytes policy (seed-draft Q).** Who decides when the actual image (not the description) is returned — the Attendant automatically vs an explicit user signal? **Open** — this phase always returns description + pointer; escalation is out of scope. Could not be resolved from code (no existing escalation mechanism for media).
- **Companion-fact vs separate-table retrieval.** Writing a `media:<key>` companion fact would fold media into the existing `attend` fact path for free but risks row duplication and the FM-1 re-injection class. **Open design choice** — chosen path keeps media in its own table; revisit if join-at-retrieval proves awkward.
- **Tag storage (`metadata.tags` jsonb vs `tags text[]`).** jsonb avoids a migration now; a dedicated column + GIN index may be needed if tag filtering becomes hot. **Open** — start jsonb, measure.
- **Deletion & retention.** Archiving a media object should also remove/orphan the on-disk bytes (the never-hard-delete invariant applies to *facts*; media bytes are large and may warrant real deletion). **Open** — deletion UX and the disk-GC story are out of scope here (seed-draft Q).
- **Max file size / encryption** (seed-draft Qs). Not decided; flag a sane `IRANTI_MEDIA_MAX_BYTES` guard in implementation, encryption deferred to the Phase-5 cloud/account model.
- **MIME sniffing / trust.** Caller-supplied `mime_type` should be validated against the bytes (magic-number sniff) to avoid storing a mislabeled or hostile object. **Open** — recommend a lightweight sniff at ingest.

## 10. Verification
- **Unit:** `LocalFsStorageBackend` put/get/delete/resolveUrl round-trip; ref shape; `normalizeKey` applied to media `key`; vision-degrade path (mock unreachable endpoint → null description, `visionStatus=failed`).
- **Integration (against DB):** `ingestMedia` writes the row synchronously + the async describe fills `description_text`/`tags`; `searchMedia` keyword hits on description and tags; `iranti_attend` surfaces a matching media object as description+pointer with no bytes; backend-swap test (in-memory fake) proves callers are backend-agnostic.
- **Smoke:** ingest a real PNG with `IRANTI_VISION=local` against a running Ollama `llava`, confirm a non-null description + tags land and the file exists under `IRANTI_MEDIA_ROOT`; repeat with vision off and confirm graceful null.
- **Gates:** `pnpm typecheck`, `pnpm lint`, full vitest green; if any column is added, migration smoke (apply + idempotent re-run).

## Changelog
- 2026-06-27 — proposed. Seeded from the deferred draft `…/Documents/Iranti/iranti-core/docs/deferred/media-storage.md` (schema-accommodation + open-questions only); reconciled against the shipped CORE-30 `media_objects` table (drizzle/0009, schema.ts:625) and the OD-4 "build now, local-FS, S3-ready, semantically tagged" decision. The seed draft's `media`-table proposal (factId FK, separate transcription column) is superseded by the existing `media_objects` shape; audio/transcription deferred.
- 2026-06-28 — accepted (NF verbal: "Looks good, now implement them")
- 2026-06-28 — shipped: src/media/storage.ts (StorageBackend interface + LocalFsStorageBackend + storage singleton; Windows-safe path encoding replaces `:` with `__`); src/media/vision.ts (VisionBackend + NullVisionBackend + LocalLlmVisionBackend + vision singleton); src/library/media.ts (writeMediaObject, updateMediaDescription, markVisionFailed via jsonb SQL, readMediaByEntity, searchMedia); src/media/index.ts (ingestMedia pipeline — store-then-describe, vision fire-and-forget); src/mcp/tools/ingest-media.ts (iranti_ingest_media MCP tool, bytes or filePath); register.ts wired; attend.ts gains media[] tier (keyword search over description_text/tags, description+pointer never bytes). No new migration (uses existing media_objects). 11 new unit tests (media.test.ts) + 1 Windows path fix. 67/67 green.
- 2026-06-28 — doc corrections: (1) §5 `object_url` decision: Windows colon→`__` path encoding documented (only in changelog previously, now in §5 body); (2) §5 retrieval decision + §6 API changes: AttendResult.media[] shape corrected — `relation?` was specced but NOT implemented; `tags: string[]` IS returned but was omitted from spec; shipped shape is `{ entity, key, description, mime, objectUrl, tags: string[] }`; §7 AC updated to match; (3) §5 vision decision: parseLlmJson (src/library/llm-json.ts, shared with AX-2 extractor) noted.
