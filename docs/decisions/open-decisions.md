# Open Decisions Register

**Process (instituted 2026-06-12).** Large or hard-to-reverse decisions get written here
*before* we act on them, then reviewed **one at a time** so we weigh the full option space
instead of defaulting into a choice. Each entry has context, options, a current lean, and a
status. When a decision closes, move it to **Decided** with the rationale.

This register supersedes the ad-hoc "Pending decisions" table in
`docs/engineering/implementation.md` — migrate those rows here as they come up.

---

## Stated principles (clarified, not open)

- **The system is deterministic; the LLM need not be.** Storage, retrieval, conflict
  resolution, decay, and key handling are pure/deterministic (this is *why* iranti is on
  Postgres, not NoSQL). The LLM is confined to the single fuzzy step — turning messy text
  into clean slots. "Same result every time" is engineered at the **store layer**, not the
  model. (Clarified 2026-06-12; was implicit before.)

---

## Open decisions

### OD-1 — Should the extraction floor include an LLM at all?
- **Context:** A/B test (2026-06-12) showed the deterministic regex floor finds ~0 facts on
  real conversation; the old system used an LLM and found 3–13/message. The "universal
  deterministic floor" premise is empirically broken.
- **Options:** (a) LLM extraction floor (local Ollama default) + deterministic downstream;
  (b) keep regex-only floor (rejected by evidence); (c) hybrid — deterministic fast-path for
  trivially-structured signals (URLs, paths, explicit `key: value`) + LLM for everything else.
- **Lean:** (c). **Status:** ✅ **DECIDED 2026-06-12 → (c) hybrid** (see Decided below).

### OD-2 — Is local-only (Ollama) quality good enough, or is a cloud tier required?
- **Context:** Workflow verdict — local is good for ~80–90% *with* schema-decoding + temp 0 +
  seed; not frontier-quality on the hard ~10% (implicit facts, corrections/negations,
  calibrated confidence, cross-turn key consistency). User concern: 10% uncertainty compounds
  over long projects.
- **Options:** (a) local-only; (b) local default + opt-in cloud-escalation for hard cases;
  (c) cloud default.
- **Lean:** (b). **Status:** ✅ **DECIDED → (b) local default + opt-in cloud escalation** (see Decided below).

### OD-3 — New-user API-key barrier / cloud provisioning
- **Context:** Requiring users to bring/pay for an API key is an onboarding barrier.
- **Options:** (a) do nothing now — local Ollama default means no key is needed to start
  (recommended); (b) iranti-hosted cloud extraction (we provision + meter); (c) BYO-key required.
- **Lean:** (a). **Status:** ✅ **DECIDED → defer; Phase-5 trigger + additive transition** (see Decided below).

### OD-4 — Object storage backend for media (CORE-30)
- **Context:** `media_objects.object_url` is a pointer column; there is **no** storage
  integration (no S3/minio/upload path) — confirmed 2026-06-12.
- **Options:** local filesystem, S3-compatible (self-host minio / AWS), or defer.
- **Lean:** ~~defer~~ → **build now** (user override; real use case). **Status:** ✅ **SHIPPED 2026-06-28** — local-FS backend, S3-ready abstraction, vision semantic tagging, `iranti_ingest_media` MCP tool, `AttendResult.media[]` tier → [od4-media-ingest](../prds/phases/od4-media-ingest.md) (see Decided below).

### OD-5 — Does AX-2's SHA-256 message hash satisfy the §11 behavioral-data-only constraint?
- **Context:** AX-2 (content-hash extraction cache, shipped 2026-06-28) stores a SHA-256 hash
  of raw message text in the cache key. The audit flagged a possible tension with master §11.
- **Options:** (a) hash is behavioural metadata; (b) hash is content-derived and violates §11;
  (c) distinguish by scope: in the user's instance = fine; in developer telemetry = violates §11.
- **Status:** ✅ **DECIDED 2026-06-28 → (c), via a scope correction.** §11 governs **developer
  telemetry only** — what the organization collects from users (anonymous behavioural metadata,
  never content). It does **not** govern the user's own instance, which stores their facts,
  conversation-derived slots, and media in full — locally and (Phase 5) in their own cloud backup.
  `extraction_cache` (the hash **and** the cached `ExtractedFact[]`) is user-instance data and is
  fully allowed; it sits beside facts the user already owns. **Invariant:** neither the hash nor any
  fact content may ever enter the telemetry/analytics path — `attend_log` and all org-collected
  metrics stay behavioural-only, including cloud-account-derived analytics for opted-in users.
  Recorded in master §11 ("Two data planes, never crossed") + AX-2 PRD §6/§9. The audit's original
  framing (and the AX-2 draft's open question) over-read §11 as a blanket no-content-storage rule.

---

## Augmentation experiments (extraction/retrieval hardening)

**Rule:** nothing ships unless a test proves it improves the current system and does not just
add resource-eating clutter. Each gets its own spec + measured before/after, taken piece by piece.
Source: workflow `wf_3fbabf0d-ae1` (24 proposals, 1 refuted), 2026-06-12.

| # | Experiment | Why | Verify metric | Status |
|---|------------|-----|---------------|--------|
| AX-1 | `normalizeKey` at write/read boundary (**keystone**) | store-layer determinism + reliable exact lookup; both old & new match raw key today | distinct-keys-per-entity drops; conflict-detection hits rise on a fixed transcript | ✅ **shipped 2026-06-26** → [ax-1-key-normalization](../prds/phases/ax-1-key-normalization.md) |
| AX-2 | content-hash extraction cache | replay/re-ingest determinism (byte-identical on repeat) | cache-hit reproducibility = 100% on repeated inputs | ✅ **shipped 2026-06-28** → [ax-2-content-hash-cache](../prds/phases/ax-2-content-hash-cache.md) |
| AX-3 | schema-constrained decoding + closed category enum | parse-failure → ~0; structural variance gone | parse-failure rate → 0 on a corpus | not started |
| AX-4 | grounding gate (verbatim-span check) | every stored LLM fact must quote the source → kills hallucination | 0 stored facts with no source span | not started |
| AX-5 | exact-`(entity,key)`-first retrieval tier | honors exact-lookup-over-vector; deterministic top tier | rank-of-exact-hit = 1 when a key is named | not started |
| AX-6 | golden-corpus reproducibility gate in CI | turns "reproducible" into a measured, enforced number | heuristic byte-identical; LLM repro-rate tracked | not started |
| AX-7 | transient-vs-durable fact gate | stop storing volatile facts (`typecheck_status=clean`) | 0 stored VOLATILE-pattern facts | not started |
| AX-8 | cloud-escalation tier | frontier call only on hard ~10% (depends on OD-2/OD-3) | escalation cost scales with hard-case fraction, not volume | not started |

---

## Explored alternatives (considered, not pursued)

### EA-1 — Parameter-based / trained memory (memory as model weights / LoRA) — not the substrate
**Idea (NF, 2026-06-26):** instead of storing facts as DB rows + injecting them, train a small neural
net / LoRA adapter that bakes project knowledge into **weights**, for "intuitive recall," context-token
savings, and pattern generalization.
**Verdict — not the memory substrate.** It trades away the three guarantees iranti is built on:
- **Determinism & correctability:** a fact in a row can be inspected, edited, superseded, deleted; a
  fact in weights cannot be surgically removed (catastrophic forgetting), and the store is opaque —
  directly against master §2 "transparent and auditable" + human override.
- **Host/model portability:** a LoRA is welded to one base model's weights; it does not transfer
  Claude↔Codex↔Gemini. Memory-as-weights breaks the cross-host portability that is iranti's point.
- **Cost/latency & local-first:** backprop is GPU-heavy and slow vs millisecond DB writes; continuous
  local training on consumer CPU hardware (our target — we measured ~24s/msg just for inference) is
  impractical today.
**The real kernel we already capture:** the "generalize / synthesize my preferences" benefit comes from
the **LLM at the extraction/retrieval edges** (OD-1 hybrid) — the model generalizes intent into clean
slots; the store stays deterministic. Best of both, without the opacity.
**Where it could fit later (narrow):** a far-future, *optional* per-user personalization adapter sitting
**alongside** the deterministic store (never replacing it) — consistent with "LLM at the edges,
deterministic core." Revisit only on a measured need the deterministic store cannot meet.

---

## Failure modes to guard against (observed in old v0)

Concrete bugs seen in the running old `iranti@0.4.1` that iranti-core must NOT reproduce.

### FM-1 — Injection / response-echo loop
**Symptom (observed, with screenshots):** the old server re-uploads the same prompt on
successive turns and the model re-answers it repeatedly; in a worse variant a prior **assistant
response block** is re-injected verbatim at the *start* of later prompts and keeps echoing.
**Root cause (inferred):** treating conversational output (a whole response) as if it were
durable memory and re-surfacing it, with no dedup against what is already in the live window.
**Design constraints for iranti-core:**
- A response is **not** a durable fact — never store or re-inject a verbatim response block.
  Store only **extracted slots** (key/value), behind AX-7 (transient-vs-durable gate).
- **Dedup injected content against the live context window** (Phase 1.2 suppression) so nothing
  already present is re-injected.
- **Watch CORE-32 specifically:** iranti-core already extracts from `currentContext` (the turn
  payload incl. the assistant response) as `attendant_autowrite@0.70`. That path must run through
  the durable-slot gate + dedup or it can recreate FM-1. Add a golden-corpus regression that
  feeds a prior response back in and asserts **no verbatim re-injection and no loop**.
- **CORE-32 IRANTI_ENFORCE blocking** (protocol enforcement for handshake/attend cycle): **deferred** — not built in the current cycle. Needs its own spec before build.
- **CORE-16 hybrid pgvector search** (retrieval path): schema scaffolding only as of 2026-06-28; the retrieval path itself is **deferred**.

---

## Decided

### OD-1 — Extraction floor includes an LLM → **(c) hybrid** (2026-06-12)
**Decision:** the extraction floor is a **deterministic fast-path** for trivially-structured
signals (URLs, file paths, explicit `key: value`/slots) **plus an LLM** for genuine
conversational extraction.
**Rationale:** measured this session on the same 50 real messages — regex heuristic 0,
old mock 0, LLM (Haiku) 3–13/msg, local qwen2.5:7b 133 (47/50). Deterministic
pattern-matching does not generalize to real language; only an LLM does, so (b) was off the
table. (c) beats (a) because trivial structured cases stay deterministic/free and never spend
an LLM call — which honors the determinism principle more, not less.
**Scope:** settles only that an LLM is *in the floor*. Does NOT decide local-vs-cloud (OD-2)
or which guardrails ship (AX-*). Determinism stays downstream (store + resolution + normalizeKey).

### OD-2 — LLM tier → **(b) local default + opt-in cloud escalation**
**Decision:** local Ollama is the **default** extraction model (free, private, no signup); a
frontier **cloud tier is opt-in and off by default**, firing only on deterministically-flagged
hard cases (low confidence, corrections/negations, dense-message-yielding-nothing). We are
**not** cloud-default.
**Rationale:** measured — local has excellent recall (47/50) and ~50% raw precision that the
guardrails (not model size) fix; local matches a mid-tier cloud model but not frontier on the
hard ~10% (corrections, implicit facts). (a) local-only would silently miss those high-value
corrections (the compounding-uncertainty risk); (c) cloud-default breaks free/private/no-signup
onboarding. (b) keeps the default free + private and folds the cloud tier into the Phase-5
"accounts get more" model.
**Scope / does NOT commit:** the cloud tier is **not built now** — ship local + guardrails
first (AX-1/4/7), measure the residual hard-case miss rate against the golden corpus, and add
escalation (AX-8) **only if the data proves a real gap**. Which cloud model + exact triggers
are deferred to AX-8.

### OD-3 — New-user API-key barrier → **defer, with a defined Phase-5 trigger + additive transition**
**Decision:** do not build keyless-user cloud provisioning now — local Ollama default already
removes the barrier (no key needed to start).
**When we solve it:** at **Phase 5** when accounts + cloud-sync land, or earlier if we choose to
offer hosted cloud extraction as a paid tier.
**How the transition stays smooth (by design):** the local store is *always* the source of truth;
auth gates only the cloud/sync layer (per the Phase-5 vision). A user who starts keyless + local
and later signs up keeps their local KB unchanged — cloud becomes an **opt-in additive layer**
(sync + cloud-escalation), never a migration. Nothing is lost; the only change is enabling the
cloud layer for that account. Building toward this now = keep the storage/extraction interfaces
clean so the cloud layer slots on top without touching the local store.
**Trigger to revisit:** Phase 5 accounts, or a decision to monetize hosted extraction.

### OD-4 — Media object storage → **SHIPPED 2026-06-28** (local-FS, S3-ready, semantically tagged)
**Decision (user override of "defer"):** build object storage **now** — a local filesystem
backend behind an S3-ready abstraction — because there is a real present use case: media
artifacts are durable memory (e.g. the bug-report screenshots used this session). Hard
requirement: every object is **properly semantically tagged** (description + tags + key) so it is
retrievable *as memory*, not dumb blob storage.
**What shipped:**
- A storage abstraction (interface) with a **local-FS backend**, **S3-compatible later** —
  same pattern as `GraphBackend`, mirroring OD-2 (local default, cloud later).
- A **semantic-tagging step**: vision-model description + tags → `description_text` + tags into
  `media_objects` columns, making media retrievable as memory.
- `iranti_ingest_media` MCP tool; results surface in `AttendResult.media[]`.
- Code: `src/media/`, `src/library/media.ts`, `src/mcp/tools/ingest-media.ts`.
**Commits:** initial implementation 16ee3916; hardening 991ce3bf, 35e4e0a6, c59e608c.
**Spec:** [od4-media-ingest](../prds/phases/od4-media-ingest.md).
**Remaining deferred:** S3-compatible cloud backend; audio transcription at ingest.
