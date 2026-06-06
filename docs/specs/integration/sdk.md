# SDK

**Status:** template  
**Group:** Integration · **Phase:** 6  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

TypeScript SDK exposing the full iranti API for agent builders embedding iranti in their own products.

## Why it matters

Agent builders need a clean integration surface that does not require understanding iranti internals. The SDK is what makes iranti a platform, not just a tool.

## Who the SDK is for

Developers building AI-powered tools, products, and workflows for other people. They are not using iranti directly — they are embedding it in what they build so that their users get persistent memory as part of the product. For this group, the quality of the API surface and the documentation is as important as what iranti does.

## What the SDK exposes

- Session management: start, end, register a host
- Query interface: retrieve context for a question or task
- Fact management: write, read, archive facts explicitly (for cases where the developer wants direct control)
- Rules management: add and inspect stored rules and preferences
- System status: health check, version, metrics
- Checkpoint management: read and write checkpoints

## Design principles

- The SDK should feel like a first-class TypeScript library, not a wrapper around an internal API
- All methods are fully typed — no `any`
- Errors are typed and meaningful — not raw HTTP errors
- The happy path is simple; advanced options are available but not required
- The SDK surface should be stable — breaking changes require a major version bump

## User stories

- As an agent builder, I want to call `iranti.query(task)` and get back relevant context without understanding how iranti stores or retrieves it.
- As an agent builder, I want full TypeScript types for all SDK methods so that I catch errors at compile time.
- As an agent builder, I want the SDK to handle session lifecycle automatically so that I do not have to manage handshakes and registrations manually.

## Acceptance criteria

- [ ] The SDK is published as a TypeScript package
- [ ] All public methods are fully typed
- [ ] A simple agent can be built using only the SDK without reading iranti internals
- [ ] Session lifecycle (start, end, handshake) is handled automatically by the SDK
- [ ] The SDK includes a working code example in the documentation

## Technical notes

_Fill in when ready to build (Phase 6). Cover: package structure, method signatures, session management abstraction, error types, versioning policy._

## Dependencies

- MCP integration complete (Phase 5) — SDK exposes the same capabilities
- Attendant complete (Phase 3)

## Related specs

- [CLI](cli.md) — CLI and SDK share underlying API surface
- [Python client](python-client.md) — Python equivalent for the same API
- [MCP host support](mcp-host-support.md) — MCP and SDK serve different integrator types
