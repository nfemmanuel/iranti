# Overnight Autonomous Build — Morning Report

**Date:** 2026-07-03 · **Mandate:** NF's overnight GO (six pre-YC features, gauntlet-gated)
**Outcome: ALL SIX FEATURES BUILT, GAUNTLET-PASSED, AND MERGED TO `main`. Nothing unmerged. `main` green and pushed at every step of the night.**

---

## 1. Headline

By morning, iranti went from "rebuild on a side branch, boots only with Docker Postgres" to:

- **Boots anywhere with nothing but Node** (embedded PGlite, transactional auto-migrate) — re-proven this morning from a *fresh clone* on a cold install.
- **Measures itself**: `pnpm bench` prints 7 deterministic metrics against a checked-in baseline. Every number below is reproducible byte-for-byte.
- **First measured quality improvement in its history**: entity resolution moved retrieval hit-rate **75.0% → 85.7%** and confirmation-rate **53.6% → 64.3%** (+10.7pp each), corpus locked, instrument untouched.

Current baseline (what Features 7+ will diff against):

| Metric | Value | Meaning |
|---|---|---|
| extraction recall | 74.5% | heuristic-only floor; LLM tier + pattern work raise it |
| extraction precision | **100%** | the deterministic extractor invents nothing — the thesis, in a number |
| retrieval hit-rate | **85.7%** | after entity resolution (+10.7pp) |
| confirmation-rate | **64.3%** | "confirm, don't discover" KPI (+10.7pp) |
| no-answer false-positive rate | 100% | honest bad number; the target for a future thresholding feature (lesson from the external ai-mem bench of 0.4.1) |
| rule relevance rate | 81.3% | honest number after review de-tautologized the probes (was a meaningless 100%) |
| rule noise rate | **0%** | rules never fire on irrelevant turns |

## 2. Per-feature record

### F1 — Layer 0a: zero-infra runtime · MERGED `0a545dd1` (`feat/layer0a-pglite`, 5 commits)
Engine switch in `connection.ts` (PGlite default, Postgres opt-in), transactional auto-migrate, it-runs gate, persistence-across-restart regression. All 14 formerly-Postgres-only suites pass on PGlite (192/192).
**Gauntlet:** review 1 BLOCKER (non-transactional migrate could brick a data dir on crash — fixed) + 3 MINOR fixed + 1 MAJOR accepted follow-up (no cross-process dir lock; one host = one process per PRD D3). Stress: cold-boot ×3, restart persistence, migrate idempotency, postgres-precedence. Bonus: builder found and fixed a latent process-wedging bug (writeFact side effects inside its own open transaction).

### F2 — Layer 0b: measurement harness · MERGED `3a590af2` (`feat/layer0b-harness`, 4 commits)
Golden-corpus runner: 4 authored personas (overfitting guard), real attend()/write() paths on fresh PGlite stores, deterministic (zero LLM), `pnpm bench`, checked-in baseline.
**Build incident:** the background builder was killed mid-flight by a session interrupt with its work *uncommitted* — rescued as `d0b532fb`, finished foreground. Mid-build scope addendum from the ai-mem external bench: 8 negative "no-answer" probes + `falsePositiveRate` metric, so the 0.4.1 failure mode (5/5 confident wrong answers on trick queries) is measured here from day one.
**Gauntlet:** review 3 MAJOR + 2 MINOR, all fixed — highlights: a `split("/", 2)` bug that would silently zero recall for slash-containing entity ids; embedded NUL bytes making git treat `ingest.ts` as binary; the fixed 300ms settle-sleep replaced with a stability poll to protect the determinism assertion on slow machines.

### F3 — folder-scoped projects · MERGED `94303e1e` (`feat/project-scoping`, 6 commits)
Migration 0013 (dedicated `project` column — never tenantId — plus registry + reversible combine/exclude), deterministic detection (git-root → Projects-root child → fallback), 5 `iranti_project_*` tools, `iranti init` library. Also repaired a pre-existing broken drizzle snapshot chain that silently blocked all future migrations.
**Gauntlet:** review found a REAL cross-project leak the 14 adversarial tests missed — `iranti_history`/`iranti_archive` accepted raw fact UUIDs unfiltered (read another project's fact + history, or archive it, by id alone). **Reproduced, then closed before merge**: out-of-scope ids are now indistinguishable from nonexistent ones. The regression tests caught a second bug in the first version of the fix (raw-vs-normalized project compare). The harness also caught its first live bug here: scoping briefly zeroed harness recall (default-project mismatch) — visible instantly as a bench delta.

### F4 — entity resolution ("the textbook fix") · MERGED `cca66390` (`feat/entity-resolution`, 7 commits)
`entity_aliases` (migration 0014), deterministic quoted-nickname learning, exact whole-phrase resolution at attend time, alias surfaces as rank-1 `alias:<name>` view. Project-scoped from birth.
**Efficacy:** hit-rate +10.7pp, confirmation +10.7pp; 3 of 4 alias probes flip to rank-1. The 4th (a paraphrase never containing the alias phrase) is a disclosed G1 boundary — closing it needs fuzzy matching, which the determinism thesis forbids.
**Gauntlet:** review 0 BLOCKER (no leak), 3 MAJOR + 2 MINOR all fixed: same-id alias views were feeding self-loop edges into the knowledge graph and duplicate corrections; a greedy unquoted-`aka` pattern could learn garbage aliases forever; substring matching lacked word boundaries ("the doc" fired inside "the docker file"); equal-length ties were physical-row-order nondeterministic.

### F5 — rules & preferences enforcement (NF's #1) · MERGED `884f1b7d` (`feat/rules-enforcement`, 7 commits)
Deterministic token-overlap situational relevance (shared tokenizer with facts), critical-priority (≥100) bypass, budget of 5, zero schema change, backward compatible. Proven two ways: harness rules metrics + scripted host-simulation (surface-when-relevant / silent-when-not / deactivate / cross-project fails-closed / restart persistence).
**Gauntlet's defining moment:** the reviewer proved the day-one **100% relevance score was a probe-authorship artifact** — every "paraphrase" probe secretly kept an exact rule keyword; independently-written realistic phrasings missed 2 of 3. Fixed by making the *instrument* honest: 4 low-overlap HONEST-CAPABILITY probes are now permanent fixtures, and the shipped number is **81.3%** — the true capability of keyword-overlap relevance, with the gap now measurable for a future synonym layer. Also surfaced: a real production hang (below, RULE-2).

### F6 — checkpoints & project-state · MERGED `c96ab0de` (`feat/checkpoints`, 6 commits)
Stage/status metadata on checkpoints (enum + free text in `facts.metadata`, no migration), `getProjectState()` rollup (latest checkpoint + recent decisions + open issues + last activity, derived entirely from existing tables), `iranti_project_state` tool, first-attend-after-gap surfacing (gap injectable for tests).
**Gauntlet:** the only review of the night with 0 BLOCKER *and* 0 MAJOR. 5 MINOR, all fixed: deterministic id tiebreakers, mid-turn latch guard, 300-char field caps (payload rides outside attend's budget accounting), stdio-only surfacing guarantee documented, and the 4 stage-round-trip tests the PRD had promised. The builder also honestly corrected the brief: the mandate's "AX-7 status-as-checkpoint-tag" mislabels the register (real AX-7 = transient-vs-durable gate); design grounded in `checkpoints.ts`'s own note, discrepancy documented as PRD Decision 0.

## 3. End-of-night whole-system pass — GREEN
Fresh `git clone` of `main` → cold `pnpm install` → **it-runs zero-infra boot 1/1** → persistence 1/1 → **bench: all 7 metrics 0.0pp, byte-deterministic, from the clone** → host-simulation 3/3 → projects-isolation 16/16. Host-portability (G2) and determinism (G1) hold from a pristine copy.

## 4. Judgment calls made on NF's behalf
1. **Phase 2 swap executed as sanctioned** (tag `pre-cutover-2026-07-03`, `main`→`legacy/prisma-0.4.x`, `iranti-core`→`main`, single force-with-lease). No npm actions of any kind. Stale `origin/iranti-core` remote pointer deliberately left (cleanup candidate).
2. **Interrupted builder's uncommitted work rescued** as a WIP commit and finished foreground rather than relaunching a user-stopped agent.
3. **ai-mem bench lessons folded in mid-flight** (negative probes + falsePositiveRate) — small scope addendum, judged in-mandate.
4. **Baseline advancement policy:** regenerated on `main` at each merge that moves numbers, so every feature's delta prints once, cleanly, and the next feature diffs against the new floor.
5. **Instrument honesty over headline numbers** (F5's 100%→81.3%) — treated as the product thesis applied to ourselves.
6. **Feature 3's UUID leak treated as automatic gauntlet failure** and fixed pre-merge per the mandate's trust-bug rule.
7. A worker briefly started the wrong dormant Docker container (`iranti_dev_container`, 33 seconds, clean exit — net-zero change) before starting the repo's own `iranti-postgres-1` for dual-engine verification.

## 5. Flagged for NF (action/decision needed)
- **🔑 Revoke the temp Anthropic key** from the ai-mem bench session (in that transcript + its `bench/.env`). *Security; do first.*
- **Delete junk `~/.iranti/db`** before your first real zero-infra boot (created by a botched concurrent test invocation of mine; preserved per no-hard-delete).
- **Docker:** `iranti-postgres-1` (this repo's compose DB) is still running — keep for dual-engine dev or `docker stop` it; `iranti-bench-db` from the ai-mem session also still up.
- **Remote cleanup candidate:** stale `origin/iranti-core` branch pointer.
- **Pre-existing, not fixed tonight:** `pnpm db:migrate` broken on Node 24 (strip-types can't resolve `.js`→`.ts`); `extraction-cache.test.ts` has one failing case against real Postgres (verified pre-existing on the base commit).
- **Tracked follow-ups (docs/backlog.md):** RULE-1 tokenizer short-token floor (rules about "S3" can't match on "S3"); **RULE-2 teardown hang — real production risk** (host shutting down immediately after a turn on PGlite can hang forever); Layer 0a cross-process dir lock; no-answer thresholding (the falsePositiveRate-100% target).
- **Parked discussion (your request):** subagent memory presence, mid-turn attend cost, protocol token economy — recorded in iranti memory with three pre-split threads.
- **Cutover items (daytime, yours):** npm publish/rename decision, `iranti init` bin wiring (needs build output), version 0.5.0-vs-1.0 call.

## 6. Recommended review order
1. `bench/baseline.json` + run `pnpm bench` yourself — the whole story is in the numbers printing on your machine.
2. `src/db/connection.ts` — the engine switch + transactional auto-migrate (everything rests on it).
3. `src/tests/projects-isolation.test.ts` — the trust property, including the closed UUID leak.
4. `src/library/aliases.ts` + `src/library/rules.ts` — the two deterministic relevance engines.
5. `src/library/project-state.ts` + host-simulation tests — the "where did we leave off?" behavior.
6. The five layer PRDs (0, 0b, 0c, 0d, 0e) — every decision, pivot, and honest limitation is on the record there.

## 7. Review-gauntlet totals
6 features · 6 independent fresh-eyes reviews · **2 BLOCKERs, 8 MAJORs, 13 MINORs found — every one fixed before merge or explicitly tracked with an ID.** Two of the night's most important findings (the UUID cross-project leak, the tautological rules metric) were invisible to the builders' own green test suites — the gauntlet earned its cost.
