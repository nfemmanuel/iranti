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
- **Lean:** (c). **Status:** OPEN — confirm after the empirical local-quality test.

### OD-2 — Is local-only (Ollama) quality good enough, or is a cloud tier required?
- **Context:** Workflow verdict — local is good for ~80–90% *with* schema-decoding + temp 0 +
  seed; not frontier-quality on the hard ~10% (implicit facts, corrections/negations,
  calibrated confidence, cross-turn key consistency). User concern: 10% uncertainty compounds
  over long projects.
- **Options:** (a) local-only; (b) local default + opt-in cloud-escalation for hard cases;
  (c) cloud default.
- **Lean:** (b). **Status:** OPEN — measure local quality empirically (Ollama install pending)
  before deciding. Note: strong guardrails (OD-experiments below) reduce the cost of the 10%.

### OD-3 — New-user API-key barrier / cloud provisioning
- **Context:** Requiring users to bring/pay for an API key is an onboarding barrier.
- **Options:** (a) do nothing now — local Ollama default means no key is needed to start
  (recommended); (b) iranti-hosted cloud extraction (we provision + meter); (c) BYO-key required.
- **Lean:** (a) now; revisit (b) at the Phase 5 cloud-sync milestone (ties to the existing
  "accounts get cloud sync" vision). **Status:** OPEN but NOT urgent — local-first already
  removes the barrier.

### OD-4 — Object storage backend for media (CORE-30)
- **Context:** `media_objects.object_url` is a pointer column; there is **no** storage
  integration (no S3/minio/upload path) — confirmed 2026-06-12.
- **Options:** local filesystem, S3-compatible (self-host minio / AWS), or defer.
- **Lean:** defer until the media-ingest spec. **Status:** OPEN — not needed until the media phase.

---

## Augmentation experiments (extraction/retrieval hardening)

**Rule:** nothing ships unless a test proves it improves the current system and does not just
add resource-eating clutter. Each gets its own spec + measured before/after, taken piece by piece.
Source: workflow `wf_3fbabf0d-ae1` (24 proposals, 1 refuted), 2026-06-12.

| # | Experiment | Why | Verify metric | Status |
|---|------------|-----|---------------|--------|
| AX-1 | `normalizeKey` at write/read boundary (**keystone**) | store-layer determinism + reliable exact lookup; both old & new match raw key today | distinct-keys-per-entity drops; conflict-detection hits rise on a fixed transcript | not started |
| AX-2 | content-hash extraction cache | replay/re-ingest determinism (byte-identical on repeat) | cache-hit reproducibility = 100% on repeated inputs | not started |
| AX-3 | schema-constrained decoding + closed category enum | parse-failure → ~0; structural variance gone | parse-failure rate → 0 on a corpus | not started |
| AX-4 | grounding gate (verbatim-span check) | every stored LLM fact must quote the source → kills hallucination | 0 stored facts with no source span | not started |
| AX-5 | exact-`(entity,key)`-first retrieval tier | honors exact-lookup-over-vector; deterministic top tier | rank-of-exact-hit = 1 when a key is named | not started |
| AX-6 | golden-corpus reproducibility gate in CI | turns "reproducible" into a measured, enforced number | heuristic byte-identical; LLM repro-rate tracked | not started |
| AX-7 | transient-vs-durable fact gate | stop storing volatile facts (`typecheck_status=clean`) | 0 stored VOLATILE-pattern facts | not started |
| AX-8 | cloud-escalation tier | frontier call only on hard ~10% (depends on OD-2/OD-3) | escalation cost scales with hard-case fraction, not volume | not started |

---

## Decided

_(none yet — close decisions here with date + rationale as we work through them)_
