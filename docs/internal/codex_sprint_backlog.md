# Codex Sprint Backlog

This file tracks the current long-form implementation sprint so work stays stateful across tasks.

## Sprint Rules

- Execute roadmap items against the current codebase, not stale assumptions.
- Keep the backlog honest: mark tasks complete if already implemented in `main`.
- Record verification commands and observed outcomes as work proceeds.

## Task Status

| Task | Status | Notes |
|---|---|---|
| 1. Fix DB connection limit blocking temporal tests | Complete | Added dedicated temporal runner with fallback from saturated primary DB to validation DB on `5433`. |
| 2. Temporal conflict tie-breaker | Already Complete | Implemented in current `src/librarian/index.ts`; conflict benchmark already shows temporal `4/4`. |
| 3. Resolutionist role | Complete | Added `iranti resolve`, interactive escalation review, and Resolutionist docs/spec. |
| 4. Cascading conflict detection | Already Complete | Deterministic same-entity cross-key checks are already in current Librarian path. |
| 5. Multi-hop conflict detection | Already Complete | Narrow relationship-aware contradiction checks are already in current Librarian path. |
| 6. CLI chat command | Complete | Added `iranti chat`, runtime env loading, slash commands, and chat docs/spec. |
| 7. Pluggable vector backends | Complete | Added backend interface/factory, pgvector extraction, Qdrant + Chroma REST adapters, doctor checks, docs, and tests. |

## Execution Log

### 2026-03-14

- Read `AGENTS.md` first as sprint context.
- Confirmed clean worktree before starting this sprint.
- Confirmed conflict-related roadmap items 2, 4, and 5 are already implemented beyond the original prompt.
- Identified that Task 1 needs clarification from the codebase itself because there is no standalone temporal test suite under `tests/temporal/`.
- Added `tests/temporal/` with a DB-backed temporal runner and test-specific database fallback logic.
- Confirmed the runner falls back from `DATABASE_URL=...:5432` returning `sorry, too many clients already` to the healthy validation DB on `5433`.
- Regression fix while validating Task 1: made router provider selection dynamic at call time instead of freezing `LLM_PROVIDER` at import time.
- Regression fix while validating Task 1: made smoke-test scripts force mock provider where they rely on LLM behavior.
- Added `src/resolutionist/index.ts` to review pending escalation files interactively and rewrite `AUTHORITATIVE_JSON` in the exact Archivist format.
- Wired `iranti resolve [--dir <escalation-dir>]` into the main CLI and documented it in README, AGENTS, and `docs/guides/conflict-resolution.md`.
- Added `docs/features/resolutionist/spec.md` and re-ran `test:integration`, `test:librarian`, `test:attendant`, and `test:reliability` on the validation database after the Resolutionist changes.
- Added `src/chat/index.ts` and `iranti chat` with slash commands for memory inspection, search, targeted injection, session writes, provider switching, and clean exit handling.
- Added chat docs/specs and updated README/AGENTS CLI surfaces to include the native chat command.
- Verified chat startup against a temporary local server on port `3105` with the mock provider; `/help` rendered successfully.
- Added the pluggable vector backend interface, extracted pgvector support out of `queries.ts`, and added REST-backed Qdrant and Chroma implementations plus backend selection through `IRANTI_VECTOR_BACKEND`.
- Updated `iranti doctor` to report the configured vector backend and whether it is reachable.
- Added `tests/vector-backends/run_vector_backend_tests.ts`; Qdrant and Chroma adapter tests pass, while the pgvector case is intentionally skipped on the local `5433` validation DB because that database does not expose pgvector support.
- Final validation after the sprint:
  - `npx tsc --noEmit`
  - `npm run test:integration`
  - `npm run test:librarian`
  - `npm run test:attendant`
  - `npm run test:reliability`
  - `ts-node tests/temporal/run_temporal_tests.ts`
  - `npm run test:vector-backends`
  - `npm run test:contracts`
- One regression fix during final validation: `scripts/test-reliability.ts` now forces the mock provider just like the other DB-backed smoke suites, preventing ambient provider config from expiring Librarian transactions.
