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

## Status: PHASE 3 — Feature 3 (folder-scoped projects) in progress

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

## In-flight
- [ ] Feature 3 — `feat/project-scoping`: folder-scoped projects + combine/exclude + `iranti init`
      (Layer 0 PRD D4–D8 are the contract; adversarial cross-project isolation tests mandatory)
      → gauntlet → merge
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
