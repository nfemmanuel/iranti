# Releasing Iranti

Iranti now has a release pipeline for:
- the Node package on npm
- the TypeScript client on npm
- the Python client on PyPI

This does **not** mean already-installed copies auto-update themselves. It means:
- when you publish a new release correctly, new installs get that latest published version
- existing installs still need a reinstall or upgrade command

## What Triggers Publishing

Publishing is driven by the GitHub Actions workflow:

- `.github/workflows/publish-packages.yml`

It runs on:
- GitHub Release `published`
- manual `workflow_dispatch` for verification only

## Release Rules

Before a publish can happen, the workflow enforces version alignment across:

- `package.json`
- `clients/typescript/package.json`
- `clients/python/pyproject.toml`
- `clients/python/iranti.py`
- the release tag, such as `v0.1.2`

If those do not match, publishing stops.

## What the Workflow Does

1. Verifies all versions match.
2. Builds the Node package.
3. Runs contract tests.
4. Packs the root npm tarball and smoke-installs the CLI.
5. Builds the TypeScript client package.
6. Packs the TypeScript client tarball and smoke-installs it.
7. Builds the Python package.
8. Runs `twine check`.
9. Smoke-installs the wheel.
10. If the trigger is a real GitHub Release:
   - publishes Node to npm
   - publishes `@iranti/sdk` to npm
   - publishes Python to PyPI

## One-Time Setup

### npm

Create a repository secret:

- `NPM_TOKEN`

This token must have permission to publish the `iranti` package on npm.
It must also be allowed to publish the `@iranti/sdk` package.

GitHub’s npm publishing guidance:
- https://docs.github.com/actions/publishing-packages/publishing-nodejs-packages

### PyPI

Configure PyPI Trusted Publishing for this repository and workflow.

The workflow already grants:
- `id-token: write`

So PyPI can trust GitHub OIDC without a long-lived API token.

GitHub and PyPI trusted publishing guidance:
- https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-pypi
- https://docs.github.com/en/actions/automating-builds-and-tests/building-and-testing-python

## Release Procedure

Current repo version is `0.2.1`. If the next release is `0.2.2`, use the following exact sequence.

1. Bump versions in one step:

```bash
npm run release:bump -- 0.2.2
```

This updates:
- `package.json`
- `clients/typescript/package.json`
- `package-lock.json`
- `clients/python/pyproject.toml`
- `clients/python/iranti.py`
- current runtime version surfaces in source files
2. Run the exact local checks:

```bash
iranti status
iranti doctor
npm run build
npm --prefix clients/typescript run build
npm run test:contracts
npm run release:check -- v0.2.2
npm pack
npm pack ./clients/typescript
python -m build clients/python --outdir clients/python/dist
python -m twine check clients/python/dist/*
```

3. Commit and push:

```bash
git add package.json clients/typescript/package.json clients/python/pyproject.toml clients/python/iranti.py CHANGELOG.md
git commit -m "Release v0.2.2"
git push origin main
```

4. Create the tag and GitHub release:

```bash
git tag v0.2.2
git push origin v0.2.2
gh release create v0.2.2 --title "v0.2.2" --notes "Release notes here"
```

5. The publish workflow will run automatically on that release.

## Verification Only

You can manually run the workflow with `workflow_dispatch` to verify release readiness without publishing.

If you provide `release_tag`, the workflow also checks the tag/version match.

## Important Constraint

Fresh installs will get the latest published version.

Existing installs will not magically update just because you released a new version. For those, you still need:
- `npm update iranti`
- or a reinstall
- or a future dedicated upgrade command
