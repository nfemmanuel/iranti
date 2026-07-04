# Protocol: Extraction Measurement — With/Without LLM (feeds the extraction-tier PRD)

**Status:** proposed (protocol, not a build PRD)
**Date:** 2026-07-04 · **Author:** NF + Claude
**Related:** OD-1 (LLM is in the floor — decided), OD-2 (local default, cloud gated on measured gap — decided), AX-8 (escalation tier, gated on THIS measurement), AX-4/AX-3 (guardrails whose design this evidence informs), `research/nvidia-nim-free-api` (NVIDIA = measurement tool only). NF ruling: "benchmark the new iranti with and without the llm and see where that gets us."

---

## 1. Question under measurement

Three regimes over the SAME corpora (main corpus + AX-10 fabrication corpus):

| Regime | Extractor | What it answers |
|---|---|---|
| R0 | heuristic only (today's default) | the floor (current baseline) |
| R1 | heuristic + local LLM (Ollama, pinned small model) | is local good enough? (OD-2's open half) |
| R2 | heuristic + frontier LLM (Anthropic API; NVIDIA NIM free tier as secondary comparator — synthetic corpus only, no private data) | how much does frontier buy over local? (AX-8's gate) |

Metrics per regime: extraction recall / precision / fabricationRate (the AX-10-expanded one), plus per-class breakdown on the fabrication probes (which classes does each LLM fix or worsen?). Retrieval metrics recorded but expected ~flat (extraction-side experiment).

## 2. Method rules

- Corpus is untouched across regimes (byte-locked); only `IRANTI_EXTRACTOR` + endpoint env vary.
- LLM regimes are NOT part of the deterministic default bench; they run via a separate invocation (`IRANTI_EXTRACTOR=local pnpm bench` already exists as a mode; frontier needs only an OpenAI-compatible endpoint override pointed at the provider — the existing `LocalLlmExtractor` speaks that shape) with N=3 repeats to expose nondeterminism, reporting per-run numbers AND variance, never a cherry-picked run.
- The extraction cache (AX-2) must be BYPASSED or cold per run (fresh IRANTI_DATA_DIR per persona already gives this) so repeats measure the model, not the cache.
- Grounding-gate PREVIEW measurement: for every LLM-extracted fact, record post-hoc whether its value appears verbatim (normalized substring) in the source message — this measures how much an AX-4 gate WOULD keep, before building it.
- Output artifact: `docs/reviews/<date>-extraction-measurement.md` — the evidence table + a recommendation section; the extraction-tier build PRD cites it.

## 3. Prerequisites — TWO REQUIRED CODE CHANGES (PRD-review BLOCKERs, both verified) plus environment

**Code change 1 — harness must respect the extractor env.** `runPersonaIngest` unconditionally sets `IRANTI_EXTRACTOR="heuristic"` (ingest.ts:119), so `IRANTI_EXTRACTOR=local pnpm bench` today has ZERO effect — the draft's "already exists as a mode" claim was false. Work item: the harness defaults to heuristic only when the env is unset; when set to `local`, it runs the LLM path through the SAME corpus+scorer+baseline machinery (apples-to-apples with R0), and the byte-determinism assertion is REPLACED for that invocation by the N=3 variance report (§2) — determinism stays asserted in heuristic mode only. The repo's existing extraction-eval scripts sample real transcripts, bypass the harness entirely, and are NOT a substitute for R1/R2.

**Code change 2 — auth header support.** `LocalLlmExtractor`'s fetch sends no Authorization/x-api-key header at all (extract/index.ts:270-283), so R2 cannot run against Anthropic or NVIDIA regardless of endpoint config. Work item: optional `IRANTI_LLM_API_KEY` env; when set, send both `Authorization: Bearer <key>` and `x-api-key: <key>` (covers OpenAI-compat providers incl. Anthropic's compatibility endpoint and NIM's bearer style; harmless where ignored). Never logged, never cached into the extraction-cache regime signature as plaintext.

Both changes are small, land in Stage 3e BEFORE any measurement run, and go through the normal review gate.

**Environment (blockers to record, not work around):**
- R1: Ollama running locally with the pinned model pulled (model id recorded in the report; qwen2.5:3b is the code default — revisit at run time).
- R2: a LIVE Anthropic API key from NF (the bench/.env key was flagged for revocation — confirm with NF; never scrape for secrets). NVIDIA NIM key optional (NF signup) as a free secondary frontier point.
- If an environment leg is missing at run time: run the available regimes, record the blocked leg explicitly, do not fake or skip silently.

## 4. Decision this evidence gates

The extraction-tier build PRD (AX-4 grounding gate + AX-3 constrained decoding + which default posture to recommend NF between Ollama-upgrade-path vs BYOK-upgrade-path vs regex-only-default). If R1 ≈ R2 on recall with acceptable fabrication: local-only recommendation, AX-8 stays unbuilt. If R2 ≫ R1 on the hard classes: the friction/cloud conversation reopens with numbers.

## Changelog
- 2026-07-04 — proposed (wave-1 mandate; runs in Stage 3e, env-permitting)
- 2026-07-04 — PRD review applied (verdict was REWORK, both feasibility holes confirmed): §3 rewritten around the two required code changes (harness env-respect with determinism-assertion carve-out; auth header support). "Already exists as a mode" claim retracted.
