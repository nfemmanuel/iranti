# CI/CD setup

**Status:** template  
**[Back to map](../MAP.md)**

---

## Purpose

Define the continuous integration and continuous deployment pipeline for iranti-core. CI catches problems before they reach main. CD ensures that what is in main can be shipped reliably.

## CI (continuous integration)

CI runs on every push and every PR. It must pass before any PR is merged to main.

### What CI runs

On every PR:
1. **Type check** — `tsc --noEmit` — TypeScript must compile clean
2. **Lint** — ESLint must pass with zero errors
3. **Format check** — Prettier must report no changes needed
4. **Unit tests** — all unit tests pass
5. **Integration tests** — all integration tests pass (requires a test database)

### CI environment

- Platform: GitHub Actions
- Node version: _specify_
- PostgreSQL version: _specify_
- Docker: used to spin up the test database in CI

### Test database in CI

CI spins up a PostgreSQL instance using Docker Compose. Prisma migrations run on each CI run against a fresh database. Tests run against this clean state. The database is torn down at the end of the run.

_Define the exact Docker Compose setup for CI._

### Secrets in CI

- `DATABASE_URL` — test database connection string
- API keys — add as GitHub Actions secrets, never in code

## CD (continuous deployment)

_Define this when there is something to deploy. For the initial build, iranti is a locally-installed npm package. The "deployment" is a publish to npm._

### npm publish

On merge to main (or on tag):
1. CI passes all checks
2. Version is bumped according to semver (manual or automated)
3. Package is built (`npm run build`)
4. Package is published to npm (`npm publish`)

_Define the exact publish workflow here._

### Future: server deployment

When iranti has a server component (cloud account, control plane), a server deployment pipeline will be needed. This is deferred until then.

## Open items

_Fill in:_
- Node version to pin
- PostgreSQL version to pin
- GitHub Actions workflow file location (`.github/workflows/ci.yml`)
- npm publish: manual tag trigger vs. automatic on merge to main
- Test database Docker Compose configuration for CI

## Related docs

- [Testing strategy](testing-strategy.md) — what tests CI runs
- [Git workflow](git-workflow.md) — when CI runs (on every PR)
- [Coding standards](coding-standards.md) — what lint and type-check standards CI enforces
