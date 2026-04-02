# Iranti Documentation

Use this folder by trust level:

1. Start with guides, operations, API, and decision docs.
2. Use feature specs when you need exact behavior or edge cases.
3. Use `docs/internal/` only for design notes, validation evidence, and history.

## Start Here

- [Quickstart](guides/quickstart.md) for the shortest path to a working instance and bound project
- [Operator Manual](guides/manual.md) for the full install, runtime, binding, and repair workflow
- [API Reference](API.md) for REST endpoints and auth
- [Guide Index](guides/README.md) for host-specific and topic-specific guides
- [Operations Index](operations/README.md) for deployment, security, troubleshooting, and release-adjacent docs
- [Feature Index](features/README.md) for behavior contracts and edge cases
- [Decision Records](decisions/) for architecture choices and tradeoffs
- [Internal Notes Index](internal/README.md) for supporting notes and historical evidence

## Canonical Sources Of Truth

- `docs/guides/` explains user, operator, and host workflows.
- `docs/operations/` covers deployment, release operations, and troubleshooting posture.
- `docs/features/*/spec.md` defines feature behavior and edge cases.
- `docs/decisions/` records architectural decisions and consequences.
- `docs/API.md` reflects the current REST surface.

If a historical audit, validation log, or implementation note disagrees with one of the sources above, prefer the canonical doc.

## Main Entry Points

### Guides

- [Guide Index](guides/README.md)
- [Quickstart](guides/quickstart.md)
- [Operator Manual](guides/manual.md)
- [Claude Code](guides/claude-code.md)
- [Codex](guides/codex.md)
- [Release Guide](guides/releasing.md)

### Operations

- [Operations Index](operations/README.md)
- [Deployment Guide](operations/DEPLOYMENT.md)
- [Troubleshooting](operations/TROUBLESHOOTING.md)
- [Security Quickstart](guides/security-quickstart.md)
- [Security Audit](operations/SECURITY_AUDIT.md)

### Architecture And Behavior

- [Feature Index](features/README.md)
- [Decision Records](decisions/)
- [Engineering Standards](engineering/CODE_STANDARDS.md)

## Historical Material

Historical audits, release ledgers, fix verification notes, and retired root docs now live under:

- [Internal History Index](internal/history/README.md)
- [Release Artifacts](internal/releases/README.md)

These are useful as evidence and background, but they are not the active product contract.
