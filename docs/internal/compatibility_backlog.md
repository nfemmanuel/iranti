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

## Priority 1

5. Client compatibility matrix
- Verify current TypeScript and Python clients can talk to at least one prior compatible server release where practical.
- Verify current server remains usable by at least one prior client release where practical.

6. Deprecation mechanism
- Standard warning format for deprecated CLI flags and commands.
- Standard release-note wording for deprecated API or config surfaces.

7. Benchmark and site alignment checks
- Ensure benchmark/site/control-plane repos do not depend on stale product-contract assumptions.

## Priority 2

8. Compatibility CI job
- Dedicated CI entry that runs contract and migration-oriented checks together.

9. Release checklist expansion
- Add compatibility signoff to release procedure.

10. Migration docs index
- Central index of past migrations and deprecations.
