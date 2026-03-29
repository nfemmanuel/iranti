# Memory Lifecycle

## Overview
This feature defines how Iranti should participate across an agent turn without depending only on model discretion. The lifecycle is intentionally narrow: retrieve before answers when memory is required, persist only explicit user facts after user turns, persist only strict durable summaries after agent responses, and avoid mid-turn polling.

## Inputs
| Input | Type | Description |
|---|---|---|
| latest user prompt | string | The new user turn being evaluated for retrieval and explicit fact capture. |
| current context | string | The visible context window used by `attend()` and `observe()`. |
| explicit entity hints | string[] | Optional canonical entity hints in `entityType/entityId` format. |
| `IRANTI_MEMORY_ENTITY` | string? | Project-scoped memory target. |
| `IRANTI_PERSONAL_MEMORY_ENTITY` | string? | Personal-memory target, defaulting to `user/main`. |
| `IRANTI_AUTO_REMEMBER` | boolean? | Enables narrow post-user-turn and post-response capture. |
| durable assistant summary | string | A strict assistant response such as `The next step is ...` or `We decided ...`. |
| checkpoint payload | object | Optional checkpoint state including `currentStep`, `nextStep`, `openRisks`, `recentOutputs`, `entityTargets`, and `notes`. |

## Outputs
| Output | Type | Description |
|---|---|---|
| pre-turn retrieval decision | JSON | `attend()` result including `shouldInject`, `reason`, and surfaced facts. |
| explicit prompt facts | durable writes | Personal or project facts extracted from direct user statements. |
| assistant summary facts | durable writes | Strict summaries persisted through Claude `Stop` or explicit MCP response memory tools. |
| shared checkpoint breadcrumbs | durable writes | Compact `checkpoint_*` facts written to explicit entity targets so other agents can resume shared work without inheriting private attendant state. |
| fact properties | JSON | Structured metadata describing `memoryScope`, `capturePhase`, `durableClass`, `canonicalKey`, and merge strategy. |
| session ledger rows | structured events | Operator-visible `staff_events` rows that can be queried through `GET /memory/ledger` or `listSessionLedger()` for audit-style reconstruction of first-party Iranti host activity. |
| lifecycle reason | string | Explanation such as `project_next_step_recall` or `favorite_recall_prompt`. |

## Lifecycle Policy
1. Before each user turn is answered, call `attend()`.
2. If the prompt is a mandatory recall prompt, bypass model discretion and require retrieval before answering.
3. Mandatory recall prompts currently include:
   - `what is my favorite ...`
   - `what is my ...`
   - `how tall am I`
   - `what is my height`
   - `what is the next step`
   - `what is the blocker`
   - `what did we decide`
   - `who is the current owner`
4. Mandatory recall prompts should also prioritize the exact key being asked about inside the resolved entity.
5. After a user turn, if `IRANTI_AUTO_REMEMBER=true`, persist only narrow explicit prompt facts.
6. Personal prompt facts route to `IRANTI_PERSONAL_MEMORY_ENTITY` and default to `user/main`.
7. Project prompt facts route to `IRANTI_MEMORY_ENTITY`.
8. Personal prompt facts are stored as direct user memory rather than generic hook/tool memory so later user corrections can replace older hook-written values.
9. Explicit MCP writes for personal-memory keys also route to the configured canonical personal entity, so a client cannot accidentally fork durable personal memory into `user/nf` vs `user/main` for the same project/session.
10. Before a memory-dependent action, the host integration should retrieve memory if no turn retrieval has happened yet.
11. Do not poll during arbitrary tool execution or during generation unless the action itself is a memory operation.
12. After an assistant response, persist only strict durable summaries such as:
    - `The next step is ...`
    - `The current step is ...`
    - `The blocker is ...`
    - `We decided ...`
    - `The current owner is ...`
    - `Open risks are ...`
    - `Important artifacts are ...`
    - `File created ...`
    - `File moved ...`
    - `File renamed ...`
    - `File deleted ...`
    - `The failed path is ...`
    - `The alternative route is ...`
13. During active work, MCP clients should use `iranti_checkpoint` explicitly at meaningful milestones so shared progress persists without waiting for a final answer.
14. Codex and other MCP clients without a `Stop` hook use `iranti_remember_response` explicitly for the post-response step.
15. For list-like project facts such as open risks, artifacts, file changes, failed paths, and alternative routes, append and dedupe rather than blindly replacing the prior value.
16. Auto-remembered facts should carry structured metadata describing scope, capture phase, durable class, canonical key, and merge behavior so retrieval and audit tools can explain why the fact exists.
17. `checkpoint()` remains agent-scoped for private session recovery, but when `entityTargets` are supplied it also writes shared checkpoint breadcrumbs:
   - `checkpoint_summary`
   - `checkpoint_current_step`
   - `checkpoint_next_step`
   - `checkpoint_open_risks`
18. Shared checkpoint breadcrumbs should not replace the canonical project facts such as `next_step` or `decision`; they are resumability hints, not the sole source of truth.

## Conflict / Correction Rules
- Direct user correction of a personal-memory fact should override an older non-human hook-written value for the same key.
- This rule is intentionally narrow:
  - personal entity only (`user/*` or `person/*`)
- personal-memory keys only such as `favorite_*`, `height`, `home_city`, `hometown`, and `likes`
  - incoming source must be a direct-user source such as `user_stated` or `UserPromptAutoRemember`
  - existing `HumanReview` truth is not auto-overwritten by this rule

## Edge Cases
- Empty prompt: no retrieval and no writes.
- Slash commands: prompt auto-remember ignores them.
- Generic chit-chat: retrieval may still remain heuristic unless the prompt matches a mandatory recall class.
- Missing `IRANTI_MEMORY_ENTITY`: project-scoped prompt facts are skipped; personal facts still default to `user/main`.
- Missing `IRANTI_AUTO_REMEMBER`: no automatic prompt or summary persistence occurs.
- Personal correction prompts with changed wording but same fact key still target the canonical key, e.g. `favorite` and `favourite`.
- Arbitrary assistant prose is ignored by post-response persistence.
- Shared checkpoint breadcrumbs are demoted below canonical task facts during observe/attend selection so checkpoints help recovery without crowding out the main `next_step`, `blocker`, or artifact facts.
- Session ledger reads are best-effort operator observability. If an instance is missing the `staff_events` table, `GET /memory/ledger` returns `SESSION_LEDGER_UNAVAILABLE` instead of pretending the ledger is simply empty.

## Test Results
- `tests/memory-retrieval-regressions.ts` verifies personal recall prefers `IRANTI_PERSONAL_MEMORY_ENTITY` over project contamination.
- `tests/memory-retrieval-regressions.ts` also verifies `how tall am I?` recalls canonical personal memory even when the stored fact still lives under legacy `person/user`.
- `tests/memory-lifecycle/run_memory_lifecycle_tests.ts` verifies:
  - mandatory project recall for `what is the next step?`
  - prompt-side personal correction through `UserPromptAutoRemember`
  - explicit `user_stated` correction overriding an older hook-written personal fact
  - project-side capture of `current_step`, `open_risks`, `important_artifacts`, `recent_file_changes`, `failed_paths`, and `alternative_routes`
  - structured fact metadata and append-dedupe merge semantics for project durability
- `tests/cross-tool/run_cross_tool_handoff_tests.ts` verifies shared checkpoint breadcrumbs are written to explicit entity targets and remain secondary to canonical shared task facts during observe/attend retrieval.
- `tests/staff-events/run_session_ledger_tests.ts` verifies `listSessionLedger()` and `GET /memory/ledger` return bounded structured event rows and surface `SESSION_LEDGER_UNAVAILABLE` cleanly when the migration is missing.

## Related
- `src/attendant/AttendantInstance.ts`
- `src/lib/autoRemember.ts`
- `src/librarian/index.ts`
- `scripts/claude-code-memory-hook.ts`
- `scripts/iranti-mcp.ts`
