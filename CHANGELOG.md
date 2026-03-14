# Changelog

All notable changes to this project are documented in this file.

## 0.1.2 - Unreleased

### Added

- Pending release notes.

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
