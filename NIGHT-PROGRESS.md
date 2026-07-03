# NIGHT-PROGRESS — overnight autonomous build (2026-07-03)

**Mandate:** NF's overnight GO (recorded in iranti memory as `overnight_mandate_active`).
Mission: audit → promote rebuild to `main` (archive-and-swap, NO npm actions) → build all six
pre-YC features on `feat/*` branches, each through the review gauntlet (independent review +
adversarial stress + efficacy vs harness), merge only gauntlet-passed work → morning report at
`docs/reviews/2026-07-03-overnight-build.md`.

**How to resume from a cold start:** read this file top-to-bottom, then `git log --oneline -15`
and `git branch -a`. Every completed unit is committed and pushed; nothing in-flight is ever the
only copy of anything. Continue from the first unchecked item in "Next".

---

## Status: PHASE 3 — Feature 5 (rules & preferences enforcement) in progress

## Done
- [x] Mandate activated + recorded to iranti memory (`overnight_mandate_active`)
- [x] Layer 0 PRD flipped to **accepted** (NF's GO) + added to PRD index
- [x] NIGHT-PROGRESS.md created
- [x] **Phase 1 PASSED** — typecheck 0, lint 0, 103/103 non-DB tests green; doc delta since 6-28
      audit = 7 deliberate verified files, no unaccounted drift; docs secured in `bc8ca6ae`
- [x] **Phase 2 COMPLETE** — tag `pre-cutover-2026-07-03` pushed; `main`→`legacy/prisma-0.4.x`
      (old product preserved, pushed); `iranti-core`→`main`, force-with-lease pushed, tracking
      origin/main. Rebuild is now the default branch content. Note: stale `origin/iranti-core`
      pointer left on remote deliberately (preserve; morning cleanup candidate).

## Done (continued)
- [x] **Feature 1/6 MERGED → main @ `0a545dd1`** — `feat/layer0a-pglite`, 5 commits.
      Zero-infra runtime: PGlite default engine + postgres opt-in; TRANSACTIONAL auto-migrate
      (review BLOCKER fixed); it-runs gate + persistence/restart regression; ALL 14 DB suites
      pass on PGlite (192/192) — full suite now runs with zero infrastructure.
      Gauntlet: independent verification ✅ · fresh-eyes review (1 BLOCKER + 3 MINOR fixed;
      1 MAJOR = no cross-process dir lock, documented follow-up) ✅ · stress battery ✅.
      Extra: latent tx side-effect bug in writeFact found+fixed. Flagged for report:
      `pnpm db:migrate` broken on Node 24 (.js→.ts specifiers) — pre-existing.

- [x] **Feature 2/6 MERGED → main @ `3a590af2`** — `feat/layer0b-harness`, 4 commits.
      Gauntlet: independent verify ✅ (determinism 0.0pp ×2, lint 0, tsc 0) · regression ✅
      (default env = exact 170-ECONNREFUSED baseline; PGlite isolated-dir suites facts 33/33,
      mcp-tools 46/46, graph 18/18) · fresh-eyes review ✅ (0 BLOCKER, 3 MAJOR + 2 MINOR,
      ALL 5 FIXED: scorer slash-truncation, broken --update-baseline flag, 300ms settle race
      → stability poll, embedded NUL bytes, placeholder gold keys) · post-fix gates ✅.
      Metrics live: recall 74.5% / precision 100% / hit-rate 75% / confirmation 53.6% /
      falsePositiveRate 100% (day-one honest no-answer number, from the ai-mem bench lesson).
      Flagged: naive `IRANTI_DB_ENGINE=pglite pnpm test` (all suites, shared dir) is
      unsupported (no cross-process dir lock — known Layer 0a follow-up); a botched such run
      created junk `~/.iranti/db` — preserved, NF should clear before first real boot.
      Build note: builder agent was killed mid-flight by a session interrupt with work
      uncommitted; rescued to `d0b532fb`, finished foreground. PRD-first honored
      (layer-0b-harness.md written before code, now shipped + indexed).

- [x] **Feature 3/6 MERGED → main @ `94303e1e`** — `feat/project-scoping`, 6 commits.
      Folder-scoped projects per Layer 0 D4–D8 + new §11 addendum: migration 0013 (project
      column on facts/rules/edges/media + projects/project_links tables + extended uniques),
      deterministic detection (git-root > Projects-root-child > fallback), reversible
      combine/exclude, 5 iranti_project_* tools, `iranti init` library (bin gap documented —
      Node strip-types). Also repaired pre-existing broken drizzle snapshot chain (0011 dupe,
      0012 missing) — verified cosmetic-to-tooling only, runtime migrate unaffected.
      Gauntlet: independent verify ✅ (37 new tests reproduced; bench 0.0pp; spot suites exact)
      · fresh-eyes review found REAL BLOCKER — factId paths (iranti_history/iranti_archive)
      leaked cross-project reads/archives by raw UUID; reproduced empirically → FIXED
      (effective-scope filtering, out-of-scope ≡ not-found, honest archive result) + 2
      regression tests, which themselves caught a raw-vs-normalized compare bug in the first
      fix ✅ · post-fix: isolation 16/16, facts 33/33, checkpoints 8/8, mcp-tools 46/46,
      bench 0.0pp, tsc/lint 0 ✅.
      Bench earned its keep: scoping initially zeroed harness recall (default-project
      mismatch) — caught by the 0.0pp discipline, fixed by resolveCurrentProject().
      Env note: repo Postgres (iranti-postgres-1, pgvector pg17) now runs on 5435 (worker
      started it via pnpm db:up) — dual-engine verification available; old ECONNREFUSED
      baseline obsolete. Dormant iranti_dev_container untouched net-net.

- [x] **Feature 4/6 MERGED → main @ `cca66390`** — `feat/entity-resolution`, 7 commits;
      baseline advanced @ `a65740dd`.
      Entity resolution (Layer 0c PRD, shipped): entity_aliases table (migration 0014,
      both engines, no override), deterministic quoted-nickname learning (extractAliases),
      exact whole-phrase resolution at attend time, alias surfaces as rank-1
      "alias:<name>" view of the target fact. Project-scoped from birth (leak hunt: clean).
      **EFFICACY — first measured quality improvement in iranti history:
      hit-rate 75.0%→85.7% (+10.7pp), confirmation-rate 53.6%→64.3% (+10.7pp)**,
      extraction + falsePositiveRate 0.0pp, corpus byte-locked, determinism held.
      3 of 4 alias probes flip to rank-1; the 4th (paraphrase, never contains the alias
      phrase) is a disclosed G1 boundary — closing it needs fuzzy matching, forbidden.
      Gauntlet: independent verify ✅ (deltas reproduced exactly) · fresh-eyes review
      (0 BLOCKER — isolation held; 3 MAJOR: same-id alias view fed self-loop co_access
      edges + duplicate corrections, greedy unquoted-aka learned garbage aliases;
      2 MINOR: substring matching lacked word boundaries, equal-length tie was
      physical-row-order nondeterministic — ALL 5 FIXED + 5 regression tests) ✅ ·
      post-fix gates ✅ (extractor 27/27, aliases 17/17, mcp-tools 51/51, isolation 16/16,
      bench +10.7pp held). Baseline regenerated post-merge so Features 5–6 diff against
      the new 85.7/64.3 floor.

## In-flight
- [ ] Feature 5 — `feat/rules-enforcement`: NF's #1 — standing rules injected with
      situational relevance, demonstrably shaping behavior; proven by scripted
      host-simulation + a harness rules metric. Scope doc first.
- [ ] Feature 4 — `feat/entity-resolution`: alias→entity links (the "textbook" fix) → gauntlet → merge
- [ ] Feature 5 — `feat/rules-enforcement`: situational rules & preferences enforcement → gauntlet → merge
- [ ] Feature 6 — `feat/checkpoints`: checkpoint criteria + project-state rollup → gauntlet → merge
- [ ] End-of-night whole-system pass (fresh clone, cold zero-infra boot, integration stress, doc re-audit)
- [ ] Morning report: `docs/reviews/2026-07-03-overnight-build.md`

## Risks / notes
- Full test suite requires Postgres (docker) for DB-backed tests — env has no server; DB suites
  fail ECONNREFUSED (pre-existing env condition, NOT a code failure). Gate = non-DB suites green +
  typecheck + lint; Layer 0a's PGlite work makes the DB suites runnable without docker afterward.
- Phase 2 swap is the night's single sanctioned force-push (`--force-with-lease`), preceded by the
  `pre-cutover` tag; old product fully preserved on `legacy/prisma-0.4.x`.
- NF may check progress from phone: this file + branches are pushed to origin after every unit.
