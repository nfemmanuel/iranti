# Cross-Tool Handoffs

## Overview
This feature formalizes how Claude Code and Codex collaborate through the same Iranti instance without pretending that one tool can directly resume the other tool's private session. Each tool keeps its own agent-scoped checkpoint state, while durable handoff state lives in shared `task/...` or `project/...` entities that both tools can query and attend against.

## Inputs

| Input | Type | Description |
|---|---|---|
| Claude agent id | string | Stable sender agent id such as `claude_code_main`. |
| Codex agent id | string | Stable receiver agent id such as `codex_code_main`. |
| Shared task entity | string | Canonical `task/<task_id>` entity used for handoff facts. |
| Shared project entity | string | Optional `project/<project_id>` entity for broader task context. |
| Handoff facts | JSON facts | Durable facts such as `status`, `next_step`, `blockers`, `artifacts`, and `current_owner`. |
| CLI handoff helper | command | `iranti handoff task/<task_id> ...` for standardized shared-memory handoff writes. |
| Claude checkpoint | session checkpoint | Agent-scoped checkpoint persisted under Claude's own attendant state. |
| Explicit entity hints | array | Receiver-provided `entityType/entityId` hints passed to `attend()` or `observe()`. |

## Outputs

| Output | Type | Description |
|---|---|---|
| Shared durable handoff | knowledge entries | Facts written to `task/...` and optional `project/...` entities. |
| Sender-local recovery state | checkpoint record | Claude's own session checkpoint, still resumable only by Claude's agent id. |
| Receiver working-memory brief | handshake/attend output | Codex-visible memory populated from shared task/project facts. |
| Follow-up status | knowledge entries | Receiver writes back progress such as `implementation_status` or `handoff_ack`. |

## Decision Tree / Flow
1. Bind both repos or tools to the same Iranti instance.
2. Give each tool a stable, distinct agent id.
3. Choose a canonical shared task entity such as `task/runtime_verification_pass`.
4. When Claude is ready to hand work off:
   - write durable shared facts to the task entity, either directly through `write()` or through `iranti handoff`
   - checkpoint Claude's own session with `entityTargets` including the task entity
5. Claude does **not** expect Codex to resume Claude's session id.
6. Codex starts its own handshake for the shared task.
7. Codex retrieves the shared handoff by:
   - exact `query()` for known keys
   - `attend()` or `observe()` with explicit `entityHints`
8. Codex continues work and writes durable progress back to the same task entity.
9. Claude can later reconvene by querying or attending against the same task entity and seeing Codex's updates.

## Edge Cases

- Cross-agent session recovery is intentionally not automatic; `resumeSession()` is agent-scoped.
- If the sender writes only a checkpoint and no shared task facts, the receiver has no durable cross-tool handoff to consume.
- If the two tools use different task entity names, the handoff fragments and retrieval quality drops.
- If the receiver does not pass explicit `entityHints` for ambiguous prompts, `attend()` may surface less precise memory.
- If both tools write the same task keys concurrently, normal Librarian conflict handling applies.
- If the receiver never writes an acknowledgment/status update, the sender can still recover the last shared handoff state but not proof of pickup.

## Test Results

- DB-backed smoke coverage added in `tests/cross-tool/run_cross_tool_handoff_tests.ts`.
- CLI documentation and help coverage added for `iranti handoff`.
- The smoke test verifies:
  - Claude writes shared handoff facts to `task/...`
  - Claude checkpoints its own session with the shared task in `entityTargets`
  - Codex can query and attend against the shared task using explicit hints
  - Codex writes follow-up status back to the same task
  - Claude can attend later and recover the Codex follow-up

## Related

- `docs/guides/cross-tool-handoffs.md`
- `docs/guides/quickstart.md`
- `docs/guides/manual.md`
- `docs/guides/claude-code.md`
- `docs/guides/codex.md`
- `docs/features/claude-code-mcp/spec.md`
- `docs/features/codex-mcp/spec.md`
- `docs/features/interrupted-session-recovery/spec.md`
- `tests/cross-tool/run_cross_tool_handoff_tests.ts`
