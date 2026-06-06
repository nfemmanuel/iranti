# Git workflow

**Status:** template  
**[Back to map](../MAP.md)**

---

## Purpose

Define how git is used in the iranti-core project: branch naming, commit format, the PR process, and the release model. The goal is a clean history that tells the story of the project.

## Branch model

- `main` — always deployable, always passing CI
- `dev` — integration branch, or work directly on `main` (decide which)
- Feature branches — `feature/<short-description>`
- Fix branches — `fix/<short-description>`
- Phase branches — `phase/<n>-<description>` (e.g. `phase/1-library`)

_Decide which model to use before the first commit._

## Commit format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short description>

[optional body]

[optional footer: BREAKING CHANGE, closes #issue]
```

**Types:**
- `feat` — a new feature
- `fix` — a bug fix
- `docs` — documentation only
- `refactor` — code change that neither fixes a bug nor adds a feature
- `test` — adding or correcting tests
- `chore` — tooling, config, dependencies

**Examples:**
```
feat(librarian): add conflict detection on write
fix(attendant): correct periodic drift check counter reset
docs(schema): add media table placeholder columns
```

## Pull requests

- Every feature or fix comes in through a PR, even when working alone
- PRs are reviewed before merging — even a self-review with fresh eyes counts
- PR description includes: what changed, why, how to test
- PRs pass CI before merge
- Squash or rebase to keep history clean (decide which before the first PR)

## What not to commit

- `.env` files
- API keys or secrets of any kind
- `node_modules/`
- Build output (`dist/`)
- Local `.history/` folder

## Tagging and releases

- Tags follow [semver](https://semver.org/): `v<major>.<minor>.<patch>`
- Phase completions are tagged: `v0.1.0` = Phase 1 done, `v0.2.0` = Phase 2 done, etc.
- Breaking changes bump the major version

## Open items

_Fill in:_
- Branch model decision (main only vs. main + dev)
- Merge strategy decision (squash vs. rebase)
- GitHub repository name and visibility
- Branch protection rules for `main`

## Related docs

- [CI/CD setup](ci-cd.md) — what runs on each PR
- [Coding standards](coding-standards.md) — what lint and type-check are run
