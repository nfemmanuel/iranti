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

## Status: PHASE 1 — audit & gates (in progress)

## Done
- [x] Mandate activated + recorded to iranti memory (`overnight_mandate_active`)
- [x] Layer 0 PRD flipped to **accepted** (NF's GO) + added to PRD index
- [x] NIGHT-PROGRESS.md created

## In-flight
- [ ] Phase 1: commit pending docs; typecheck + lint + full-suite gates; doc-consistency delta check (since 2026-06-28 audit)

## Next
- [ ] Phase 2: tag `pre-cutover-2026-07-03` + push; archive-and-swap (`main`→`legacy/prisma-0.4.x`, `iranti-core`→`main`); push
- [ ] Feature 1 — `feat/layer0a-pglite`: embedded PGlite engine switch + auto-migrate + it-runs gate → gauntlet → merge
- [ ] Feature 2 — `feat/layer0b-harness`: golden-corpus measurement harness (multi-profile) → gauntlet → merge
- [ ] Feature 3 — `feat/project-scoping`: folder-scoped projects + combine/exclude + `iranti init` → gauntlet → merge
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
