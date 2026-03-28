# Changelog

All notable changes to this project are documented in this file.

## 0.2.49 - Unreleased

### Changed

- MCP tool guidance is now more explicit about the intended host pattern: run `handshake()` at session start when possible, and treat `attend()` as the mandatory pre-reply retrieval call even when the host skipped startup hooks.
- Codex setup output and docs now spell out the same host-side memory contract instead of relying on inferred operator discipline.

### Fixed

- Routine control-plane health and diagnostics probes can now call `attend()` without flooding Staff Logs with `control_plane_operator / attend_completed / memory_not_needed` debug noise.
- Personal height recall is now treated as mandatory memory retrieval and can resolve across the legacy `person/user` versus canonical `user/main` identity split.
- MCP personal-memory retrieval is more tolerant of legacy personal-entity variants, so stored facts like height no longer disappear just because older sessions used a different personal entity.

### Documentation

- Added an internal host audit documenting which first-party paths guarantee `handshake()` + `attend()` and which generic MCP paths still depend on the external host honoring that contract.

## 0.2.44 - Unreleased

### Added

- Instance runtime metadata now supports first-class Docker container dependencies, and `iranti run --instance ...` will start recorded Docker-backed dependencies before booting the API.
- `iranti setup --db-mode docker` and `iranti configure instance --docker-container ...` can now record Docker dependency metadata for managed instances.
- Codex and Claude scaffolding now writes VS Code-native `.vscode/mcp.json` files alongside `.mcp.json` so workspace MCP clients do not rely on cross-app discovery alone.
- `iranti doctor` now warns when a bound repo is missing `.vscode/mcp.json` or the file does not expose the `iranti` MCP server.
- Added validation artifacts for cross-interface memory behavior and the instance runtime dependency design/implementation plan.

### Fixed

- `iranti codex-setup` now scaffolds the MCP files Codex VS Code actually needs, closing the gap where Codex CLI worked but VS Code sessions did not expose Iranti tools.

## 0.2.42 - Unreleased

### Added

- Pending release notes.

## 0.2.41 - Unreleased

### Added

- Pending release notes.

## 0.2.40 - Unreleased

### Added

- Pending release notes.

## 0.2.39 - Unreleased

### Added

- Pending release notes.

## 0.2.38 - Unreleased

### Fixed

- Auto-remember now canonicalizes `favorite`/`favourite` style keys so duplicate spellings do not create parallel memory entries.
- Claude self-memory retrieval injection now includes a direct answer candidate for questions like `what is my favorite movie?`, reducing model drift when the fact is already in Iranti.

## 0.2.37 - Unreleased

### Fixed

- Claude Code prompt auto-remember now runs for declarative prompts even when the retrieval path would not otherwise write anything.
- Auto-remember prompt and assistant extraction now accept both `favorite` and `favourite` spellings for favorite-value facts.

## 0.2.36 - Unreleased

### Added

- Opt-in `IRANTI_AUTO_REMEMBER` support for Claude Code and Codex prompt retrieval flows, with strict explicit-fact capture into `IRANTI_MEMORY_ENTITY`.
- Claude hook regression coverage for `handshake()`, `attend()`, prompt auto-remember, and Stop-hook assistant summary capture.

### Changed

- `iranti claude-setup` now scaffolds a Claude `Stop` hook alongside `SessionStart` and `UserPromptSubmit`.
- Claude and Codex integration docs now describe the limited auto-remember behavior and its write boundaries.

### Fixed

- Claude Code hook execution now uses `handshake()` on `SessionStart` and `attend()` on `UserPromptSubmit` instead of bypassing the attendant flow.
- Command-surface error rewriting now turns database-unreachable failures into actionable operator guidance.

## 0.2.35 - Unreleased

### Changed

- Re-cut the coordinated package release so the root npm package, TypeScript client, and Python client advance together again after the `0.2.34` root npm provenance publish failed despite the other package publishes succeeding.

### Fixed

- Root npm package version alignment is restored by publishing the same release content under a fresh coordinated version instead of leaving npm behind PyPI and `@iranti/sdk`.

### Validation

- Re-ran `npm run build`, `npm run test:hardening-fast`, `npm run release:check -- v0.2.35`, `python -m build clients/python --outdir clients/python/dist`, and `python -m twine check clients/python/dist/*` locally before release.

## 0.2.34 - Unreleased

### Fixed

- Runtime lifecycle smoke coverage no longer inherits the repo's ambient `.env.iranti` project binding when it is explicitly testing `--root` and isolated runtime authority behavior.
- Repository-local `.env.iranti` files are now ignored so local project bindings do not show up as accidental release noise.

### Validation

- Re-ran `npm run build`, `npm run test:runtime-lifecycle`, `npm run test:hardening-fast`, `npm run release:check -- v0.2.34`, `python -m build clients/python --outdir clients/python/dist`, and `python -m twine check clients/python/dist/*` locally before release.

## 0.2.33 - Unreleased

### Fixed

- The command-invocation test shim now works on Linux and macOS as well as Windows, so `codex-setup` workspace-file coverage no longer fails in CI before the actual setup logic runs.
- Restored the `test:hardening-fast` release gate after the `codex-setup` workspace `.mcp.json` regression was added.

### Validation

- Re-ran `npm run test:cli-process-safety`, `npm run build`, and `npm run test:hardening-fast` locally after the cross-platform resolver fix.

## 0.2.32 - Unreleased

### Changed

- `iranti codex-setup` now writes or merges a project-local `.mcp.json` pinned to the active `.env.iranti` binding when setup runs from a bound workspace.
- Iranti-generated `.mcp.json` files now include `IRANTI_PROJECT_ENV` when the local project binding is known, keeping Claude Code and Codex IDE sessions on the same resolved project context.

### Fixed

- Codex IDE sessions no longer have to rely on global MCP registration discovery alone; the bound workspace now carries a deterministic `iranti` MCP server entry with the default Codex agent/source and the resolved project binding.
- Added regressions covering both `codex-setup` workspace-file generation and setup wizard `.mcp.json` scaffolding with pinned `IRANTI_PROJECT_ENV`.

### Validation

- Re-ran `npm run build`, `npm run test:cli-process-safety`, and `npx ts-node tests/runtime-lifecycle/run_setup_upgrade_tests.ts` locally after the workspace `.mcp.json` change.

## 0.2.31 - Unreleased

### Changed

- `iranti --version` and `iranti version` now print a richer labeled version summary in an interactive terminal, including the Iranti CLI version plus the shipped TypeScript and Python package versions.

### Fixed

- Non-interactive `iranti --version` output remains a plain semver string so existing scripts and automation do not break while the terminal view gains the extra package-version detail.
- Added a contract check covering the non-TTY semver output and source-level coverage for the richer TTY version summary.

### Validation

- Re-ran `npm run build` and `npm run test:contracts` locally after the CLI version output change.
- Verified the interactive TTY path prints the labeled Iranti, Node package, and Python package versions.

## 0.2.30 - Unreleased

### Changed

- On Windows, `iranti codex-setup` now resolves Codex through a concrete CLI target such as a bundled `codex.exe` or the npm-installed Codex package entrypoint instead of relying on a PowerShell-only shim lookup.
- `CODEX_CLI_PATH` may now be used to pin Iranti to a concrete Codex CLI path when PATH resolution is unusual on Windows.

### Fixed

- `iranti codex-setup` no longer falsely reports that Codex is missing on Windows when `codex --version` works in PowerShell but child-process resolution would otherwise stop at a `.ps1` or `.cmd` shim.
- Windows `iranti codex-setup` now correctly prefers the installed `iranti mcp` registration target instead of falling back to a local script path when it probes the current CLI from inside the setup flow.
- Added Windows-only regressions covering both direct `codex.exe` selection and npm-shim fallback to the installed Codex package entrypoint.

### Validation

- Re-ran `npm run build` and `npm run test:cli-process-safety` locally on Windows after the resolver change.
- Verified the built `dist/scripts/codex-setup.js` path by registering and removing a disposable Codex MCP entry on this machine.
- Installed `iranti-0.2.30.tgz` globally on Windows and verified that `iranti codex-setup` registers `command: iranti` with `args: mcp` through the packaged CLI path.

## 0.2.29 - Unreleased

### Fixed

- Managed `iranti run --instance ...` and restart flows now treat the instance env as authoritative for startup-critical settings instead of inheriting an ambient parent `DATABASE_URL`. Broken instance env files now fail clearly instead of accidentally booting under CI or shell-level overrides.
- Added a runtime lifecycle regression that proves a managed restart still fails when the parent process provides an unrelated `DATABASE_URL`, preventing workflow env leakage from masking broken instance config.

### Validation

- Re-ran `npm run test:runtime-lifecycle` locally on Windows after restoring a clean install.
- Reproduced the runtime lifecycle suite in a clean `node:24` container after the managed-env authority fix.

## 0.2.28 - Unreleased

### Fixed

- Runtime lifecycle now treats zombie/defunct Unix-like PIDs as exited, so restart and status flows no longer hang behind stale liveness checks after a process has already died.
- `iranti uninstall --all --yes` now excludes the current CLI process family from best-effort process scans, preventing Unix-like uninstall flows from terminating their own launcher or test harness.
- Clean Node 24/Linux builds now pass TypeScript strictness in archive, vector, lock, and SDK paths instead of failing on implicit `any` gaps that local Windows runs had masked.
- Runtime lifecycle test harnesses now preload `ts-node` by resolved path with an explicit project config, so clean Linux CI no longer fails from temp-directory `ts-node/register/transpile-only` resolution.
- DB validation workflows now generate the Prisma client before seeding in jobs that do not already build first, so `npm run seed` no longer fails on missing generated client code in CI.

### Validation

- Re-ran `npm run build` and `npm run test:hardening-fast` locally on Windows after the fixes.
- Reproduced the release fast gate in a clean `node:24` container with `npm ci`, `npm run build`, and `npm run test:hardening-fast`.
- Re-ran the DB-backed release path against a fresh pgvector PostgreSQL instance with `npm run prisma:generate`, `prisma migrate deploy`, `npm run seed`, and `npm run test:hardening-db`.

## 0.2.27 - Unreleased

### Fixed

- Regenerated the root `package-lock.json` under Linux/npm 11 semantics so CI and publish workflows no longer fail at `npm ci` over missing peer-installed Prisma Studio frontend packages.
- Revalidated the clean Linux `npm ci` path in a fresh `node:24` container before release.

## 0.2.26 - Unreleased

### Changed

- `iranti codex-setup` now uses the shared structured command invocation path on Windows instead of a joined `cmd.exe /c` string, keeping Codex MCP registration aligned with the rest of the hardened CLI execution layer.
- The hardening and release-readiness ledgers now explicitly record the final `codex-setup` correction instead of overclaiming that the Windows command-path pass was already fully closed.

### Fixed

- Added a Windows-only regression that proves `iranti codex-setup` delivers literal special-character `--env` values through the Codex registration flow without shell expansion.
- Re-verified the release baseline, fast hardening suite, fresh pgvector-backed DB suite, local secret scan, and `0.2.26` version coordination before release.

## 0.2.25 - Unreleased

### Changed

- `iranti setup` now explains high-friction choices inline before prompting, including runtime mode, runtime root, database mode, provider selection, project binding, project memory entity, and Codex registration.
- `iranti configure instance --interactive` and `iranti configure project --interactive` now explain what each field changes before prompting for values.
- Setup and configure feature specs now document the richer interactive guidance as part of the operator contract.

### Fixed

- Contract coverage now checks for the new interactive-guidance blocks in the setup and configure flows so prompt-level help regressions fail before release.

## 0.2.24 - Unreleased

### Changed

- CLI help now explains what each operator-facing command does, when to use it, and a typical scenario directly in `iranti --help`.
- `iranti setup --help` now includes a flag-by-flag option guide explaining what each setup option means and when it should be used.
- Operator docs now point users at the richer built-in CLI help instead of forcing them to jump straight to the full manual for command selection.

### Fixed

- Contract coverage now checks the actual `--help` and `setup --help` output so help-surface regressions fail the release checks instead of slipping into npm.

## 0.2.23 - Unreleased

### Added

- Pending release notes.

## 0.2.22 - Unreleased

### Added

- `iranti handoff` for writing standardized shared-memory handoff state between Claude Code, Codex, and other tool-driven agent workflows.
- Cross-tool handoff guide, feature spec, and regression coverage for the new CLI handoff flow.

### Changed

- `iranti codex-setup` no longer pins one project binding globally by default; Codex now resolves `.env.iranti` from the active workspace unless `--project-env` is explicitly supplied.
- README and operator docs now reflect the narrower benchmark-backed product position from the `v0.2.21` rerun.
- Docker setup now allows a blank PostgreSQL password input and uses the local-dev default `postgres` instead of forcing a custom secret during interactive bootstrap.

### Fixed

- Runtime env loading now lets the bound instance env override stale app-local `.env` values, preventing MCP/CLI startup from inheriting the wrong `DATABASE_URL`.
- Windows interactive secret prompts now render correctly instead of appearing to hang until the user presses Enter.
- Docker-backed setup now treats published Docker host ports as occupied when suggesting or validating PostgreSQL host ports.
- Docker container inspection and reuse during setup now use the same subprocess/quoting path as the rest of the CLI, fixing container-name reuse failures on Windows.

## 0.2.21 - 2026-03-22

### Changed

- `iranti setup` now asks the Docker bootstrap question in the correct order: optional container provisioning first, then a separate migrate/seed decision.

### Fixed

- Interactive Docker setup no longer tries to create/start the same PostgreSQL container twice after you choose to start or reuse it during the wizard.
- `iranti doctor --instance ... --root ...` now initializes the target instance database before pinging pgvector, so healthy pgvector-backed installs no longer show a false unreachable warning.

## 0.2.20 - 2026-03-21

### Changed

- `iranti setup` now prefers Docker over a plain localhost PostgreSQL listener when Docker is available, because the Docker path guarantees pgvector.
- Setup and quickstart docs now state the local PostgreSQL requirement honestly: local bootstrap needs a pgvector-capable server.

### Fixed

- The published npm package now ships `prisma.config.ts`, so packaged bootstrap can run Prisma migrations instead of failing with a missing datasource config path.
- Packaged setup now preserves `DATABASE_URL` explicitly through the Prisma migration and generate steps.
- Docker setup now fails immediately with a daemon-unreachable error instead of collapsing into a generic bootstrap failure.
- Local PostgreSQL bootstrap now checks pgvector availability up front and fails with a direct remediation path instead of a late Prisma migration stack.
- Windows `iranti uninstall` now completes its global npm self-removal handoff correctly instead of reporting success while leaving the install in place.
- Contract coverage now asserts that `prisma.config.ts` is included in the published npm package.

## 0.2.19 - 2026-03-21

### Fixed

- Corrected `clients/python/pyproject.toml` line endings after the `0.2.18` release prep corrupted one TOML newline and broke Python package builds in CI.
- `v0.2.19` supersedes the failed Python packaging leg from `v0.2.18` without changing the CLI/runtime feature surface introduced there.

## 0.2.18 - 2026-03-21

### Added

- `iranti uninstall` as a first-class lifecycle command with dry-run, JSON output, and explicit `--all` teardown for runtime roots plus project integrations.
- A dedicated CLI uninstall feature spec and temp-root uninstall smoke coverage.

### Changed

- Project cleanup during uninstall now removes only Iranti-owned integration entries from `.mcp.json` and `.claude/settings.local.json`, preserving unrelated MCP servers and Claude settings.
- Operator and public docs now describe uninstall alongside setup, upgrade, and runtime lifecycle flows.

### Fixed

- Windows global npm installs can now uninstall cleanly through a detached handoff instead of trying to remove the live CLI in place.
- README benchmark limits no longer describe the retracted slash-value and resolved `user/main` issues as active defects.

## 0.2.17 - 2026-03-21

### Added

- A dedicated conflict regression for slow LLM arbitration, proving ambiguous writes now escalate cleanly instead of failing with a broken transaction path.

### Changed

- Conflict-resolution model calls now run under an explicit `IRANTI_CONFLICT_RESOLUTION_TIMEOUT_MS` budget.
- Identity-locked write transactions now use configurable Prisma budgets via `IRANTI_TX_TIMEOUT_MS` and `IRANTI_TX_MAX_WAIT_MS`.
- Operator docs and the conflict-resolution spec now document how to keep LLM arbitration below the database transaction ceiling.

### Fixed

- Slow LLM-arbitrated writes no longer bubble up as Prisma interactive transaction timeout failures in the normal ambiguous-conflict path; they now fail closed into human escalation.

## 0.2.16 - 2026-03-21

### Added

- Durable interrupted-session recovery with checkpoint, resume, complete, and abandon flows across the SDK, REST API, and published clients.
- Runtime lifecycle tracking for instance-backed API servers, including persisted runtime metadata, `/health` runtime state, and CLI visibility into running versus stale instances.
- New feature specs and ADR coverage for runtime upgrades and interrupted session recovery.
- Benchmark-backed evidence for session recovery and upgrade durability, plus rerun validation across ingest, relationships, search, observe, attend, persistence, and exact lookup.

### Changed

- `iranti upgrade` can now coordinate a restart for a named running instance with `--restart --instance <name>` after installing a new version.
- Operator docs, quickstart guidance, API docs, and client READMEs now describe checkpointed recovery and runtime lifecycle behavior.
- Iranti's product boundary is now documented more narrowly and honestly: structured memory infrastructure is the strong claim; full semantic-paraphrase retrieval and fully autonomous extraction are not yet.

### Fixed

- The release bump helper now updates the API server version constant correctly after the runtime lifecycle refactor.
- `iranti_ingest` prose extraction is now benchmark-confirmed working in `v0.2.16`.
- Relationship traversal is now benchmark-confirmed working end-to-end through write, read, and depth traversal paths.

## 0.2.15 - 2026-03-21

### Added

- Pending release notes.

## 0.2.14 - 2026-03-21

### Fixed

- On Windows, the detached `npm-global` self-update path now waits for the current `iranti` process to exit before running `npm install -g iranti@latest`, instead of racing the live CLI and hitting `EBUSY`.
- The detached Windows updater now launches from a neutral working directory instead of the active global install folder, which prevents npm from trying to replace a directory that is still in use by the running CLI.

## 0.2.13 - 2026-03-21

### Changed

- Hybrid search now falls back to deterministic in-process semantic scoring when pgvector is unavailable, instead of collapsing to lexical-only ranking.
- TypeScript and Python clients now default `entityHints` from `IRANTI_MEMORY_ENTITY` when callers do not provide explicit hints.
- Mock-provider behavior is now contract-faithful for structured extraction, entity detection, memory classification, and relevance filtering.

### Fixed

- `attend()` no longer defaults ambiguous prompts to `memory_not_needed` so aggressively, and can now recover personal-memory facts like `user/main` without manual entity hints.
- Hybrid search no longer returns zero-signal lexical rows so readily, and external vector backends now receive the metadata needed for filtered searches.
- Python relationship documentation now matches the actual response shape, and the Python smoke test now covers relationship readback.
- The Python smoke script no longer crashes on Windows console encoding when maintenance errors contain non-ASCII characters.

## 0.2.12 - 2026-03-20

### Added

- Global CLI debugging flags:
  - `--debug` for structured diagnostics and stack traces
  - `--verbose` for subprocess trace output
- Internal CLI debugging backlog under `docs/internal/cli_debugging_backlog.md`.

### Changed

- Top-level CLI failures now print stable error codes, fix hints, and optional debug details instead of only a flat error string.
- CLI help and operator docs now advertise the debug and verbose troubleshooting path.

### Fixed

- Common high-friction failures such as missing instances, missing project bindings, and placeholder instance databases now surface more directly actionable remediation.
- Script handoff and subprocess execution now expose clearer trace output when debugging is enabled.

## 0.2.11 - 2026-03-20

### Fixed

- `iranti doctor` now treats `.env.iranti` as a project binding and follows `IRANTI_INSTANCE_ENV` to inspect the bound instance, instead of incorrectly requiring `DATABASE_URL` inside the project binding file.
- Project-bound doctor output now reports bound-instance database, provider, and vector-backend diagnostics directly, which fixes false failures for correctly configured bound repos like `iranti-site`.

## 0.2.10 - 2026-03-20

### Added

- New operator manual covering setup, instances, project bindings, keys, integrations, chat, troubleshooting, and the command map.
- Dedicated subgroup help for `instance`, `configure`, `auth`, and `integrate` command families.
- Explicit project memory mode persistence in `.env.iranti` through `IRANTI_PROJECT_MODE`.
- ADR `005` documenting isolated-per-project onboarding as the default model.

### Changed

- `iranti setup` now defaults to isolated per-project installs instead of shared runtime-first onboarding.
- Setup now recommends `local`, `docker`, or `managed` PostgreSQL more clearly and can create a localhost target database automatically when `psql` is available.
- `iranti install`, `iranti setup`, key-management flows, and project/configuration commands now print cleaner, more structured next steps and easier-to-scan output.
- CLI help now better reflects the real command surface, including `--json`, `--mode`, and `--recursive` options where applicable.
- Required secret prompts and yes/no prompts are more consistent and less noisy.

### Fixed

- `--bootstrap-db` setup bootstrap now works from repo `ts-node` usage as well as bundled installs.
- Remaining garbled CLI separators and help/output readability issues were cleaned up.

## 0.2.9 - 2026-03-20

### Fixed

- On Windows, `iranti upgrade` no longer tries to overwrite the live global npm install in place when the currently running CLI is that same global install.
- The npm-global upgrade step now hands off to a detached updater process in that case, avoiding `EBUSY` rename failures and allowing other selected targets such as the Python client upgrade to continue.

## 0.2.8 - 2026-03-20

### Added

- `iranti handshake` and `iranti attend` as manual Attendant inspection commands for debugging memory briefs and injection decisions outside Claude Code or MCP clients.
- Dependency preflight in `iranti install` and `iranti setup`, reporting Docker, `psql`, `pg_isready`, and local PostgreSQL reachability before deeper setup continues.

### Fixed

- `iranti claude-setup` now generates the current Claude Code hook schema using `matcher` + `hooks`, rather than the legacy `command` + `args` shape.
- Existing Iranti-generated Claude hook files are upgraded in place when they still use the legacy hook schema, while preserving unrelated settings.

## 0.2.7 - 2026-03-19

### Fixed

- `iranti upgrade` on Windows now detects and executes the global npm upgrade path correctly instead of silently falling back to Python-only updates.
- npm-based upgrade checks now use the same Windows command execution strategy as the rest of the CLI, so global package version detection no longer fails with `EINVAL`.

## 0.2.6 - 2026-03-19

### Added

- `iranti claude-setup` for project-local Claude Code MCP and hook scaffolding.
- `iranti integrate claude` and `iranti integrate codex` as integration-focused aliases.

### Changed

- `iranti claude-setup --scan` now supports recursive project discovery and safe `.mcp.json` merging without overwriting other MCP servers.
- `iranti codex-setup` now fails with a direct install/PATH message when the Codex CLI is missing.
- Claude/Codex integration docs and specs now match the shipped CLI surface.

## 0.2.5 - 2026-03-15

### Added

- `iranti doctor` now prints concrete remediation hints in both text and JSON output.
- Internal CLI UX backlog tracking under `docs/internal/cli_ux_backlog.md`.

### Changed

- `iranti upgrade` now supports interactive multi-target selection in a TTY, `--all`, comma-separated `--target` values, and a clearer post-upgrade handoff hint after global npm upgrades.
- Setup, instance configuration, project configuration, and API-key creation prompts are slightly more conversational and now end with clearer next-step guidance.

## 0.2.4 - 2026-03-15

### Added

- Setup wizard prompt copy is slightly more conversational while keeping the same install flow and validation behavior.

## 0.2.3 - 2026-03-15

### Added

- New `iranti chat` slash commands:
  - `/history`
  - `/relate`
  - `/related`
  - `/resolve`
  - `/confidence`
- Expanded chat guide/spec coverage for the full slash-command surface.

### Changed

- `iranti upgrade` now detects install context, checks latest npm/PyPI versions, supports `--check`, `--dry-run`, `--yes`, and `--target`, and verifies the selected upgrade path after execution.
- README and quickstart diagnostics now describe the executable upgrade flow instead of the old advisory-only command.

## 0.2.2 - 2026-03-14

### Fixed

- Added repository metadata to `@iranti/sdk` so npm provenance validation accepts the package during publish.

## 0.2.1 - 2026-03-14

### Added

- Namespace-aware API key authorization for entity-bound KB routes.
- Access-control test suite with `8/8` baseline covering wildcard allow, explicit deny, and dual-entity relationship checks.
- Access-control feature spec and expanded security guidance for namespaced scopes.

### Changed

- KB authorization now supports scopes such as `kb:read:project/acme`, `kb:write:project/*`, and `kb:deny:project/rival`.
- Existing global scopes remain backward-compatible.
- `GET /kb/search`, `POST /kb/batchQuery`, and `/memory/*` remain coarse global-scope endpoints in this release.

## 0.2.0 - 2026-03-14

### Added

- Temporal versioning with `asOf` query support and ordered fact history.
- External TypeScript HTTP client package under `clients/typescript` for `@iranti/sdk`.
- Conflict-resolution benchmark suite with documented `7/16 (44%)` baseline.
- Consistency-model documentation and empirical validation suite with `4/4` baseline.
- Ebbinghaus-style opt-in memory decay with Archivist maintenance coverage.
- Hardened MCP tool descriptions and stdio smoke testing.
- Refined single-entity ingest pipeline with per-fact extraction confidence and clearer provenance.
- Expanded setup wizard flow for port checks, PostgreSQL mode selection, optional Docker bootstrap, and project scaffolding.

### Changed

- README and launch-facing docs now cite measured retrieval, conflict, and consistency results instead of generic claims.
- TypeScript, Python, MCP, seed, and API version surfaces aligned to `0.2.0`.

## 0.1.4 - 2026-03-14

### Added

- Interactive `iranti setup` wizard for first-run onboarding:
  - shared or isolated runtime selection
  - instance creation/update
  - provider-key capture
  - usable Iranti client API key generation
  - optional multi-project bindings
  - optional Claude Code / Codex integration scaffolding
- Installed CLI commands for upstream provider credential management:
  - `iranti list api-keys`
  - `iranti add api-key`
  - `iranti update api-key`
  - `iranti remove api-key`
- Provider-key prompts now support hidden terminal entry and target either a named instance or a project-bound instance via `.env.iranti`.
- Added a reusable `iranti.setup.example.json` template for non-interactive setup automation.

### Changed

- CLI success, warning, and error output now uses colored status labels when running in a TTY.
- Provider-key listings now show which remote providers are configured and which one is the current default.
- CLI help and onboarding docs now point users to direct provider-key commands instead of manual env-file editing.

### Fixed

- OpenAI, Claude, Gemini, Groq, and Mistral provider failures now normalize quota, billing, credit-exhaustion, and rate-limit errors into direct operator-facing messages.

## 0.1.3 - 2026-03-14

### Added

- Codex setup now auto-detects `.env.iranti` from the current working directory and stores it in the MCP registration as `IRANTI_PROJECT_ENV`.

### Changed

- Installed-package Codex setup now binds MCP sessions to the intended project more deterministically.

### Fixed

- Windows `iranti codex-setup` no longer relies on the deprecated `shell=true` child-process path.

## 0.1.2 - 2026-03-14

### Added

- Installed-package integration commands:
  - `iranti mcp`
  - `iranti claude-hook`

### Changed

- Claude Code MCP and hook commands now auto-resolve runtime configuration from project `.env.iranti` plus the linked instance env.
- Claude-facing defaults now honor project binding values such as `IRANTI_AGENT_ID` and `IRANTI_MEMORY_ENTITY`.

### Fixed

- Installed-package Claude Code setup no longer requires direct JS file paths for MCP or hook commands.
- Installed-package Claude Code hooks no longer require hardcoded `DATABASE_URL` when the project binding is present.

## 0.1.1 - 2026-03-14

### Added

- Claude Code MCP integration:
  - `scripts/iranti-mcp.ts`
  - `scripts/claude-code-memory-hook.ts`
  - `docs/guides/claude-code.md`
- Codex MCP integration and setup flow:
  - `npm run codex:setup`
  - `npm run codex:run`
  - `docs/guides/codex.md`
- New CLI diagnostics and runtime commands:
  - `iranti doctor`
  - `iranti status`
  - `iranti upgrade`
- New CLI onboarding and credential-management commands:
  - `iranti configure instance`
  - `iranti configure project`
  - `iranti auth create-key|list-keys|revoke-key`
- `npm run release:bump -- <version>` to update coordinated Node/Python/runtime version surfaces for a release.

### Changed

- Release guide now includes exact command sequences for version bumping, local validation, tagging, and GitHub release creation.
- Iranti MCP startup now resolves repository `.env` files more reliably for Codex and other MCP clients.
- Package publishing workflow is now wired for npm and PyPI release publication from GitHub Releases.
- CLI onboarding docs now include machine/runtime status checks and upgrade guidance.
- Interactive CLI configure flows now support terminal-based prompting with masked secret entry for API keys.

### Fixed

- Removed an accidental local tarball dependency (`file:iranti-0.1.0.tgz`) that broke GitHub Actions package installs.
- Release-quality and contract-check workflows now pass again on `main`.
- Short-lived API key commands now exit cleanly after registry operations instead of hanging on open DB handles.

## 0.1.0 - 2026-03-04

Initial public release.

### Added

- Publishable npm package (`iranti`) with global CLI command support.
- Install strategy commands:
  - `iranti install`
  - `iranti instance create|list|show`
  - `iranti run`
  - `iranti project init`
- Registry-backed API key management:
  - `npm run api-key:create`
  - `npm run api-key:list`
  - `npm run api-key:revoke`
- Route scope authorization middleware and method-based scope enforcement.
- Protected-entry read filtering for SDK/API query surfaces.
- Request rate limiting keyed by authenticated identity.
- Archivist scheduling controls and configurable escalation storage root.
- Python package metadata for PyPI publication (`clients/python/pyproject.toml`).
- AGPL metadata for Python distribution and PyPI publishing guide.
- Release-quality CI workflow with npm and Python package smoke checks.

### Changed

- API docs and quickstart updated to `resource:action` scopes.
- Contracts workflow aligned with current npm/lockfile behavior.
- Build pipeline now generates Prisma client before TypeScript compile.

### Security

- Unified auth handling for standard and compatibility endpoints.
- Added route-level scope guards for `/kb`, `/memory`, `/agents`, `/metrics`, and `/dev`.
- Improved guidance for key scoping and rotation.
