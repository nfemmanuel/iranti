# Changelog

All notable changes to this project are documented in this file.

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
