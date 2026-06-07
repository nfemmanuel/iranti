# Testing strategy

**Status:** draft  
**[Back to map](../MAP.md)**

---

## Purpose

Define how iranti-core is tested: what kinds of tests are written, where they live, what they cover, and what counts as enough coverage to ship a phase.

## Testing philosophy

- Tests verify behaviour, not implementation. If a refactor breaks a test without changing behaviour, the test was wrong.
- Every feature spec has acceptance criteria. Those criteria are the acceptance tests.
- Tests are written alongside the code they test — not after the fact.
- Unit tests are fast. Integration tests are thorough. End-to-end tests are the final sanity check.

## Test types

### Unit tests

- Test one function or module in isolation
- Fast — no database, no network, no external dependencies
- Dependencies are mocked or stubbed
- Live alongside the code: `src/<feature>/<file>.test.ts`
- Run on every save in development

### Integration tests

- Test a feature end-to-end through the API
- Require a running PostgreSQL instance (Docker Compose in development and CI)
- Test the full flow: write → read → query → archive
- Live in `tests/integration/`
- Run before every PR merge

### End-to-end tests

- Test a complete agent session scenario
- Multi-session projects: facts written in session 1 are retrieved in session 2
- Rules fire correctly when a preference is triggered
- Session interruption followed by backfill produces correct state
- Live in `tests/e2e/`
- Run before each phase is marked complete

## What to test per phase

| Phase | Key tests |
|---|---|
| **1: Library** | Write a fact, read it back, archive it, query by entity and session |
| **2: Librarian** | Write conflicting facts, verify resolution or escalation; query graph edges |
| **3: Attendant** | Full bidirectional session — retrieval and write routing without agent intervention |
| **4: Archivist** | Full maintenance cycle — decay applied, escalation processed correctly |
| **5: MCP** | End-to-end Claude Code session; multi-session project scenario |
| **6: CLI/SDK** | CLI commands return correct output; SDK example builds and runs |
| **7: Observability** | Session ledger has correct events; telemetry pipeline active |

## Coverage

- 100% coverage is not the goal — meaningful coverage of feature behaviour is
- Every acceptance criterion from a feature spec should have at least one test
- Critical paths (write path, conflict resolution, retrieval) should have thorough integration coverage
- Edge cases: test the edges that the PRD defines explicitly (protected facts, archive-never-delete, etc.)

## Open items

- Test framework: **Vitest 3** (decided — faster than Jest, native TypeScript, `vi.mock()` built in)
- Mock strategy for LLM calls: `vi.mock()` for unit tests; real calls only in e2e with a test API key
- How to test the Attendant's signal/noise classification: decided when Attendant is built
- Test database seeding strategy: migration-first clean state; seed helpers added in Phase 0
- Coverage thresholds: none enforced in CI — coverage is a signal, not a gate

## Related docs

- [CI/CD setup](ci-cd.md) — tests run in CI
- [Coding standards](coding-standards.md) — test file naming conventions
