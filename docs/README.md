# Iranti Documentation

## Canonical Sources Of Truth

- `docs/guides/` explains operator and developer workflows.
- `docs/features/*/spec.md` defines feature behavior, edge cases, and validation expectations.
- `docs/decisions/` records architectural decisions and their consequences.
- `docs/operations/` covers deployment, troubleshooting, and operational posture.
- `docs/internal/` is supporting material only. Start with [`docs/internal/README.md`](internal/README.md) when you need internal notes; do not treat internal summaries as canonical product truth unless a guide/spec/decision explicitly points to them.

## Getting Started

- [Operator Manual](guides/manual.md) - Full install, binding, keys, integrations, and troubleshooting reference
- [Quickstart Guide](guides/quickstart.md) - Get up and running in 5 minutes
- [API Reference](API.md) - Complete API documentation
- [Python Client](guides/python-client.md) - Using the Python SDK

## User Guides

- [Chat Guide](guides/chat.md) - Built-in `iranti chat` session flow and slash commands
- [Cross-Tool Handoffs](guides/cross-tool-handoffs.md) - Shared-task collaboration between Claude Code and Codex without cross-agent session leakage
- [Conflict Resolution](guides/conflict-resolution.md) - How Iranti handles conflicting facts
- [LLM Providers](guides/providers.md) - Configuring Gemini, OpenAI, Claude, etc.
- [Security Quickstart](guides/security-quickstart.md) - Key scopes, rotation, and deployment baseline
- [Vector Backends](guides/vector-backends.md) - Switching hybrid search vector storage between pgvector, Qdrant, and ChromaDB

## Operations

- [Deployment Guide](operations/DEPLOYMENT.md) - Production deployment
- [Security Audit](operations/SECURITY_AUDIT.md) - Security checklist and threat model
- [Pre-Launch Checklist](operations/PRE_LAUNCH_CHECKLIST.md) - Final checks before going live
- [Troubleshooting](operations/TROUBLESHOOTING.md) - Common issues and solutions
- [Migration: Escalation Format](operations/MIGRATION_ESCALATION_FORMAT.md) - Breaking change guide

### Publishing

- [Publishing to Docker Hub](operations/PUBLISHING_DOCKER.md)
- [Publishing to PyPI](operations/PUBLISHING_PYPI.md)
- [Changelog](../CHANGELOG.md)

## Internal

- [Internal Notes Index](internal/README.md) - Trust levels, categories, and where to look first inside `docs/internal/`
- [Testing Guide](internal/TESTING.md) - Running tests
- [Compatibility Backlog](internal/compatibility_backlog.md) - Compatibility gates, migration coverage, and release follow-ups
- [Consistency Model](internal/consistency_model.md) - Internal consistency semantics and validation context
- [Decay Design Note](internal/decay.md) - Memory-decay design note

### Historical And Supporting Artifacts

- [Implementation Summary](internal/IMPLEMENTATION_SUMMARY.md) - Historical implementation summary, not canonical product contract
- [Fixes Applied](internal/FIXES_APPLIED.md) - Historical fixes ledger
- [Validation Results](internal/validation_results.md) - Validation log and historical experiment record
- [Multi-Framework Validation](internal/MULTI_FRAMEWORK_VALIDATION.md) - Framework-specific validation notes
- [Goal Validation Summary](internal/GOAL_VALIDATION_SUMMARY.md) - Early validation summary
- [Performance Analysis](internal/PERFORMANCE.md) - Performance notes and historical guidance

## Historical Root Artifacts

These files remain useful history, but they are not the canonical product contract:

- `docs/AUDIT_2026_03_23.md`
- `docs/FIXES_SUMMARY.md`
- `docs/PRODUCTION_HARDENING.md`
- `docs/CONCURRENCY_SAFETY.md`
- `docs/POLICY_RESOLUTION.md`
- `docs/issue_*_fix_verification.md`
- `docs/BACKLOG.local.md`

Release ledgers are also non-canonical and live under `docs/internal/releases/`, for example:

- `docs/internal/releases/0.2.26/HARDENING_0_2_X_PLAN.md`
- `docs/internal/releases/0.2.26/HARDENING_0_2_X_EXECUTION.md`
- `docs/internal/releases/0.2.26/HARDENING_0_2_X_VALIDATION.md`
- `docs/internal/releases/0.2.26/HARDENING_0_2_X_RELEASE_RECOMMENDATION.md`
- `docs/internal/releases/0.2.26/RELEASE_0_2_26_EXECUTION.md`

When these disagree with guides/specs/decisions/operations docs, prefer the canonical sources above.

## Architecture

### Decisions

- [001: AGPL License](decisions/001-agpl-license.md)
- [002: Per-Agent Attendants](decisions/002-per-agent-attendants.md)
- [003: Flat KB with Relationships](decisions/003-flat-kb-with-relationships.md)
- [005: Isolated Onboarding Default](decisions/005-isolated-onboarding-default.md)
- [006: Runtime Lifecycle Safety](decisions/006-runtime-lifecycle-safety.md)
- [007: Compatibility Policy](decisions/007-compatibility-policy.md)

### Features

- [Chat](features/chat/) - Native CLI chat session
- [CLI Attendant Debug](features/cli-attendant-debug/) - Manual handshake/attend inspection commands
- [CLI Uninstall](features/cli-uninstall/) - Package removal plus optional runtime/project cleanup
- [Chunking](features/chunking/) - Auto-chunking raw content into facts
- [Compatibility Contracts](features/compatibility-contracts/) - Stability rules, deprecation discipline, and release-gate expectations
- [Conflict Resolution](features/conflict-resolution/) - Librarian conflict handling
- [Cross-Tool Handoffs](features/cross-tool-handoffs/) - Shared-task collaboration model for Claude Code and Codex
- [Interrupted Session Recovery](features/interrupted-session-recovery/) - Checkpointed mid-task recovery on return
- [Resolutionist](features/resolutionist/) - Human escalation review workflow
- [Runtime Upgrades](features/runtime-upgrades/) - Staged upgrade plus supervised restart instead of live overwrite
- [Source Reliability](features/source-reliability/) - Dynamic source scoring
- [Vector Backends](features/vector-backends/) - Pluggable vector similarity backends

### Engineering

- [Code Standards](engineering/CODE_STANDARDS.md) - Style guide and conventions
