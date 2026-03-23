# Release Readiness - 2026-03-22

## Scope
This checklist covers the release-affecting changes currently in the worktree, with emphasis on:

- runtime env precedence and MCP startup
- `iranti setup` interactive behavior on Windows
- Docker-backed PostgreSQL setup and container reuse
- compatibility and contract drift across CLI, API, SDK, and docs

## Release Gate

| Check | Command / Evidence | Status | Notes |
|---|---|---|---|
| TypeScript/Prisma build | `npm run build` | PASS | Current worktree compiles cleanly. |
| Runtime lifecycle smoke | `npx ts-node tests/runtime-lifecycle/run_runtime_lifecycle_tests.ts` | PASS | Includes runtime env precedence regression coverage. |
| Contract drift | `npx ts-node scripts/test-contracts.ts` | PASS | 113 passed, 0 failed in current worktree. |
| Windows setup recovery | Manual validation in local session | PASS | Fixed Docker host-port suggestion, Docker container-name reuse, and hidden password prompt rendering. |
| Bound-project MCP startup | Manual validation in local session | PASS | `iranti mcp` now stays running from a bound project instead of failing with DB auth from app-local `.env`. |
| Fresh macOS setup smoke | Not yet run | BLOCKED | Needs explicit validation outside Windows. |
| Fresh Linux setup smoke | Not yet run | BLOCKED | Needs explicit validation outside Windows. |

## Changes Covered

### Runtime env precedence
- Instance env now overrides stale preloaded `.env` values when a project binding points at `IRANTI_INSTANCE_ENV`.
- This closes the observed failure where `iranti mcp` inherited an app-local `DATABASE_URL` instead of the Iranti instance database.

### Windows setup UX / Docker handling
- Hidden password prompts now render the prompt before muting typed input.
- Docker port suggestion now treats published Docker host ports as occupied.
- Docker container inspection/reuse now uses the same capture path and quoting behavior as the rest of the CLI.

### Automated regressions added
- Runtime lifecycle test now covers:
  - stale preloaded `DATABASE_URL` / `LLM_PROVIDER` / `IRANTI_URL` / `IRANTI_API_KEY`
  - Docker published host-port parsing
  - Docker container name parsing

## Remaining Release Blockers

1. macOS setup smoke
   - Need at least one fresh `setup -> doctor -> mcp` validation.

2. Linux setup smoke
   - Need at least one fresh `setup -> doctor -> mcp` validation.

3. Worktree hygiene
   - Release should not be cut from the current mixed worktree without explicitly deciding which changed docs/tests/features are in scope.

## Recommendation

Status at assessment time: **Not ready for public release yet**

Assessment reason:
- The Windows-local failures that triggered this pass are fixed.
- The core automated gate currently passes.
- Cross-platform setup validation is still missing for macOS and Linux, and the release surface is broader than the small setup fix alone.

Operator follow-up:
- `0.2.22` was subsequently approved for release to ship the setup/MCP fixes after the Windows gate passed.
- macOS and Linux setup smoke remain follow-up validation items after release.

## Minimum Next Step Before Release

Run the same setup/MCP smoke on:

1. macOS
2. Linux

Then re-run:

```powershell
npm run build
npx ts-node tests/runtime-lifecycle/run_runtime_lifecycle_tests.ts
npx ts-node scripts/test-contracts.ts
```

If those pass and the release scope is cleaned up, the repo can move to release-candidate status.
