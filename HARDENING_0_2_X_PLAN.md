# Hardening 0.2.x Plan

## Mission

Stabilize Iranti for another `0.2.x` release by hardening lifecycle reliability, authority resolution, configuration mutation safety, runtime/operator truthfulness, CI gating, security posture, and documentation convergence.

This file is the canonical backlog and ownership map for the `0.2.x` stabilization pass.

## Rules

- Backward compatibility is required unless explicitly documented otherwise.
- A fix is only done when code, tests, docs, and validation evidence all exist.
- Patch releases must preserve user flows and operator trust.
- Validation must cover actual runtime behavior, not only static reasoning.

## Ownership

| Worker | Scope | Primary Ownership | Issues |
|---|---|---|---|
| Lead | integration + final validation + hardening ledgers | repo-root hardening files, cross-lane integration, release readiness | all |
| Worker A | CLI lifecycle and Windows execution hardening | `scripts/iranti-cli.ts`, install/upgrade/uninstall/lifecycle docs/tests | 1, 2, 5, 8, 10, 18, 20 |
| Worker B | runtime authority and lifecycle semantics | `src/lib/runtimeEnv.ts`, `src/lib/runtimeLifecycle.ts`, `src/api/server.ts`, related docs/tests | 9, 10, 13, 19 |
| Worker C | DB/archive/vector correctness | `src/library/*`, vector/archive docs/tests, route handoffs if needed | 3, 14 |
| Worker D | CI, contracts, security posture | `.github/workflows/*`, auth typing, secret scanning, security docs | 4, 6, 7, 11, 15, 16, 20 |
| Worker E | sessions/handshake/docs convergence | `src/attendant/*`, `src/api/routes/memory.ts`, session/cross-tool tests, guide/spec/docs cleanup | 12, 17, 19 |

## Issue Backlog

| Issue | Title | Owner | Status | Notes |
|---|---|---|---|---|
| 1 | Eliminate remaining Windows shell-join risk in CLI | Worker A | fixed | Joined `cmd.exe /c` argument paths were replaced with direct invocation or structured detached handoff. |
| 2 | Add locking to env/config mutation paths | Worker A | fixed | Env/config/runtime metadata writes now use lock + temp write + rename. |
| 3 | Make archive/delete behavior fully transactional | Worker C | fixed | Archive/delete semantics now roll back correctly for tx-capable callers. |
| 4 | Raise CI to match claimed system coverage | Worker D | fixed | Fast and DB-backed hardening suites are now wired into CI and release verification. |
| 5 | Remove `--legacy-peer-deps` dependency from CI or justify and contain it | Worker A / D | fixed | Active workflows now run plain `npm ci`. |
| 6 | Make API-key pepper enforcement production-grade | Worker D | fixed | Production startup now fails fast without a valid pepper unless explicitly overridden. |
| 7 | Add repository secret scanning prevention | Worker D | fixed | Gitleaks workflow + config added; repo scan validated locally. |
| 8 | Reduce lifecycle/operator monolith risk in `scripts/iranti-cli.ts` | Worker A | fixed | CLI help rendering is now split into `src/lib/cliHelpRenderer.ts`, with catalog/renderer boundaries separated from command execution while preserving public behavior. |
| 9 | Converge authority resolution into one canonical model | Worker B | fixed | Runtime authority precedence is now explicit, shared, and documented. |
| 10 | Harden runtime metadata semantics | Worker A / B | fixed | Runtime states and health-backed classification are explicit and tested. |
| 11 | Expand CI and tests around lifecycle/session/access-control/runtime | Worker D | fixed | Critical lifecycle/session/access-control/runtime coverage is now represented in CI. |
| 12 | Consolidate docs to reduce truth sprawl | Worker E | fixed | Canonical docs are now indexed explicitly, internal material has a trust-level index, and major summary artifacts are marked as historical/supporting rather than current contract. |
| 13 | Eliminate remaining unsafe warning-and-continue production behavior | Worker B | fixed | Startup/runtime truth surfaces now fail on invalid managed authority, doctor propagates fail status in JSON mode, and `/health` reports degraded runtime/vector health explicitly. |
| 14 | Review and harden vector-delete / vector-reconciliation semantics | Worker C | fixed | Vector drift is now auditable, surfaced through `iranti doctor`, and repairable via `repairVectorIndexConsistency()`. |
| 15 | Remove remaining `as any` auth typing leaks | Worker D | fixed | The auth middleware stack no longer relies on `as any` for `irantiAuth`. |
| 16 | Review static placeholder test values and distinguish harmless placeholders from risky defaults | Worker D | fixed | Risky key-like placeholders and silent fake-key fallbacks were removed from docs/examples, secret-scan allowlists were tightened, and placeholder hygiene is enforced by contract checks. |
| 17 | Validate and tighten session/handshake/operator semantics | Worker E | fixed | Route behavior, docs, and tests now align around actual handshake/session semantics. |
| 18 | Review install / upgrade / uninstall as first-class hardening flows | Worker A | fixed | Fresh install, idempotent non-interactive setup, executable upgrade, and uninstall flows now have explicit lifecycle smoke coverage plus aligned specs. |
| 19 | Review actual runtime/operator trust surfaces for truthfulness | Worker B / E | fixed | Health, status, runtime authority, and session/operator messaging are materially more truthful. |
| 20 | Review repo hygiene for 0.2.x release readiness | Lead / A / D | fixed | Hardening artifacts, workflow policy, release docs, and validation evidence are aligned for a stabilization release. |

## Required Artifacts Per Fixed Issue

1. code change
2. automated test coverage
3. docs update if operator/developer-visible behavior changed
4. validation evidence
5. adjacent workflow regression review

## Release Gate

The `0.2.x` hardening release is considered ready only when:

1. each issue is marked `fixed`, `deferred`, or `not_applicable`
2. every fixed issue has code, tests, docs, and validation evidence
3. CI reflects the real trust surface
4. operator-facing lifecycle/session/status/doctor surfaces are truthful
5. runtime authority resolution is explainable and documented
6. the repo is clean and release-ready
