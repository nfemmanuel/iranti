# CI/CD setup

**Status:** draft  
**[Back to map](../MAP.md)**

---

## Purpose

Define the continuous integration and continuous deployment pipeline for iranti-core. CI catches problems before they reach main. CD ensures that what is in main can be shipped reliably.

## CI (continuous integration)

CI runs on every push and every PR. It must pass before any PR is merged to main.

### What CI runs

On every PR and push to `iranti-core`:
1. **Type check** — `pnpm typecheck` (`tsc --noEmit`) — TypeScript must compile clean
2. **Lint** — `pnpm lint` (ESLint) — must pass with zero errors
3. **Tests** — `pnpm test` (Vitest) — all tests pass

Format check is enforced locally via pre-commit hooks (coming in Phase 1), not in CI — format issues should never reach a PR.

Phase 0 will add a PostgreSQL integration test step once the schema and migrations exist.

### CI environment

- Platform: GitHub Actions (`ubuntu-latest`)
- Node version: 22 LTS
- Package manager: pnpm 11 (via `pnpm/action-setup@v4`)
- Workflow file: `.github/workflows/ci.yml`

### Test database in CI

When integration tests are added (Phase 0), CI will spin up PostgreSQL using GitHub Actions `services`. Migrations run on each CI run against a fresh database. Tests run against this clean state.

### Secrets in CI

- `DATABASE_URL` — added as a GitHub Actions secret when integration tests are active
- Any API keys — GitHub Actions secrets only, never in code

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

- npm publish: manual tag trigger vs. automatic on merge — decided when iranti-core is ready to ship
- PostgreSQL service config for CI integration tests — added in Phase 0
- CD pipeline — deferred until there is a server component to deploy

## Related docs

- [Testing strategy](testing-strategy.md) — what tests CI runs
- [Git workflow](git-workflow.md) — when CI runs (on every PR)
- [Coding standards](coding-standards.md) — what lint and type-check standards CI enforces
