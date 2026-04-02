# Compatibility Backlog

## Goal

Turn compatibility from an informal expectation into a tested release gate.

## Priority 0

1. Cross-version CLI upgrade matrix
- Verify at least one install path from N-1 to current for Windows.
- Verify running-instance restart behavior after upgrade.

2. Config compatibility tests
- Old `.env.iranti` bindings still load.
- Older instance `.env` files still load.
- Missing new fields get safe defaults.

3. Runtime metadata compatibility tests
- Older `runtime.json` shapes still parse cleanly.
- New readers tolerate missing fields.

4. API response compatibility checks
- Additive fields allowed.
- Existing required fields cannot disappear silently.

5. `iranti status --json` contract checks
- Keep machine-readable runtime/config classifications stable within the major version.
- Cover healthy/unhealthy runtime states plus complete/partial/invalid instance config states.

6. Session inventory/operator contract checks
- Keep `GET /memory/sessions` summary fields and operator-state semantics stable within the major version.
- Cover query filtering/sorting across SDK, TypeScript client, and Python client surfaces.

## Priority 1

7. Client compatibility matrix
- Verify current TypeScript and Python clients can talk to at least one prior compatible server release where practical.
- Verify current server remains usable by at least one prior client release where practical.

8. Deprecation mechanism
- Standard warning format for deprecated CLI flags and commands.
- Standard release-note wording for deprecated API or config surfaces.

9. Benchmark and site alignment checks
- Add a repo-local downstream drift audit for sibling repos.
- Current 2026-04-02 status: the downstream drift audit now passes for `iranti-control-plane`, `iranti-site`, and `iranti-benchmarking`.
- Keep `npm run test:contracts-downstream` as the regression gate so sibling repos do not drift back onto retired CLI or MCP setup language.

## Priority 2

10. Compatibility CI job
- Dedicated CI entry that runs contract and migration-oriented checks together.

11. Release checklist expansion
- Add compatibility signoff to release procedure.

12. Migration docs index
- Central index of past migrations and deprecations.
