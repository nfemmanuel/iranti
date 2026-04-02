# Closed Beta Checklist — 2026-04-02

This is the current working checklist for deciding whether Iranti is ready for a small closed beta.

## Beta Bar

Closed beta is reasonable when:

1. durable writes are immediately queryable on the primary after success
2. relevant fresh state is visible to another active agent without heavy rediscovery cost
3. setup/runtime/operator surfaces are truthful enough that users are not silently pointed at the wrong authority
4. first-party host memory discipline is strong enough that long runs leave usable shared breadcrumbs
5. the remaining gaps are known, bounded, and survivable for a small invited cohort

## Ranked Remaining Blockers

### 1. Semantic retrieval / multi-hop weakness
Risk: high

- Why it matters:
  the product story still outruns the search layer when relevant facts require semantic or relationship-heavy discovery.
- Exit criteria:
  targeted validations show materially better retrieval for issue/task/project state beyond lexical matching.

### 2. Broader relevance routing beyond bounded one-hop cases
Risk: medium-high

- Why it matters:
  the current routing now covers directly watched entities and one relationship hop, but not broader graph-aware prioritization.
- Exit criteria:
  relationship expansion is deliberate and explainable for the most common project/task/issue patterns without flooding unrelated agents.

### 3. Attend autonomous reliability
Risk: medium

- Why it matters:
  `attend()` is much better than before, but there are still edge cases where it needs explicit hints or alternate retrieval angles.
- Exit criteria:
  short recall prompts and common repo-state questions behave reliably enough that invited beta users are not constantly second-guessing the memory layer.

### 4. Operator and host UX polish
Risk: medium

- Why it matters:
  even when the core state is correct, confusing authority/binding/error surfaces can still make the system feel broken.
- Exit criteria:
  `status`, `doctor`, setup surfaces, and host rules make the active authority and expected memory loop obvious.

## Already Strong Enough For Closed Beta

- handshake/attend discipline is far stricter than before
- write/checkpoint density and file-action logging are substantially better
- write availability is explicitly verified
- stale-brief refresh works
- watched-entity fallback works
- same-process invalidation exists
- cross-process invalidation over shared PostgreSQL is now covered by a focused regression (`tests/cross-tool/run_cross_process_invalidation_tests.ts`) and passed on 2026-04-02
- one-hop graph-aware freshness routing exists
- setup/create/configure now persist or backfill `IRANTI_API_KEY_PEPPER`
- upgrade preservation is covered by focused setup/upgrade tests

## Recently Closed

### Cross-process invalidation
Closed on 2026-04-02

- Why it mattered:
  separate hosts/processes could otherwise miss the same-process invalidation path, weakening the “agent A wrote it, agent B can use it on the next turn” continuity story.
- What now backs the claim:
  `src/lib/sharedStateInvalidation.ts` emits shared wake-ups over PostgreSQL `LISTEN/NOTIFY`, and `tests/cross-tool/run_cross_process_invalidation_tests.ts` passed against the current runtime on 2026-04-02.
- Remaining truth:
  this closes the invalidation propagation gap, not the broader semantic retrieval/routing weaknesses below.

## Execution Order

1. tighten semantic retrieval / multi-hop weakness with focused validations
2. expand relevance routing only where the beta workflows need it
3. run a closed-beta validation sweep and decide whether remaining gaps are acceptable for invited users
