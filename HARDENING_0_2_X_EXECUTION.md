# Hardening 0.2.x Execution

## Current Status

- Worker lanes completed review and bounded edits across CLI, runtime authority, DB/vector correctness, CI/security, and session/docs convergence.
- Lead integration completed the remaining CLI command-invocation and file-mutation work, reconciled test failures, and revalidated the combined tree.

## Issue Status Summary

| Issue | Status | Primary Files |
|---|---|---|
| 1 | fixed | `scripts/iranti-cli.ts`, `src/lib/commandInvocation.ts`, `tests/runtime-lifecycle/run_cli_process_safety_tests.ts` |
| 2 | fixed | `scripts/iranti-cli.ts`, `src/lib/fileMutation.ts`, `src/lib/runtimeLifecycle.ts`, `tests/runtime-lifecycle/run_cli_process_safety_tests.ts` |
| 3 | fixed | `src/library/queries.ts`, `src/library/vectorBackend.ts`, backend adapters, `tests/consistency/run_archive_vector_contract_tests.ts` |
| 4 | fixed | `.github/workflows/contracts.yml`, `.github/workflows/release-quality.yml`, `.github/workflows/publish-packages.yml`, `package.json` |
| 5 | fixed | `.github/workflows/*`, `docs/guides/releasing.md` |
| 6 | fixed | `src/api/server.ts`, `tests/runtime-lifecycle/run_runtime_lifecycle_tests.ts`, security docs |
| 7 | fixed | `.github/workflows/secret-scan.yml`, `.gitleaks.toml`, security docs |
| 8 | deferred | `scripts/iranti-cli.ts`, `src/lib/commandInvocation.ts`, `src/lib/fileMutation.ts`, `src/lib/cliHelpCatalog.ts` |
| 9 | fixed | `src/lib/runtimeEnv.ts`, `src/lib/runtimeLifecycle.ts`, `src/api/server.ts`, runtime docs |
| 10 | fixed | `src/lib/runtimeLifecycle.ts`, `scripts/iranti-cli.ts`, runtime lifecycle tests/docs |
| 11 | fixed | workflows, `package.json`, lifecycle/session/access-control/runtime tests |
| 12 | fixed | `docs/README.md`, `docs/internal/README.md`, internal summary docs, `AGENTS.md` |
| 13 | deferred | `src/api/server.ts`, runtime/operator docs |
| 14 | fixed | `src/library/queries.ts`, `src/library/vectorBackend.ts`, vector backend adapters, vector docs/tests, `scripts/iranti-cli.ts` |
| 15 | fixed | `src/api/middleware/rateLimit.ts`, `src/security/scopes.ts`, access-control tests |
| 16 | deferred | `.gitleaks.toml`, security docs, placeholder audit notes |
| 17 | fixed | `src/api/routes/memory.ts`, session/cross-tool tests, guides/specs |
| 18 | fixed | `tests/runtime-lifecycle/run_setup_upgrade_tests.ts`, `tests/runtime-lifecycle/run_uninstall_tests.ts`, lifecycle specs/docs |
| 19 | fixed | runtime authority/runtime status/session/operator docs and tests |
| 20 | fixed | repo-root hardening artifacts, release/testing/security docs, final validation runbook |

## Files Changed

### Code

- `scripts/iranti-cli.ts`
- `src/api/middleware/rateLimit.ts`
- `src/api/routes/memory.ts`
- `src/api/server.ts`
- `src/lib/commandInvocation.ts`
- `src/lib/cliHelpCatalog.ts`
- `src/lib/fileMutation.ts`
- `src/lib/runtimeEnv.ts`
- `src/lib/runtimeLifecycle.ts`
- `src/library/queries.ts`
- `src/library/vectorBackend.ts`
- `src/library/backends/pgvectorBackend.ts`
- `src/library/backends/qdrantBackend.ts`
- `src/library/backends/chromaBackend.ts`
- `src/security/scopes.ts`
- `package.json`

### Tests

- `tests/access-control/run_access_control_tests.ts`
- `tests/consistency/run_archive_vector_contract_tests.ts`
- `tests/cross-tool/run_cross_tool_handoff_tests.ts`
- `tests/runtime-lifecycle/run_cli_process_safety_tests.ts`
- `tests/runtime-lifecycle/run_setup_upgrade_tests.ts`
- `tests/runtime-lifecycle/run_runtime_lifecycle_tests.ts`
- `tests/runtime-lifecycle/run_uninstall_tests.ts`
- `tests/session-recovery/run_session_recovery_tests.ts`
- `tests/vector-backends/run_vector_backend_tests.ts`

### Workflows / Security

- `.github/workflows/contracts.yml`
- `.github/workflows/release-quality.yml`
- `.github/workflows/publish-packages.yml`
- `.github/workflows/secret-scan.yml`
- `.gitleaks.toml`

### Docs

- `README.md`
- `docs/API.md`
- `docs/README.md`
- `docs/internal/README.md`
- `docs/features/cli-uninstall/spec.md`
- `docs/features/cli-doctor/spec.md`
- `docs/features/cli-setup-wizard/spec.md`
- `docs/features/cli-upgrade/spec.md`
- `docs/features/cross-tool-handoffs/spec.md`
- `docs/features/interrupted-session-recovery/spec.md`
- `docs/features/runtime-upgrades/spec.md`
- `docs/features/temporal-versioning/spec.md`
- `docs/features/vector-backends/spec.md`
- `docs/guides/claude-code.md`
- `docs/guides/cross-tool-handoffs.md`
- `docs/guides/manual.md`
- `docs/guides/python-client.md`
- `docs/guides/quickstart.md`
- `docs/guides/releasing.md`
- `docs/guides/security-quickstart.md`
- `docs/operations/SECURITY_AUDIT.md`
- `docs/operations/TROUBLESHOOTING.md`
- `AGENTS.md`

## Tests Added Or Updated

- Added `test:runtime-lifecycle`
- Added `test:cli-process-safety`
- Added `test:setup-upgrade-lifecycle`
- Added `test:uninstall-lifecycle`
- Added `test:session-recovery`
- Added `test:archive-vector-contracts`
- Added `test:hardening-fast`
- Added `test:hardening-db`
- Expanded access-control, session-recovery, cross-tool, runtime lifecycle, vector backend, and archive/vector correctness coverage

## Docs Updated

- Clarified canonical docs vs supporting material in `docs/README.md`
- Added an internal docs index and trust-level map in `docs/internal/README.md`
- Marked major internal summary artifacts as historical/supporting rather than canonical product contract
- Documented runtime authority and `/health` authority reporting
- Clarified handshake/session/operator semantics and cross-tool expectations
- Updated release docs to reflect the real gating suites and `npm ci` policy
- Added troubleshooting guidance for config lock conflicts and Windows detached lifecycle behavior
- Added vector drift detection/reconciliation guidance and install/setup/upgrade lifecycle smoke coverage docs

## Remaining Blockers

- Issue 8: `scripts/iranti-cli.ts` still needs a larger structural split beyond the helper extractions landed in this pass.
- Issue 13: there are still additional warn-vs-fail decisions worth auditing beyond the major startup/runtime posture fix.
- Issue 16: placeholder review is materially safer because of secret scanning, but the long tail of experimental/doc fixtures is not fully normalized.

## Integration Notes

- Worker A and lead integration closed the Windows shell-join risk with direct or structured invocation rather than raw `cmd.exe /c` joins.
- Worker B’s stricter runtime authority model and worker E’s session/operator semantics were integrated without breaking build or contract checks.
- Runtime lifecycle test cleanup required an extra Windows-specific fix: detached test runtimes are now terminated before temp-root cleanup.
