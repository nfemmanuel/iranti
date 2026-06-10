# PRD: Phase 1.2 — Context Window Observation

**Status:** accepted
**Phase:** 1.2 · **Date:** 2026-06-10 · **Author:** Claude (with NF)
**Related:** master PRD §8 (context window observation), [spec: context-window-observation](../../specs/retrieval/context-window-observation.md), backlog `CORE-1`, audit `goals_audit_2026_06` divergence 1

---

## 1. Summary

`iranti_attend` gains an optional `currentContext` parameter: the agent's currently visible context window. When provided, iranti suppresses any relevant fact whose value is already present in that window, so it never spends tokens re-injecting what the agent can already see. The call returns an `alreadyPresent` count so the saving is measurable. This is the smallest honest step toward the master PRD's "check the window before injecting" requirement — full correction-of-stale-context semantics remain Phase 3.

## 2. Problem & motivation

Master PRD §8 ("Context window observation") is explicit: *"Before injecting anything, the Attendant checks what is already in the agent's context window. If accurate information is already present, it stays silent."* The shipped attend has **no** notion of the window — it returns its full ranked, capped fact set unconditionally. This is a regression against iranti v0, whose attend already accepts `currentContext` and reports an `alreadyPresent` count.

The cost of the gap is direct: every turn re-injects facts the agent is already holding, which is exactly the token waste iranti exists to eliminate (master PRD §2: *"Iranti is lightweight… the total cost in tokens should be negligible"*). It also undercuts the product's headline metric — tokens saved — because we inject redundantly.

## 3. Goals & non-goals

**Goals**
- attend accepts an optional `currentContext` and suppresses facts already present in it.
- The response reports how many facts were suppressed (`alreadyPresent`), so token savings are observable.
- Backward compatible: with no `currentContext`, behaviour is identical to Phase 1.1.

**Non-goals**
- **Correction of stale context.** Detecting that the window holds an *outdated* value and surfacing the correct one is Phase 3 — it requires conflict/staleness reasoning that does not exist yet. Phase 1.2 only suppresses exact-enough matches; it never rewrites.
- **Rule suppression.** Rules are cheap imperatives whose value is convergence across hosts; they are always injected. Suppression applies to facts only.
- **Semantic presence detection.** Phase 1.2 uses normalized substring matching, not embeddings. A paraphrase of a fact in the window will not be detected as present until Phase 3.

## 4. Scope

**In**
- `currentContext?: string` on `attendInputSchema` with a tool-facing description.
- Normalized substring presence check (`isAlreadyPresent`) over fact values.
- Suppression applied before the `MAX_TOTAL_FACTS` cap, so the injected set prefers genuinely-new facts.
- `alreadyPresent: number` on `AttendResult`.
- The checkpoint is never suppressed (resumption state must always surface).
- Tests + smoke coverage.

**Out (deferred)**
- Stale-context correction → Phase 3.
- Semantic/paraphrase presence → Phase 3 (pgvector).
- Backfill: re-querying the library for more candidates when suppression empties the injected set → Phase 3, when retrieval becomes two-pass and graph-aware.

## 5. Design decisions & rationale

- **Optional, not required → why:** hosts that cannot cheaply report their window (most MCP hosts today) must degrade gracefully to "inject everything," exactly as the spec's acceptance criterion demands. Making it required would break every current host.
- **Substring match on normalized text, not token diff → why:** it is deterministic, dependency-free, and good enough to catch the common case (a fact verbatim in the window). The alternative — embedding both sides and comparing — is Phase 3 infrastructure and overkill for an exact-presence check. Rejected for now.
- **Minimum needle length of 8 chars → why:** very short values ("UTC", "v2") produce false-positive substring hits against unrelated window text. Below the threshold we do not suppress — a missed suppression is cheap, a wrong one hides a real fact.
- **Suppress before the total cap → why:** if we capped first and suppressed second, a window full of already-known facts could shrink the injected set below its budget while genuinely-new facts sat just outside the cap. Suppressing first fills the 20 slots with facts the agent does not already have.
- **Access-tracking counts suppressed facts as accessed → why this is acceptable:** `readRelevantFactsByEntity` access-tracks the per-entity pool at the library layer before attend suppresses. A fact that was relevant *and* already in context was still relevant this turn — counting it as a retrieval is defensible signal for Phase 4, not a leak. Revisit only if decay calibration shows it matters.
- **Checkpoint exempt from suppression → why:** the active checkpoint is resumption state; a new session must always receive it even if a stale copy is in the window. It is returned on its own channel and never filtered.

## 6. Schema / API changes

No database schema change.

`attendInputSchema` gains:
```
currentContext?: string   // agent's visible window; facts present here are suppressed
```

`AttendResult` gains:
```
alreadyPresent: number    // count of relevant facts suppressed as already-in-context
```

`facts` continues to be the to-inject list — now post-suppression.

## 7. Acceptance criteria

- [ ] attend accepts `currentContext`; omitting it reproduces Phase 1.1 behaviour exactly.
- [ ] A fact whose value appears verbatim in `currentContext` is absent from `facts` and counted in `alreadyPresent`.
- [ ] A relevant fact **not** in `currentContext` is still returned.
- [ ] The active checkpoint is returned even when its text is present in `currentContext`.
- [ ] Suppression is applied before the `MAX_TOTAL_FACTS` cap.
- [ ] Rules are never suppressed.
- [ ] Full suite + smoke green.

## 8. Deltas from the master PRD

None in direction — this moves attend toward §8, it does not diverge from it. It is a **partial** implementation: presence-suppression now, stale-correction later. The partial scope is the delta and is called out as a non-goal rather than a silent gap.

It also continues the standing reframe that attend (not a separate observe daemon) is where window observation lives in iranti-core, because the MCP transport is request/response — the host hands iranti the window on the same call. This matches §8's "the host must give iranti read access to the current context or report its state as part of the retrieval request."

## 9. Risks & open questions

- **False positives from substring matching.** A fact value that is a common phrase could match unrelated window text and be wrongly suppressed. Mitigated by the 8-char floor; fully resolved only by semantic matching in Phase 3.
- **Window fidelity is the host's job.** If a host reports a truncated or stale window, suppression quality degrades. This is the host-integration risk the master PRD §13 already names; iranti behaves correctly given honest input.
- **Open:** should `alreadyPresent` feed the Phase 2.5 `attend_log` telemetry as a "tokens saved" proxy? Likely yes — noted for the metrics build.

## 10. Verification

- New `attend — context window observation` test group in `mcp-tools.test.ts` (suppression, non-suppression, no-context backward-compat, checkpoint-exempt).
- New smoke check: passing `currentContext` containing a known fact value suppresses it and reports `alreadyPresent ≥ 1`.
- `pnpm build` clean, full vitest green, smoke green.

## Changelog
- 2026-06-10 — proposed
- 2026-06-10 — accepted (design settled in audit discussion; currentContext + dedup, correction deferred to Phase 3)
- _pending_ — shipped
