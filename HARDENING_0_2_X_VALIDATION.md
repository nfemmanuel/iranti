# Hardening 0.2.x Validation

## Validation Ledger

This file records concrete validation evidence for the `0.2.x` hardening pass.

## Fixed Issues And Evidence

### Issue 1 â€” Windows shell-join risk in CLI

- Code paths:
  - `scripts/iranti-cli.ts`
  - `src/lib/commandInvocation.ts`
- Tests:
  - `npm run build`
  - `npm run test:cli-process-safety`
  - `npm run test:runtime-lifecycle`
- Runtime validation:
  - Windows lifecycle commands now use direct invocation or structured detached handoff instead of joined `cmd.exe /c` strings for the corrected paths.
- Result:
  - fixed

### Issue 2 â€” Lock env/config mutation paths

- Code paths:
  - `src/lib/fileMutation.ts`
  - `scripts/iranti-cli.ts`
  - `src/lib/runtimeLifecycle.ts`
- Tests:
  - `npm run test:cli-process-safety`
  - `npm run test:runtime-lifecycle`
- Runtime validation:
  - concurrent locked writes preserve all updates
  - stale lock cleanup succeeds
  - failed writes preserve original file contents
- Result:
  - fixed

### Issue 3 â€” Transactional archive/delete behavior

- Code paths:
  - `src/library/queries.ts`
  - `src/library/vectorBackend.ts`
  - backend adapters
- Tests:
  - `npm run test:archive-vector-contracts`
  - `npm run test:consistency`
  - `npm run test:vector-backends`
- Runtime validation:
  - verified on fresh pgvector-backed PostgreSQL after migrations + seed
- Result:
  - fixed

### Issue 4 / 11 â€” CI truthfulness and critical suite gating

- Code paths:
  - `.github/workflows/contracts.yml`
  - `.github/workflows/release-quality.yml`
  - `.github/workflows/publish-packages.yml`
  - `package.json`
- Tests:
  - `npm run test:hardening-fast`
  - `npm run test:hardening-db`
- Runtime validation:
  - both suites passed locally
  - workflows now gate those suites instead of relying on contract smoke alone
- Result:
  - fixed

### Issue 5 â€” Remove `--legacy-peer-deps` dependency

- Code paths:
  - active GitHub workflows
  - `docs/guides/releasing.md`
- Tests:
  - `npm ci`
  - `npm run build`
- Result:
  - fixed

### Issue 6 â€” Production-grade API-key pepper enforcement

- Code paths:
  - `src/api/server.ts`
- Tests:
  - `npm run test:runtime-lifecycle`
- Runtime validation:
  - production startup without a valid `IRANTI_API_KEY_PEPPER` now fails fast unless `IRANTI_ALLOW_INSECURE_STARTUP=true`
- Result:
  - fixed

### Issue 7 â€” Secret scanning prevention

- Code paths:
  - `.github/workflows/secret-scan.yml`
  - `.gitleaks.toml`
- Validation:
  - local repo scan with Gitleaks against the current repo returned `no leaks found`
- Result:
  - fixed

### Issue 9 / 10 / 19 â€” Runtime authority, lifecycle semantics, truthful operator surfaces

- Code paths:
  - `src/lib/runtimeEnv.ts`
  - `src/lib/runtimeLifecycle.ts`
  - `src/api/server.ts`
  - `scripts/iranti-cli.ts`
- Tests:
  - `npm run test:runtime-lifecycle`
  - `npm run build`
- Runtime validation:
  - explicit/derived/invalid/adhoc authority classification validated
  - `/health` now surfaces runtime authority detail
  - runtime state classification distinguishes running, unhealthy, stale, stopped, missing, and invalid
- Result:
  - fixed

### Issue 12 â€” Docs truth-sprawl cleanup

- Code paths:
  - `docs/README.md`
  - `docs/internal/README.md`
  - `docs/internal/IMPLEMENTATION_SUMMARY.md`
  - `docs/internal/FIXES_APPLIED.md`
  - `docs/internal/GOAL_VALIDATION_SUMMARY.md`
  - `docs/internal/validation_results.md`
  - `AGENTS.md`
- Validation:
  - canonical docs map now points readers to guides/specs/decisions/operations first
  - internal docs now have an index with trust-level guidance and category split
  - major internal summary artifacts are explicitly labeled as historical/supporting rather than canonical contract
  - root-level historical audit/fix artifacts are called out as non-canonical in `docs/README.md`
- Result:
  - fixed

### Issue 14 — Vector-delete / vector-reconciliation semantics

- Code paths:
  - `src/library/queries.ts`
  - `src/library/vectorBackend.ts`
  - `src/library/backends/pgvectorBackend.ts`
  - `src/library/backends/qdrantBackend.ts`
  - `src/library/backends/chromaBackend.ts`
  - `scripts/iranti-cli.ts`
- Tests:
  - `npm run test:archive-vector-contracts`
  - `npm run test:vector-backends`
  - `npm run test:hardening-db`
- Runtime validation:
  - `iranti doctor` now surfaces vector index consistency warnings after a successful backend reachability check
  - fresh pgvector-backed validation proved audit + repair of missing embeddings and orphaned vector ids
- Result:
  - fixed

### Issue 15 â€” Remove auth typing leaks

- Code paths:
  - `src/api/middleware/rateLimit.ts`
  - `src/security/scopes.ts`
- Tests:
  - `npm run build`
  - `npm run test:access-control`
- Result:
  - fixed

### Issue 17 â€” Session/handshake/operator semantics

- Code paths:
  - `src/api/routes/memory.ts`
  - session/cross-tool docs and tests
- Tests:
  - `npm run test:session-recovery`
  - `npm run test:cross-tool-handoff`
  - `npm run test:contracts`
- Runtime validation:
  - route-level session inspection now accepts task/recent-message context
  - cross-tool tests explicitly prove agent-scoped checkpoints do not leak to the receiver
- Result:
  - fixed

### Issue 18 — Install / upgrade / uninstall as first-class hardening flows

- Code paths:
  - `tests/runtime-lifecycle/run_setup_upgrade_tests.ts`
  - `package.json`
  - `docs/features/cli-setup-wizard/spec.md`
  - `docs/features/cli-upgrade/spec.md`
  - `docs/features/cli-uninstall/spec.md`
- Tests:
  - `npm run test:setup-upgrade-lifecycle`
  - `npm run test:hardening-fast`
- Runtime validation:
  - fresh `install --root` smoke creates the runtime root and metadata
  - repeated `setup --defaults` updates the same isolated instance idempotently
  - targeted `upgrade --yes --target npm-global,python --json` executes successfully against fake tool shims and records `upgradedAt`
  - uninstall cleanup remains covered by `npm run test:uninstall-lifecycle`
- Result:
  - fixed

### Issue 20 â€” Repo hygiene and release readiness discipline

- Code paths:
  - repo-root hardening artifacts
  - release/testing/security docs
- Tests:
  - `npm run build`
  - `npm run test:hardening-fast`
  - fresh pgvector-backed `npm run test:hardening-db`
- Result:
  - fixed

## Deferred Issues

| Issue | Why Deferred | Current Mitigation |
|---|---|---|
| 8 | CLI still remains a large operational file after helper extraction. | Reduced shell/file-mutation blast radius via extracted helpers. |
| 13 | Not every warning/fail-open path was re-audited in this pass. | Production pepper posture and runtime authority warnings were tightened. |
| 16 | Placeholder review across docs/experiments is incomplete. | Secret scanning is active and allowlists are narrow. |

## Validation Commands Run

### Fast gate

```text
npm run build
npm run test:hardening-fast
```

### DB-backed gate

```text
npx prisma migrate deploy --schema prisma/schema.prisma
npm run seed
npm run test:hardening-db
```

Executed locally on a fresh disposable `pgvector/pgvector:pg16` container bound to `127.0.0.1:5438`.

### Additional local validation

```text
docker run --rm -v "C:\Users\NF\Documents\Projects\iranti:/repo" zricethezav/gitleaks:latest detect --source=/repo --no-banner --config=/repo/.gitleaks.toml
```

Result: `no leaks found`

## Remaining Blockers

- The repo is substantially harder and tighter than it was at the start of this pass.
- The remaining blockers are now mostly explicit deferrals rather than unknown reliability gaps:
  - CLI modularity follow-on
  - warn/fail-open audit completion
  - placeholder cleanup

## Release Recommendation

Recommended status: ready for another `0.2.x` stabilization release if the deferred items above are explicitly carried forward as follow-up work, not silently forgotten.

Reason:

- critical lifecycle, runtime authority, access-control, session/operator, and CI trust surfaces are now materially stronger
- the corrected surfaces are backed by code, tests, docs, and validation evidence
- remaining work is real, but it is narrower and better isolated than the starting state




