# Release Prep: 0.3.1

## Context

- Current `main` HEAD: `903ed7c8`
- Repository/package version state still reads `0.3.0`
- `npm run release:check` passes on current `main`
- `v0.3.0` has now been backfilled on GitHub to match the npm registry `gitHead`
- The `v0.3.0` backfill triggered a failed historical publish workflow because the tagged historical commit did not have uniformly bumped version files. That failure is historical reconciliation noise, not a current release blocker.

## Why 0.3.1 Next

`0.3.0` is already published on npm for both:

- `iranti`
- `@iranti/sdk`

Current `main` is ahead of the published `0.3.0` npm `gitHead`, and it contains post-release stabilization work including:

- fast-vs-db test lane separation
- child-process/`ts-node` harness hardening
- setup/upgrade sentinel DB skip handling
- injected-memory enforcement tightening
- packaging output-directory creation before `npm pack`

The next normal release should therefore be `0.3.1`, cut from current `main` after local residue is either committed intentionally or discarded.

## Pre-Release Cleanup

Before cutting `0.3.1`, resolve the current local-only residue into intentional slices:

### Slice A: MCP policy/history/docs

- `docs/features/claude-code-mcp/spec.md`
- `docs/features/codex-mcp/spec.md`
- `docs/features/memory-lifecycle/spec.md`
- `docs/guides/claude-code.md`
- `docs/guides/codex.md`
- `scripts/test-attendant.ts`
- `scripts/test-sdk.ts`
- `tests/mcp/smoke_test.ts`

### Slice B: CLI stdin handoff behavior

- `scripts/iranti-cli.ts`

### Slice C: planned future spec

- `docs/features/instance-agent-policies/spec.md`

### Leave Out

- `AGENTS.md`

## Release Checklist

Once the worktree is clean and the intended slices are committed:

```bash
npm run release:bump -- 0.3.1
npm run build
npm --prefix clients/typescript run build
npm run test:hardening-fast
npm run test:hardening-db
npm run release:check -- v0.3.1
npm run pack:release
python -m build clients/python --outdir clients/python/dist
python -m twine check clients/python/dist/*
```

Then:

```bash
git add package.json package-lock.json clients/typescript/package.json clients/python/pyproject.toml clients/python/iranti.py
git commit -m "Release v0.3.1"
git push origin main
git tag v0.3.1
git push origin v0.3.1
gh release create v0.3.1 --title "v0.3.1" --generate-notes
```

## Notes

- Keep the `v0.3.0` backfill note on the GitHub release so future readers understand why the historical publish workflow failed.
- Do not reuse `v0.3.0` for any future publish action.
