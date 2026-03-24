# Hardening 0.2.x Release Recommendation

## Recommendation

Release another `0.2.x` stabilization version.

Recommended status: justified and ready once this validated tree is committed and the working tree is clean.

## What Was Verified As Fixed

- Windows/process safety is now based on direct invocation and constrained detached handoff, not risky joined `cmd.exe /c` lifecycle execution.
- Runtime authority precedence is converged and behaves consistently across repo-local and user-root runtime contexts.
- Runtime metadata truthfulness is strong enough for operator use:
  - stale instances classify as `stale`
  - unreachable vector backends fail clearly
  - live vector drift warns clearly
- CI truthfulness is real:
  - fast gate and DB-backed gate both exist in workflows
  - release docs now match the actual gates
  - active workflows use plain `npm ci`
- Production security posture is enforceable:
  - pepper posture is explicit
  - secret scanning is active
  - placeholder hygiene is enforced
- Session/handshake/cross-tool semantics are aligned in code, tests, and docs.
- Canonical docs remain identifiable and the release-critical guides/specs/ops docs now point to the same truths.

## What Was Newly Fixed In This Final Pass

- Closed the remaining uncovered config-mutation hole by moving project `.gitignore` updates onto the canonical locked mutation helper:
  - `src/lib/fileMutation.ts`
  - `scripts/iranti-cli.ts`
  - `tests/runtime-lifecycle/run_cli_process_safety_tests.ts`
- Corrected the release guide so it accurately lists the real fast gate:
  - `docs/guides/releasing.md`
- Re-validated live operator truth surfaces against the real user runtime root:
  - `node bin\iranti.js status --root C:\Users\NF\.iranti-runtime --json`
  - `node bin\iranti.js doctor --root C:\Users\NF\.iranti-runtime --instance local --json`
  - `node bin\iranti.js doctor --root C:\Users\NF\.iranti-runtime --instance iranti_dev --json`

## What Remains Partially Risky

- `scripts/iranti-cli.ts` is still large. It is acceptable for another `0.2.x` release because the current operator-critical behavior is tested, but the file remains a maintenance risk.
- `/health` preserves backward compatibility by keeping top-level `status: ok` and exposing richer truth via additive `operatorStatus` and `checks`. That is the correct `0.2.x` compatibility choice, but it means operators must read the richer fields.
- Real user instances can still legitimately be stale, misconfigured, or drifted. That is not a release blocker; the important point is that `status` and `doctor` now report those conditions truthfully.

## What Was Intentionally Deferred

- No release-blocking `0.2.x` hardening items remain deferred.
- Broader CLI decomposition beyond the existing help/catalog extraction is deferred to a later cycle because it is not required for this release.
- Any deeper product-scope work toward `0.3.x` remains intentionally out of scope for this pass.

## Whether Another 0.2.x Release Is Justified

Yes.

Reason:

- the release-critical trust surfaces now have current code, tests, docs, and validation evidence
- the last remaining uncovered config-mutation path is closed
- live-machine operator checks against the real runtime root behaved truthfully
- build, fast gate, fresh DB-backed gate, release version check, and secret scan all passed

## What Would Still Block 0.3.x

- A smaller, clearer CLI/runtime module structure than the current `scripts/iranti-cli.ts`
- More explicit operator/admin surfaces around vector repair, session history depth, and richer lifecycle management if those are to be part of a broader product claim
- Any deliberate contract reshaping beyond additive compatibility surfaces
- A stronger answer on long-term hosted/cloud/operator product boundaries if `0.3.x` expands scope rather than continuing stabilization

## Evidence Summary

- `npm run build`
- `npm run test:hardening-fast`
- fresh pgvector-backed `npm run test:hardening-db`
- `npm run release:check -- v0.2.25`
- local gitleaks scan
- live runtime validation on `C:\Users\NF\.iranti-runtime`
