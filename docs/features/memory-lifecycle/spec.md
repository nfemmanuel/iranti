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

## Outputs
| Output | Type | Description |
|---|---|---|
| pre-turn retrieval decision | JSON | `attend()` result including `shouldInject`, `reason`, and surfaced facts. |
| explicit prompt facts | durable writes | Personal or project facts extracted from direct user statements. |
| assistant summary facts | durable writes | Strict summaries persisted through Claude `Stop` or explicit MCP response memory tools. |
| lifecycle reason | string | Explanation such as `project_next_step_recall` or `favorite_recall_prompt`. |

## Lifecycle Policy
1. Before each user turn is answered, call `attend()`.
2. If the prompt is a mandatory recall prompt, bypass model discretion and require retrieval before answering.
3. Mandatory recall prompts currently include:
   - `what is my favorite ...`
   - `what is my ...`
   - `what is the next step`
   - `what is the blocker`
   - `what did we decide`
   - `who is the current owner`
4. Mandatory recall prompts should also prioritize the exact key being asked about inside the resolved entity.
5. After a user turn, if `IRANTI_AUTO_REMEMBER=true`, persist only narrow explicit prompt facts.
6. Personal prompt facts route to `IRANTI_PERSONAL_MEMORY_ENTITY` and default to `user/main`.
7. Project prompt facts route to `IRANTI_MEMORY_ENTITY`.
8. Personal prompt facts are stored as direct user memory rather than generic hook/tool memory so later user corrections can replace older hook-written values.
9. Before a memory-dependent action, the host integration should retrieve memory if no turn retrieval has happened yet.
10. Do not poll during arbitrary tool execution or during generation unless the action itself is a memory operation.
11. After an assistant response, persist only strict durable summaries such as:
    - `The next step is ...`
    - `The blocker is ...`
    - `We decided ...`
    - `The current owner is ...`
12. Codex and other MCP clients without a `Stop` hook use `iranti_remember_response` explicitly for the post-response step.

## Conflict / Correction Rules
- Direct user correction of a personal-memory fact should override an older non-human hook-written value for the same key.
- This rule is intentionally narrow:
  - personal entity only (`user/*` or `person/*`)
  - personal-memory keys only such as `favorite_*`, `home_city`, `hometown`, and `likes`
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

## Test Results
- `tests/memory-retrieval-regressions.ts` verifies personal recall prefers `IRANTI_PERSONAL_MEMORY_ENTITY` over project contamination.
- `tests/memory-lifecycle/run_memory_lifecycle_tests.ts` verifies:
  - mandatory project recall for `what is the next step?`
  - prompt-side personal correction through `UserPromptAutoRemember`
  - explicit `user_stated` correction overriding an older hook-written personal fact

## Related
- `src/attendant/AttendantInstance.ts`
- `src/lib/autoRemember.ts`
- `src/librarian/index.ts`
- `scripts/claude-code-memory-hook.ts`
- `scripts/iranti-mcp.ts`
