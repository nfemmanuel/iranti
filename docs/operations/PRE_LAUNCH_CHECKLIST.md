# Pre-Launch Checklist

Use this before treating an Iranti instance as a real shared environment rather than local experimentation.

## Runtime And Database

- [ ] `iranti status` reports the intended instance and runtime metadata
- [ ] `iranti doctor --instance <name>` passes or only shows understood warnings
- [ ] PostgreSQL is stable, reachable, and pgvector-capable
- [ ] backup and restore procedures are documented
- [ ] escalation and request-log paths are outside the repo

## Access And Security

- [ ] per-app or per-service API keys exist
- [ ] scopes are narrowed to the minimum required access
- [ ] namespace-aware scopes are used where appropriate
- [ ] the API is behind TLS or an internal network boundary for non-local use
- [ ] secrets are stored in env or secret managers, not in tracked files

## Host Integrations

- [ ] every project has a valid `.env.iranti`
- [ ] Claude Code projects have current `iranti claude-setup` scaffolding
- [ ] Codex projects have current `iranti codex-setup` registration and workspace files where needed
- [ ] shared-memory projects intentionally use `--mode shared`
- [ ] isolated projects intentionally use the default isolated binding model

## Observability And Operations

- [ ] `/health` returns the expected instance and provider metadata
- [ ] operator runbooks exist for restart, key rotation, and broken bindings
- [ ] rate limiting is configured appropriately for the environment
- [ ] monitoring or alerts exist for repeated 401, 403, 429, and 5xx patterns

## Release And Compatibility

- [ ] package versions are aligned before release
- [ ] release checks and hardening tests have run
- [ ] migration or compatibility notes exist for any user-facing surface change
- [ ] onboarding docs still match the current `setup`, `project init`, and host-integration flow

## Final Go / No-Go Questions

- [ ] Can a new project be bound without hand-editing runtime files?
- [ ] Can a broken instance be diagnosed with `status`, `doctor`, and `instance show`?
- [ ] Can one compromised client key be rotated without disturbing unrelated clients?
- [ ] Can another operator understand the deployment without reading internal history docs?
