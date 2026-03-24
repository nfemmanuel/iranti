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
| 8 | fixed | `scripts/iranti-cli.ts`, `src/lib/cliHelpCatalog.ts`, `src/lib/cliHelpRenderer.ts`, CLI help contracts |
| 9 | fixed | `src/lib/runtimeEnv.ts`, `src/lib/runtimeLifecycle.ts`, `src/api/server.ts`, runtime docs |
| 10 | fixed | `src/lib/runtimeLifecycle.ts`, `scripts/iranti-cli.ts`, runtime lifecycle tests/docs |
| 11 | fixed | workflows, `package.json`, lifecycle/session/access-control/runtime tests |
| 12 | fixed | `docs/README.md`, `docs/internal/README.md`, internal summary docs, `AGENTS.md` |
| 13 | fixed | `src/api/server.ts`, `src/lib/runtimeLifecycle.ts`, `scripts/iranti-cli.ts`, runtime/operator docs/tests |
| 14 | fixed | `src/library/queries.ts`, `src/library/vectorBackend.ts`, vector backend adapters, vector docs/tests, `scripts/iranti-cli.ts` |
| 15 | fixed | `src/api/middleware/rateLimit.ts`, `src/security/scopes.ts`, access-control tests |
| 16 | fixed | `.gitleaks.toml`, `scripts/test-contracts.ts`, canonical docs/examples, experiment/client placeholders |
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
- `src/lib/cliHelpRenderer.ts`
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
- `scripts/test-contracts.ts`

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
- Added placeholder-hygiene contract coverage and excluded generated local environments from source-tree scans

## Docs Updated

- Clarified canonical docs vs supporting material in `docs/README.md`
- Added an internal docs index and trust-level map in `docs/internal/README.md`
- Marked major internal summary artifacts as historical/supporting rather than canonical product contract
- Documented runtime authority and `/health` authority reporting
- Documented degraded `/health` operator status and startup/doctor fail-fast invariants
- Clarified handshake/session/operator semantics and cross-tool expectations
- Updated release docs to reflect the real gating suites and `npm ci` policy
- Added troubleshooting guidance for config lock conflicts and Windows detached lifecycle behavior
- Added vector drift detection/reconciliation guidance and install/setup/upgrade lifecycle smoke coverage docs
- Replaced risky key-like placeholders and silent fake-key fallbacks in canonical docs/examples with explicit non-secret replacement strings

## Remaining Blockers

- No open blockers remain in the scoped `0.2.x` hardening backlog.
- Follow-up work remains, but it is now incremental rather than release-blocking:
  - continue shrinking `scripts/iranti-cli.ts`
  - keep tightening operator messaging as new surfaces are added
  - keep placeholder hygiene checks aligned with new examples

## Integration Notes

- Worker A and lead integration closed the Windows shell-join risk in the lifecycle layer, and the final release pass corrected the remaining overclaim by moving `scripts/codex-setup.ts` off the last joined `cmd.exe /c` path onto `src/lib/commandInvocation.ts`.
- Worker B’s stricter runtime authority model and worker E’s session/operator semantics were integrated without breaking build or contract checks.
- Runtime lifecycle test cleanup required an extra Windows-specific fix: detached test runtimes are now terminated before temp-root cleanup.

- The final deferred pass closed the remaining scoped deferrals by extracting CLI help rendering, tightening startup/doctor truthfulness, and removing risky placeholder/fake-key defaults from docs and examples.

## Final Release-Readiness Verification

### Newly fixed in this final pass

- Closed the remaining uncovered mutation path by moving project `.gitignore` updates onto the canonical locked mutation helper:
  - `src/lib/fileMutation.ts`
  - `scripts/iranti-cli.ts`
  - `tests/runtime-lifecycle/run_cli_process_safety_tests.ts`
- Corrected release docs so the written fast gate matches the actual workflow:
  - `docs/guides/releasing.md`
- Re-verified and kept the already-correct runtime/session/vector/operator docs and tests aligned:
  - `docs/guides/quickstart.md`
  - `docs/guides/python-client.md`
  - `docs/guides/cross-tool-handoffs.md`
  - `docs/guides/vector-backends.md`
  - `docs/features/interrupted-session-recovery/spec.md`
  - `docs/features/cross-tool-handoffs/spec.md`
  - `docs/features/vector-backends/spec.md`
  - `docs/features/cli-setup-wizard/spec.md`
  - `docs/features/cli-upgrade/spec.md`
  - `docs/features/cli-uninstall/spec.md`
  - `docs/operations/TROUBLESHOOTING.md`
- Re-validated operator truthfulness on the real user runtime root with:
  - `node bin\\iranti.js status --root C:\\Users\\NF\\.iranti-runtime --json`
  - `node bin\\iranti.js doctor --root C:\\Users\\NF\\.iranti-runtime --instance local --json`
  - `node bin\\iranti.js doctor --root C:\\Users\\NF\\.iranti-runtime --instance iranti_dev --json`

### A-L Classification

| Issue | Status | Notes |
|---|---|---|
| A | fixed | Verified by code audit plus `test:cli-process-safety`, runtime lifecycle coverage, `codex-setup` regression coverage, and the constrained detached PowerShell handoff still in use on Windows. |
| B | fixed | The last CLI-owned direct config mutation (`.gitignore`) now uses the shared locked helper. |
| C | fixed | Doctor now surfaces vector drift when reachable, and live validation showed truthful drift reporting on `iranti_dev`. |
| D | fixed | Authority precedence remained correct for repo-local and user-root contexts. |
| E | fixed | Live stale-instance classification and runtime truthfulness matched the implemented state model. |
| F | fixed | Workflows and release docs now describe the same gates. |
| G | fixed | Pepper posture, gitleaks, and placeholder hygiene revalidated. |
| H | fixed | Session semantics remained code-correct; docs were tightened where wording could overstate behavior. |
| I | fixed | Canonical doc hierarchy remained coherent after cross-checking the owned guides/specs. |
| J | fixed | Additional extraction was reviewed and not required for release safety. |
| K | fixed | Status/doctor/health surfaces were validated against real stale, failed, and drifted runtime states. |
| L | fixed | Final release evidence and recommendation are now part of the repo-root hardening set. |

### Files Changed In This Final Pass

- `src/lib/fileMutation.ts`
- `scripts/iranti-cli.ts`
- `tests/runtime-lifecycle/run_cli_process_safety_tests.ts`
- `docs/guides/releasing.md`
- `docs/operations/TROUBLESHOOTING.md`
- `HARDENING_0_2_X_PLAN.md`
- `HARDENING_0_2_X_EXECUTION.md`
- `HARDENING_0_2_X_VALIDATION.md`
- `HARDENING_0_2_X_RELEASE_RECOMMENDATION.md`
