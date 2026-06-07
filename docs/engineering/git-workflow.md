# Git workflow

**Status:** draft  
**[Back to map](../MAP.md)**

---

## Purpose

Define how git is used in the iranti-core project: branch naming, commit format, the PR process, and the release model. The goal is a clean history that tells the story of the project.

## Branch model

- `main` — always deployable, always passing CI
- Feature branches — `feature/<short-description>`
- Fix branches — `fix/<short-description>`
- Phase branches — `phase/<n>-<description>` (e.g. `phase/1-library`)

Feature branches only, no dev buffer. During the rebuild, feature branches come off `iranti-core`. After the rebuild merges to main, feature branches come off `main`.

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
- Squash merge only. All commits on a feature branch collapse into one clean commit on the target branch. Delete the feature branch after merge.

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

## Rebuild branch strategy

The iranti-core rebuild lives on an orphan branch (`iranti-core`) with no shared history with main. Feature branches during the rebuild come off `iranti-core`.

When the rebuild is complete and ready to ship:

    git checkout main
    git merge iranti-core --allow-unrelated-histories

Main retains its full history. The rebuild history lives on the other side of the merge.

## Open items

- Branch model: feature branches only, off iranti-core during rebuild
- Merge strategy: squash merge
- GitHub repository: existing iranti repo (public)
- Branch protection on main: protect from direct pushes, require PR. Set this up in GitHub repo settings.

## Related docs

- [CI/CD setup](ci-cd.md) — what runs on each PR
- [Coding standards](coding-standards.md) — what lint and type-check are run
