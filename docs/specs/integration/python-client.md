# Python client

**Status:** template  
**Group:** Integration · **Phase:** 6  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

Python HTTP client for the REST API.

## Why it matters

Many agent frameworks and research tools are Python-first. A Python client means iranti is accessible to the Python ecosystem without requiring Python developers to call raw HTTP.

## Scope

The Python client is an HTTP client over iranti's REST API — not a port of the full TypeScript SDK. It exposes the same capabilities but through Python idioms.

The REST API that the Python client wraps must be designed and stabilised as part of Phase 6.

## User stories

- As a Python developer building an AI agent framework, I want to integrate iranti without having to use the TypeScript SDK or write raw HTTP calls.
- As a researcher building a Python-based agent, I want to store and retrieve memory from iranti using a library that feels natural in Python.

## Acceptance criteria

- [ ] The Python client is published as a Python package (pip installable)
- [ ] The client covers the minimum surface: session start, query, fact read, status check
- [ ] The REST API the client wraps is documented
- [ ] A working Python example demonstrates iranti integration with a minimal agent
- [ ] Error responses from the API are surfaced as typed Python exceptions

## Technical notes

_Fill in when ready to build (Phase 6). Cover: REST API design, Python package structure, async vs. sync client decision, authentication handling._

## Dependencies

- REST API designed and stabilised (Phase 6)
- SDK complete (Phase 6) — REST API is shared by both

## Related specs

- [SDK](sdk.md) — TypeScript equivalent
- [CLI](cli.md) — shares the same underlying API surface
