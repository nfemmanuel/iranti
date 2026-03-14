# Changelog

All notable changes to this project are documented in this file.

## 0.1.1 - Unreleased

### Added

- `iranti doctor` for env and credential diagnostics.
- `iranti status` for runtime root, binding, and instance visibility.
- `iranti upgrade` for canonical npm/Python upgrade guidance.
- `npm run release:bump -- <version>` to update version-bearing files consistently.
- Codex MCP setup flow and guide.

### Changed

- Release guide now includes exact command sequences for version bumping and tagging.
- Iranti MCP server now resolves `.env` more reliably for Codex and other MCP clients.

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
