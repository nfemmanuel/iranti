# Host Memory Call Audit - 2026-03-28

## Scope

This audit checks whether the main Iranti-facing hosts actually follow the
intended working-memory pattern:

1. `handshake()` at session start
2. `attend()` before reply generation

The point is to separate:

- paths Iranti owns directly and can guarantee
- paths that depend on an external MCP host behaving correctly

## Findings

### Claude Code hook path

Status: PASS

Observed in:

- `scripts/claude-code-memory-hook.ts`
- `tests/claude-hook/run_claude_hook_tests.ts`

Behavior:

- `SessionStart` calls `handshake()`
- `UserPromptSubmit` calls `attend()` before emitting retrieved memory
- `Stop` optionally persists strict assistant summaries when auto-remember is enabled

This is the strongest first-party path because the hook lifecycle gives Iranti
real startup and pre-turn insertion points.

### Interactive chat path

Status: PASS

Observed in:

- `src/chat/index.ts`

Behavior:

- chat startup calls `handshake()`
- every typed turn calls `attend()` before the LLM request is assembled

This is a fully first-party host, so the pattern is enforced rather than merely
recommended.

### Generic MCP server path

Status: PARTIAL / CONTRACT OK, HOST ENFORCEMENT LIMITED

Observed in:

- `scripts/iranti-mcp.ts`
- `tests/mcp/smoke_test.ts`

Behavior:

- MCP tool descriptions explicitly require `iranti_handshake` at session start
- MCP tool descriptions explicitly require `iranti_attend` before each reply
- if a host skips `handshake()`, `iranti_attend()` auto-bootstraps a handshake

Limitation:

- Iranti cannot force an arbitrary external MCP host to call `iranti_handshake`
  at startup
- Iranti can only:
  - document the contract clearly
  - make `attend()` the minimum safe fallback
  - return bootstrap metadata when `attend()` had to recover the missed handshake

### Codex path

Status: PARTIAL / DEPENDS ON MCP HOST BEHAVIOR

Observed in:

- `scripts/codex-setup.ts`
- `docs/guides/codex.md`
- `docs/features/codex-mcp/spec.md`

Behavior:

- setup registers `iranti mcp`
- setup now prints the expected host pattern explicitly
- docs now say:
  - `iranti_handshake` at session start when available
  - first-turn `iranti_handshake` if no startup hook exists
  - `iranti_attend` before every reply generation

Limitation:

- Codex itself is still an external MCP host from Iranti's perspective
- Iranti cannot guarantee that every Codex client session will call `handshake()`
  unless the host product itself implements that lifecycle

## Conclusion

Iranti's own first-party hosts are already aligned:

- Claude hook: `handshake()` at startup, `attend()` pre-turn
- chat: `handshake()` at startup, `attend()` pre-turn

For Codex and other MCP clients, the strongest reliable rule is:

- require `handshake()` when the host supports a startup hook
- treat `attend()` as mandatory before reply generation
- rely on `attend()` auto-bootstrap so a missed handshake does not silently
  degrade retrieval

## Release Read

This is good enough for a release with an honest claim:

- Iranti first-party paths consistently follow the handshake/attend lifecycle
- external MCP hosts are strongly guided and safely backstopped, but not fully
  enforceable from inside Iranti alone
