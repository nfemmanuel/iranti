# Memory Lifecycle

## Overview
This feature defines how Iranti should participate across an agent turn without depending only on model discretion. The lifecycle is intentionally narrow: retrieve before answers when memory is required, persist only explicit user facts after user turns, persist only strict durable summaries after agent responses, and avoid arbitrary mid-turn polling. Knowledge-changing actions should still leave durable breadcrumbs as they happen rather than waiting only for the final answer.

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
| checkpoint payload | object | Optional checkpoint state including `currentStep`, `nextStep`, `openRisks`, `recentOutputs`, structured `fileChanges`, `entityTargets`, and `notes`. |

## Outputs
| Output | Type | Description |
|---|---|---|
| pre-turn retrieval decision | JSON | `attend()` result including `shouldInject`, `reason`, and surfaced facts. |
| explicit prompt facts | durable writes | Personal or project facts extracted from direct user statements. |
| assistant summary facts | durable writes | Strict summaries persisted through a host-specific post-response integration or explicit response-memory tools. |
| shared checkpoint breadcrumbs | durable writes | Compact `checkpoint_*` facts written to explicit entity targets so other agents can resume shared work without inheriting private attendant state. |
| checkpoint file-action trail | durable writes | Structured `recent_file_changes` facts written during checkpoint persistence when `fileChanges` are supplied, so active work can log each file action without waiting for a final summary. |
| fact properties | JSON | Structured metadata describing `memoryScope`, `capturePhase`, `durableClass`, `canonicalKey`, merge strategy, and deterministic semantic labels such as `semanticDomain`, `semanticIntent`, `temporalScope`, and `semanticTags`. |
| session ledger rows | structured events | Operator-visible `staff_events` rows that can be queried through `GET /memory/ledger` or `listSessionLedger()` for audit-style reconstruction of first-party Iranti host activity. |
| session ledger learnings | bounded brief appendix | Optional handshake-time synthesized lessons about recent host, recall, and persistence behavior so Attendant can surface engineering learnings after compaction without replaying the full event stream. |
| advisory learning profile | bounded retrieval guidance | Optional host/task/global advisory cues derived from recent session-ledger signals so `attend()` can nudge ambiguous turns toward retrieval, prioritize learned keys, and surface checkpoint-discipline reminders without replacing mandatory recall or explicit hints. |
| usage guidance | structured reminder | Explicit tool-level reminder returned by `attend()` and `observe()` so hosts and agents can see when to call them and what they do not replace. |
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
12. After any action that changed knowledge state, persist the resulting breadcrumb through `write()` and/or `checkpoint()` instead of waiting only for the end of the turn.
13. Knowledge-changing actions include file edits, validations, web searches or research, confirmed findings, architecture or workflow decisions, and other actions that would force a later session to rediscover what changed.
14. When that new breadcrumb should change what is loaded next, call `attend()` again before continuing.
15. After an assistant response, persist only strict durable summaries such as:
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
16. During active work, MCP clients should use `iranti_checkpoint` explicitly at meaningful milestones so shared progress persists without waiting for a final answer.
17. Hosts without a post-response hook use `iranti_remember_response` explicitly for the post-response step.
18. For list-like project facts such as open risks, artifacts, file changes, failed paths, and alternative routes, append and dedupe rather than blindly replacing the prior value.
19. Auto-remembered facts should carry structured metadata describing scope, capture phase, durable class, canonical key, merge behavior, and deterministic semantic labels so retrieval and audit tools can explain why the fact exists without needing an LLM re-interpretation pass.
20. `checkpoint()` remains agent-scoped for private session recovery, but when `entityTargets` are supplied it also writes shared checkpoint breadcrumbs:
   - `checkpoint_summary`
   - `current_step`
   - `next_step`
   - `open_risks`
21. When `checkpoint().actions` is supplied alongside `entityTargets`, Iranti should also append those structured activity breadcrumbs into the shared entity's canonical `recent_actions` fact so later sessions can see which commands, validations, searches, and decisions already happened.
22. When `checkpoint().fileChanges` is supplied alongside `entityTargets`, Iranti should also append those structured file actions into the shared entity's canonical `recent_file_changes` fact so file edits are logged as they happen rather than only in a final summary.
23. Shared checkpoint breadcrumbs should not replace the canonical project facts such as `next_step` or `decision`; they are resumability hints, not the sole source of truth.
24. Successful shared checkpoints should emit `checkpoint_written` in the ledger, and strict assistant-summary persistence should emit `summary_written`, so the ledger explains not just durable facts but how they were created.
25. Handshake may append a bounded `sessionLedgerLearnings` appendix plus synthetic `system/session_ledger/recent_learning_*` working-memory entries when recent first-party host learnings are relevant to recovery.
26. Session-ledger learnings should prefer synthesized engineering lessons over raw event blurbs, for example:
    - host reliability lessons
    - recall-policy lessons
    - shared persistence lessons
27. Handshake may also synthesize an advisory-first learning profile from recent host-scoped, task-scoped, and global ledger signals.
28. Advisory learning may nudge `attend()` toward retrieval only for ambiguous prompts and may add learned priority keys to `observe()`, but it must not override force-inject, mandatory recall, or explicit entity-hint behavior.
29. When recent ledger evidence shows a session completed substantial retrieval work without any checkpoint or durable write, handshake and reconvene may append a stricter under-logging reminder to the operating rules so the next pause stores shared progress before another interruption.
30. Under-logged runs are non-compliant for first-party Iranti hosts. When applicable, the reminder should name the missing breadcrumb categories explicitly, such as what was found, what worked, what failed, what changed, and what happens next.
31. First-party host failure paths and LLM provider fallback paths should emit truthful ledger rows when the process has a DB-backed emitter, so recovery can explain what failed and what still worked.
32. `attend()` responses should also carry explicit usage guidance that reinforces the required call loop: handshake at session start, attend before each reply, attend before and after knowledge discovery, persist breadcrumbs after knowledge-changing actions, then attend again when those breadcrumbs should change what is loaded next.
33. `observe()` responses should also carry explicit usage guidance clarifying that observe is retrieval-only and does not replace `attend()`, `write()`, or `checkpoint()`.
34. First-party hosts with a graceful shutdown path should attempt a best-effort checkpoint before exit when active work exists, preserving recent outputs, structured actions, file changes, and resumability notes without falsely marking the session completed.
35. When `attend()` receives relevant entity hints and those entities have newer durable writes than the active brief timestamp, it should treat the brief as stale, bias toward refresh, and prioritize the fresh keys instead of defaulting to “memory not needed.”
36. Active attendants may also keep a same-process watched-entity set plus pending invalidation markers so the next ambiguous `continue`/`status`/`what changed` turn can refresh fresh shared state once without requiring the host to resend the same explicit entity hint.
37. Freshness routing may expand one relationship hop beyond the directly watched entities, so a watched project can refresh on a fresh breadcrumb written to a directly related issue/task/entity without requiring the host to restate both scopes.
38. When the current process has active watched attendants and the primary PostgreSQL connection is available, fresh writes may also emit a cross-process invalidation notification over `LISTEN/NOTIFY` so another process can enqueue the same entity/key wake-up without waiting for a same-process write path.

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
- Short recall prompts about prior project state such as `Next step?`, `What bugs are left?`, or `What changed?` should be treated as positive retrieval cues even when they are too short to count as a generic substantive prompt.
- Missing `IRANTI_MEMORY_ENTITY`: project-scoped prompt facts are skipped; personal facts still default to `user/main`.
- Missing `IRANTI_AUTO_REMEMBER`: no automatic prompt or summary persistence occurs.
- Personal correction prompts with changed wording but same fact key still target the canonical key, e.g. `favorite` and `favourite`.
- Arbitrary assistant prose is ignored by post-response persistence.
- Shared checkpoint breadcrumbs are demoted below canonical task facts during observe/attend selection so checkpoints help recovery without crowding out the main `next_step`, `blocker`, or artifact facts.
- Structured `recent_actions` breadcrumbs should stay compact and recovery-oriented. They are for material commands, tests, validations, searches, or decisions that later sessions would otherwise rerun blindly, not for every shell keystroke.
- `observe()` may feel passive in some hosts because it is retrieval-only; hosts may use it for background warming, but the response contract should still explain that role explicitly.
- Session ledger reads are best-effort operator observability. First-party ledger writes and reads should lazily create the `staff_events` table when it is missing; `SESSION_LEDGER_UNAVAILABLE` is reserved for cases where that bootstrap still cannot succeed.
- Handshake-time ledger learnings are intentionally bounded and deduped. They should surface recent high-signal host/debugging outcomes, not dump the entire session ledger into working memory.
- Synthesized ledger learnings should stay engineering-focused for now. Broader collaborative/non-engineering learnings are future scope, not part of the current contract.
- Checkpoint-discipline reminders are advisory and evidence-based, but they should be strict once triggered. They should appear only when recent ledger activity shows meaningful retrieval without a matching checkpoint or durable write, not on every handshake.

## Core vs Host-Specific Boundary
- Core lifecycle behavior is host-agnostic. The Attendant, MCP surface, SDKs, auto-remember policy, mandatory recall logic, checkpoint persistence, semantic tagging, and session-ledger learning rules should work the same regardless of which AI host is calling them.
- Host-specific integrations are responsible only for transport and trigger shape: startup hooks, post-response hooks, local scaffold files, default host labels, and any host-native configuration files or command wiring.
- New provider integrations should reuse this lifecycle contract rather than redefining it. A new host should declare:
  - how it triggers handshake at session start
  - how it triggers pre-reply `attend()`
  - whether it has a post-response hook or must rely on explicit `iranti_remember_response`
  - which local config files or launcher commands are host-specific
- Claude and Codex are current first-party host implementations of this shared contract, not the contract itself.

## Test Results
- `tests/memory-retrieval-regressions.ts` verifies personal recall prefers `IRANTI_PERSONAL_MEMORY_ENTITY` over project contamination.
- `tests/memory-retrieval-regressions.ts` also verifies `how tall am I?` recalls canonical personal memory even when the stored fact still lives under legacy `person/user`.
- `tests/memory-lifecycle/run_memory_lifecycle_tests.ts` verifies:
  - mandatory project recall for `what is the next step?`
  - heuristic project recall for recap-style prompts such as `bring me up to speed`, `catch me up`, `where did we leave off`, `what did we learn?`, and status/progress summaries
  - classifier parse failures default to memory when the prompt is substantive and the turn is already scoped by current context or explicit entity hints
  - classifier parse failures also default to memory for unscoped prompts that still carry explicit project-state cues such as status, progress, blockers, findings, or decisions
  - classifier parse failures safe-default to memory for terse non-greeting work prompts instead of silently falling through to `false`
  - prompt-side personal correction through `UserPromptAutoRemember`
  - explicit `user_stated` correction overriding an older hook-written personal fact
  - project-side capture of `current_step`, `open_risks`, `important_artifacts`, `recent_file_changes`, `failed_paths`, and `alternative_routes`
  - structured fact metadata and append-dedupe merge semantics for project durability
  - deterministic semantic tagging for personal preferences, project risks, and file-change durability
- `tests/memory-retrieval-regressions.ts` verifies handshake can seed scoped watched entities so hintless `observe()` prompts like `What is the next step?` can recover project facts without explicit `entityHints`.
- `tests/cross-tool/run_cross_tool_handoff_tests.ts` verifies shared checkpoint breadcrumbs are written to explicit entity targets and remain secondary to canonical shared task facts during observe/attend retrieval.
- `tests/cross-tool/run_cross_tool_handoff_tests.ts` also verifies structured `checkpoint().actions` are appended into shared `recent_actions` durability during active work.
- `tests/cross-tool/run_cross_tool_handoff_tests.ts` also verifies structured `checkpoint().fileChanges` are appended into shared `recent_file_changes` durability during active work.
- `tests/staff-events/run_session_ledger_tests.ts` verifies `listSessionLedger()` and `GET /memory/ledger` return bounded structured event rows, and that missing `staff_events` tables self-heal before retrying the query.
- `tests/session-recovery/run_session_recovery_tests.ts` verifies handshake can append bounded session-ledger learnings to recovery-time working memory without disrupting normal checkpoint recovery.
- `tests/session-recovery/run_session_recovery_tests.ts` also verifies handshake appends an evidence-based checkpoint-discipline reminder to the operating rules when the advisory profile marks the recent session history as under-checkpointed.
- `tests/session-recovery/run_session_recovery_tests.ts` also verifies short recall prompts such as `What bugs are left?` and `Next step?` are handled by the positive heuristic path rather than relying on advisory learning or LLM parse success.
- `tests/staff-events/run_session_ledger_tests.ts` also verifies the advisory learning profile can synthesize a checkpoint-discipline reminder from recent ledger activity that lacked any checkpoint or durable write.

## Related
- `src/attendant/AttendantInstance.ts`
- `src/lib/autoRemember.ts`
- `src/librarian/index.ts`
- `docs/features/claude-code-mcp/spec.md`
- `docs/features/codex-mcp/spec.md`
- `scripts/claude-code-memory-hook.ts`
- `scripts/iranti-mcp.ts`
