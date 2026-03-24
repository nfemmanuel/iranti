# Release 0.2.26 Execution

## Baseline Verified

- Starting commit: `537b5b84`
- Working tree at start: clean
- Coordinated version surfaces at start:
  - `package.json`: `0.2.25`
  - `clients/typescript/package.json`: `0.2.25`
  - `clients/python/pyproject.toml`: `0.2.25`
  - `clients/python/iranti.py`: `0.2.25`
- Reviewed release evidence:
  - `HARDENING_0_2_X_RELEASE_RECOMMENDATION.md`
  - `HARDENING_0_2_X_VALIDATION.md`
- Live runtime truth check:
  - `node bin\iranti.js status --root C:\Users\NF\.iranti-runtime --json`
  - confirmed stale instances were classified as `stale`, not `running`

## Residual Risk Verification

- Area checked explicitly:
  - `scripts/codex-setup.ts`
  - `scripts/iranti-cli.ts`
  - `src/lib/commandInvocation.ts`
- Residual Windows command-path issue found: yes
- Exact issue:
  - `scripts/codex-setup.ts` still used `cmd.exe /c` on Windows with a joined command string and `quoteForCmd()` even after the broader hardening docs claimed the Windows shell-join pass was closed.
- Exact fix:
  - removed `quoteForCmd()` and the joined `cmd.exe /c` path from `scripts/codex-setup.ts`
  - switched the script to `spawnSyncResolved()` from `src/lib/commandInvocation.ts`
  - added Windows-only regression coverage in `tests/runtime-lifecycle/run_cli_process_safety_tests.ts`
- Remaining justified Windows shell fallback:
  - constrained detached PowerShell handoff in `scripts/iranti-cli.ts` for global npm upgrade/uninstall orchestration
  - this remains explicit, typed, and documented rather than a free-form joined cmd path

## Tests Run

### Release-critical stack

```text
npm ci
npm run build
npm run test:hardening-fast
```

Executed once before the version bump to validate the narrowed `codex-setup` fix, then re-run after the `0.2.26` bump to validate the exact release candidate tree.

### Fresh DB-backed validation

Executed against a disposable `pgvector/pgvector:pg16` container on `127.0.0.1:5438`:

```text
npx prisma migrate deploy --schema prisma/schema.prisma
npm run seed
npm run test:hardening-db
```

Executed once before the version bump and again after the `0.2.26` bump so the full DB-backed gate passed on the exact release candidate tree.

### Secret scan

```text
docker run --rm -v "<repo>:/repo" zricethezav/gitleaks:latest detect --source=/repo --no-banner --config=/repo/.gitleaks.toml
```

Result: `no leaks found`

### Release version check

```text
npm run release:check -- v0.2.26
```

Result: passed

## Version Bump Applied

- Prior version: `0.2.25`
- New version: `0.2.26`
- Coordinated surfaces updated:
  - `package.json`
  - `package-lock.json`
  - `clients/typescript/package.json`
  - `clients/python/pyproject.toml`
  - `clients/python/iranti.py`
  - `src/api/server.ts`
  - `scripts/iranti-mcp.ts`
  - `docs/guides/releasing.md`
  - `CHANGELOG.md`

## Files Changed In This Release Execution Pass

- `scripts/codex-setup.ts`
- `tests/runtime-lifecycle/run_cli_process_safety_tests.ts`
- `HARDENING_0_2_X_EXECUTION.md`
- `HARDENING_0_2_X_VALIDATION.md`
- `HARDENING_0_2_X_RELEASE_RECOMMENDATION.md`
- `package.json`
- `package-lock.json`
- `clients/typescript/package.json`
- `clients/python/pyproject.toml`
- `clients/python/iranti.py`
- `src/api/server.ts`
- `scripts/iranti-mcp.ts`
- `docs/guides/releasing.md`
- `CHANGELOG.md`

## Release Readiness Result

- Baseline verified: yes
- Residual Windows command-path issue found: yes
- Residual Windows command-path issue fixed: yes
- Release evidence still credible after verification: yes
- Build passed: yes
- Fast hardening suite passed: yes
- Fresh DB-backed hardening suite passed: yes
- Local secret scan passed: yes
- Version coordination check passed: yes

## Ready For

- `git push`: yes
- tag: yes
- GitHub release: yes
- package publish: yes, via the existing release workflow after tag/release creation
