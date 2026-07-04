# Dogfood Remediation Build — Report

**Date:** 2026-07-04 · **Branch:** `feat/dogfood-remediation-1` (pushed, **not merged** — merge is NF's call)
**Mandate:** NF — "document, review, implement, review, test, report," for the FAIL/PARTIAL findings of [the dogfood eval](2026-07-04-dogfood-iranti-next.md). NF rulings folded in: host-authored text stays extracted but provenance-labeled/demoted; the assumptions-profile idea registered as OD-6, not built.

## Pipeline as executed

| Stage | Artifact | Outcome |
|---|---|---|
| Document | 3 PRDs ([AX-9](../prds/phases/ax-9-extraction-honesty.md), [0h](../prds/phases/layer-0h-rule-correctability.md), [0i](../prds/phases/layer-0i-correction-supersession.md)) + OD-6 registered | proposed, code-grounded |
| Review 1 (PRDs, fresh eyes) | AX-9 REWORK, 0h/0i ACCEPT-WITH-EDITS | all edits applied before code; two real traps caught (D5 misdescribed attend's single call site; the corpus format could not express "must extract nothing") |
| Implement | commits `d5c899b6` (instrument red) → `7639566c` (AX-9) → `3c637aee` (0h) → `25c1fbd9` (0i) | red-first: fabricationRate printed 100% before the fix, 0% after |
| Review 2 (code, fresh eyes) | 0 BLOCKER / 1 MAJOR / 3 MINOR | all fixed in `1183460e`; the MAJOR (stale placeholder golds) unmasked a further +3.7pp recall |
| Test | 84/84 across the four remediation suites; full-suite triage: remaining failures = parallel-contention flakes + one extraction-cache case **verified pre-existing on base `36986ee2` via worktree** | zero branch regressions |
| Report | this file + PRD changelogs + baseline advanced (`bcf32be6`, `1183460e`) | — |

## Scoreboard movement (all measured, byte-deterministic ×2)

| Metric | Before | After | Why it moved |
|---|---|---|---|
| **fabricationRate (new)** | 100% (8/8) | **0.0%** | bare-noun `decision:`/`constraint:`/`requirement:` patterns replaced with sentence-initial labels; the live negation-fabrication incident sentence is now a permanent corpus probe |
| extraction recall | 74.5% | **79.6%** | +1.4pp em-dash/bare-path golds flipping; +3.7pp from recomputing two placeholder gold keys whose own notes demanded it (code-review catch) |
| extraction precision | 100% | 100% | held — now WITH fabrication probes watching |
| confirmation-rate | 64.3% | **67.9%** | unplanned: the bare `constraint` pattern had been fabricating a junk fact from backend msg 7 ("unique **constraint alone** but it didn't work") whose key tokens outranked the real gold on the idempotency probe. The fabrication vector was actively corrupting retrieval rank in the shipped baseline. |
| hit / falsePositive / rules metrics | — | 0.0pp | untouched, as designed |

## What each dogfood finding got

1. **Invented negation fact (check 3, FAIL)** → pattern surgery + `host_summary_extract`@0.70 provenance branch (two-sided test) + a permanent fabrication dimension in the instrument. The harness can now *see* this failure class; it couldn't before.
2. **Bare relative paths invisible (check 4 caveat)** → `BARE_RELATIVE_PATH_PATTERN` (≥2 segments + extension, boundary-hardened after review); alias learning now reaches path-referenced artifacts (unit-proven).
3. **Rules uncorrectable (check 6)** → `iranti_rules_list` / `iranti_rule_deactivate` / `iranti_aliases_list` / `iranti_alias_archive`; `deactivateRule` library-scoped (the unscoped form was an unshipped F3-class leak, caught while grounding the PRD). The check-6 deactivate→silent leg now runs and passes.
4. **Corrections don't supersede (checks 8/10)** → deterministic containment supersession (`superseded_by_correction`, history preserved, ambiguity/no-candidate no-op) + rollup merges `correction:*` into `recentDecisions`. Disclosed honestly: under-matching on paraphrased corrections is the dominant expected miss; the LLM tier is the sanctioned path to close it.
5. **Em-dash sentences extract nothing (check 2 root cause)** → dashes joined the clause-terminator class; NF's actual writing style now extracts (the PGlite sentence is a unit fixture).

## Standing items for NF

- **Merge decision:** branch is gauntleted and pushed; nothing merged to `main`. `dogfood/report-1` (the eval report) is its base — merging `feat/dogfood-remediation-1` brings both.
- **One dogfood-store cleanup:** the live store's pre-existing `correction:the-eval-branch-name` / stale-decision pair predates 0i's write-time hook — archive the stale decision manually (one `iranti_archive` call) after merge, per PRD 0i §9.
- **OD-6 (assumptions profile)** is registered with options sketched, awaiting its own PRD if you want it.
- Pre-existing, untouched: extraction-cache's environment-dependent test case (fails on base too), parallel-run PGlite contention flakes.
