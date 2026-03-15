# Iranti Documentation

## Getting Started

- [Quickstart Guide](guides/quickstart.md) - Get up and running in 5 minutes
- [API Reference](API.md) - Complete API documentation
- [Python Client](guides/python-client.md) - Using the Python SDK

## User Guides

- [Chat Guide](guides/chat.md) - Built-in `iranti chat` session flow and slash commands
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

- [Fixes Applied](internal/FIXES_APPLIED.md) - P0/P1 infrastructure fixes
- [Implementation Summary](internal/IMPLEMENTATION_SUMMARY.md) - Architecture overview
- [Testing Guide](internal/TESTING.md) - Running tests
- [Performance Analysis](internal/PERFORMANCE.md) - Benchmarks and optimization
- [Validation Results](internal/validation_results.md) - Goal validation experiments
- [Multi-Framework Validation](internal/MULTI_FRAMEWORK_VALIDATION.md) - CrewAI, LangChain, etc.
- [Goal Validation Summary](internal/GOAL_VALIDATION_SUMMARY.md)

## Architecture

### Decisions

- [001: AGPL License](decisions/001-agpl-license.md)
- [002: Per-Agent Attendants](decisions/002-per-agent-attendants.md)
- [003: Flat KB with Relationships](decisions/003-flat-kb-with-relationships.md)

### Features

- [Chat](features/chat/) - Native CLI chat session
- [Chunking](features/chunking/) - Auto-chunking raw content into facts
- [Conflict Resolution](features/conflict-resolution/) - Librarian conflict handling
- [Resolutionist](features/resolutionist/) - Human escalation review workflow
- [Source Reliability](features/source-reliability/) - Dynamic source scoring
- [Vector Backends](features/vector-backends/) - Pluggable vector similarity backends

### Engineering

- [Code Standards](engineering/CODE_STANDARDS.md) - Style guide and conventions
