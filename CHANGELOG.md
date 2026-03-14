# Changelog

All notable changes to this project are documented in this file.

## 0.2.0 - Unreleased

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
