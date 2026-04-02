# Closed Beta Checklist - 2026-04-02

This file now serves as the closeout snapshot for the 2026-04-02 closed-beta decision.

Closed-beta blockers were cleared on 2026-04-02. Remaining work is cleanup, operator polish, and follow-on product refinement rather than release-blocking uncertainty.

## Beta Bar

Closed beta is reasonable when:

1. durable writes are immediately queryable on the primary after success
2. relevant fresh state is visible to another active agent without heavy rediscovery cost
3. setup/runtime/operator surfaces are truthful enough that users are not silently pointed at the wrong authority
4. first-party host memory discipline is strong enough that long runs leave usable shared breadcrumbs
5. the remaining gaps are known, bounded, and survivable for a small invited cohort

## Decision

Status: ready for a small invited closed beta

- Core continuity blockers reviewed during the sprint are now closed.
- The canonical issue inventory for `project/iranti` is at `open=0`.
- Remaining work is non-blocking cleanup and product polish, not a reason to hold the cohort behind stale blocker language.

## Closed During This Sprint

### 1. Semantic retrieval / multi-hop weakness
Closed on 2026-04-02

- What changed:
  filtered hybrid search now bridges strong semantic hits back onto the filtered target entity across up to two relationship hops.
- Evidence:
  `tests/search/run_hybrid_multihop_search_tests.ts` and the resolved canonical issue fact `issue_search_semantic_multihop_weak`.

### 2. Attend autonomous reliability
Closed on 2026-04-02

- What changed:
  parse failures now safe-default to memory for non-empty non-greeting natural-language turns.
- Evidence:
  `tests/session-recovery/run_session_recovery_tests.ts` and the resolved canonical issue fact `issue_attend_autonomous_classifier_unreliable`.

### 3. Cross-process invalidation
Closed on 2026-04-02

- What changed:
  shared invalidation now propagates over PostgreSQL `LISTEN/NOTIFY` so separate processes do not miss same-process-only wakeups.
- Evidence:
  `tests/cross-tool/run_cross_process_invalidation_tests.ts`.

### 4. Downstream compatibility drift
Closed on 2026-04-02

- What changed:
  the stale control-plane docs were updated and the downstream compatibility audit now passes.
- Evidence:
  `npm run test:contracts-downstream` and the resolved canonical issue fact `issue_compatibility_contract_drift_downstream`.

## Remaining Non-Blocking Follow-Up

### 1. Broader relevance routing beyond bounded one-hop cases
Priority: medium

- Why it still matters:
  the current routing is materially better, but broader graph-aware prioritization remains follow-on product work rather than a closed-beta blocker.

### 2. Operator and host UX polish
Priority: medium

- Why it still matters:
  even when the core state is correct, confusing authority, binding, or host guidance can still make the system feel rough.

### 3. Cleanup and hygiene
Priority: medium

- Why it still matters:
  sprint residue in issue inventory, escalation traces, and internal notes can mislead the next session even after the product blockers are closed.

### 4. Memory loop inspectability UX polish
Priority: low

- Why it still matters:
  injected facts now carry `lastUpdated` and `source`, but there is no per-fact injection reason exposed at the product surface. Operators and testers cannot yet see why a specific fact was chosen for injection (heuristic match, entity hint, watched-entity fallback, etc.). A future iteration can surface `injectionReason` on each fact and expose the `used`/`helpful` feedback metadata once write-side usage tracking lands.

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
- **protocol enforcement turn-gate**: strict enforcement blocks KB discovery before handshake or attend; validated by `test:api-surfaces-protocol-enforcement` and `test:mcp-protocol-enforcement`
- **injected fact freshness**: each fact in attend/observe responses now carries `lastUpdated` so agents and operators can see how fresh injected memory is at the time of injection
- **project learning snapshot**: `iranti bind` writes a bounded snapshot of project structure and metadata to a stable `codebase/<name>_<hash>` entity; this gives the first session useful context without a full crawl

## Execution Order

1. keep the closed-beta surface truthful in issue inventory, docs, and checklists
2. clean non-blocking residue from sprint implementation and validation
3. improve operator polish and broader routing only where real beta usage shows the need
