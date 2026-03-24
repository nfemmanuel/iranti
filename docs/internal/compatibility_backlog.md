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

## Priority 1

6. Client compatibility matrix
- Verify current TypeScript and Python clients can talk to at least one prior compatible server release where practical.
- Verify current server remains usable by at least one prior client release where practical.

7. Deprecation mechanism
- Standard warning format for deprecated CLI flags and commands.
- Standard release-note wording for deprecated API or config surfaces.

8. Benchmark and site alignment checks
- Ensure benchmark/site/control-plane repos do not depend on stale product-contract assumptions.

## Priority 2

9. Compatibility CI job
- Dedicated CI entry that runs contract and migration-oriented checks together.

10. Release checklist expansion
- Add compatibility signoff to release procedure.

11. Migration docs index
- Central index of past migrations and deprecations.
