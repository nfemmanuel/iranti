# 007 - Compatibility Policy

## Context

Iranti is no longer only a fast-moving local prototype. It now ships as an installed CLI, a REST API, published TypeScript and Python clients, and machine-level runtime state that users upgrade in place. That means accidental breakage now has real cost: broken project bindings, failed upgrades, stale automation, client drift, and benchmark/site/control-plane repos operating from inconsistent assumptions.

The project needs an explicit compatibility policy so future changes are judged against a stable contract instead of ad hoc release-time intuition.

## Decision

Iranti adopts a compatibility-first policy across the following surfaces:

1. CLI
- Existing commands and flags are treated as compatibility surfaces.
- Human-readable output may improve, but `--json` output is treated as automation-facing and should remain stable within the same major version.
- Commands and flags should be deprecated before removal whenever feasible.

2. REST API
- Existing routes and response fields are compatibility surfaces.
- Adding fields is generally allowed.
- Removing or renaming fields requires an explicit deprecation path or a major-version boundary.
- Debug-only fields may evolve faster, but should not silently change meaning without documentation.

3. SDKs and clients
- Published TypeScript and Python client method names, parameter semantics, and core response structures are compatibility surfaces.
- Additive changes are preferred.
- Signature changes or response-shape removals require deprecation or a major-version boundary.

4. Project and instance configuration
- `.env.iranti`, instance `.env`, setup config files, and runtime metadata are treated as migration-managed compatibility surfaces.
- New fields may be added.
- Existing fields should not be renamed or removed without compatibility shims, fallback parsing, or an explicit migration path.

5. Database and persisted state
- Existing installs must be upgradeable without data loss.
- Schema and runtime-state migrations must preserve existing user data unless a breaking migration is explicitly documented.
- Durable state should be migrated, not silently reinterpreted.

6. Release discipline
- Patch releases should not intentionally break existing user flows.
- Minor releases may add capabilities and deprecations, but should still preserve current integrations.
- Major releases are the boundary for deliberate contract reshaping.

7. Deprecation process
- If an old surface must be retired, Iranti should first:
  - warn
  - document the replacement
  - provide migration guidance or compatibility parsing when practical
- Removal should happen only after at least one clearly documented release cycle of deprecation, unless security or correctness requires faster removal.

## Consequences

Good:
- Upgrades become more trustworthy.
- CLI, API, and SDK drift become easier to detect and prevent.
- Related repos can align to a stable contract.
- Release quality improves because compatibility is evaluated intentionally.

Bad:
- Some refactors will take longer because migration paths must be designed.
- Old surfaces may need temporary compatibility shims.
- Debug and output cleanup work now needs stronger judgment about what is safe to change.

## Alternatives Considered

### 1. Continue with implicit compatibility
Rejected because the product now has enough external surfaces that accidental breakage is too costly.

### 2. Freeze everything immediately
Rejected because Iranti still needs iteration speed. The right approach is controlled compatibility, not paralysis.

### 3. Treat only the REST API as stable
Rejected because the CLI, config files, and published clients are also real compatibility surfaces for users.
