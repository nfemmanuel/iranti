# Release Readiness Checklist

Current status for maintaining Iranti after the 0.1.0 public release.

## Published Artifacts

- [x] npm package published: `iranti@0.1.0`
- [x] PyPI package published: `iranti==0.1.0`
- [x] Global CLI install verified: `npm install -g iranti` + `iranti help`
- [x] Python install/import verified in fresh venv

## Security Baseline

- [x] API key authentication enabled
- [x] Route-level scope enforcement enabled
- [x] Rate limiting middleware enabled on protected routes
- [x] Key create/list/revoke scripts available
- [ ] Add external security review (recommended)
- [ ] Add secret scanning in CI (recommended)

## CI and Quality Gates

- [x] Build and contract checks in CI
- [x] npm package dry-run and packaging checks
- [x] Python package build + twine checks
- [x] Release-quality smoke workflow (`.github/workflows/release-quality.yml`)
- [ ] Add nightly dependency audit job

## Docs and Onboarding

- [x] README install and integration flow updated
- [x] API docs reflect current auth and scope model
- [x] Python client docs updated for `pip install iranti`
- [x] Security quickstart guide added
- [x] Changelog added (`CHANGELOG.md`)
- [ ] Add versioned release notes for each tagged release

## Operational Readiness

- [ ] Define backup/restore runbook for PostgreSQL
- [ ] Add monitoring/alerting runbook for 401/403/429 and latency spikes
- [ ] Document production TLS/reverse-proxy reference deployment

## Recommended Next Polishing Steps

1. Add `iranti doctor` CLI command for environment and config diagnostics.
2. Add compatibility aliasing for legacy scope labels where needed.
3. Add release automation workflows for npm and PyPI (tag-driven).
4. Add integration tests for multi-agent long-run scenarios.
