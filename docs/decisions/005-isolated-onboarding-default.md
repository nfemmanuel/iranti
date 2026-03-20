# 005 - Isolated Onboarding Default

## Context
Iranti supports both shared machine-level instances and isolated project-level
instances. In practice, new users were being introduced to the shared model
first, which made the Library look like a single combined table across
unrelated projects unless the user already understood instance boundaries.

At the same time, first-run setup was still too dependent on users knowing how
to provision PostgreSQL manually. The product needed a clearer default for
project isolation and a smarter setup flow, but without introducing a second
storage backend that would weaken the consistency model.

## Decision
Iranti onboarding now defaults to isolated per-project runtime setup.

Shared instances remain supported, but they are treated as an explicit
advanced choice rather than the default path.

The setup and project-binding flows now:
- default to `isolated`
- persist `IRANTI_PROJECT_MODE=isolated|shared` in project bindings
- treat multi-project memory sharing as intentional rather than implicit
- stay PostgreSQL-only
- improve first-run PostgreSQL bootstrap by recommending local, Docker, or
  managed PostgreSQL and by creating localhost databases automatically when
  PostgreSQL tooling is available

## Consequences
Good:
- New users get clearer project separation by default.
- Shared-memory behavior is more explicit and easier to reason about.
- Setup is more useful on first install without adding a weaker fallback
  backend.
- The product stays aligned with Iranti's PostgreSQL-based consistency model.

Bad:
- Shared-instance users must now opt in more explicitly.
- Setup logic is more complex because it now performs stronger environment
  detection and some local PostgreSQL bootstrap work.
- Local self-bootstrap still depends on PostgreSQL tooling such as `psql`.

## Alternatives Considered
- Keep shared runtime as the onboarding default
  - Rejected because it makes cross-project memory mixing feel accidental.

- Add a non-PostgreSQL fallback backend such as SQLite
  - Rejected because it would create a second-class runtime mode with
    different consistency and operational behavior.

- Force one-instance-per-project with no shared mode
  - Rejected because deliberate shared-memory deployments are still a valid
    and useful advanced configuration.
