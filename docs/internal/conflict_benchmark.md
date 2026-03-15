# Conflict Benchmark

## Methodology

Iranti's conflict benchmark measures how the current Librarian behaves under adversarial writes rather than under basic retrieval-only scenarios. All benchmark entities are fictional (`project/starfall_nexus`, `person/valdris_ohen`, etc.) so the LLM provider cannot rely on world knowledge from training data.

The benchmark is organized into four scenario classes:

1. **Direct contradiction**
   - Same `entity + key`
   - Different values
   - Measures whether the Librarian rejects, updates, or escalates explicitly rather than silently accepting contradictory writes

2. **Temporal conflict**
   - Same `entity + key`
   - Different `validFrom` timestamps
   - Measures whether source reliability, conflict handling, and temporal history work together in a reproducible way

3. **Cascading conflict**
   - Same entity
   - Different keys whose values are internally inconsistent
   - Measures whether Iranti catches cross-key contradictions rather than only same-key conflicts

4. **Multi-hop conflict**
   - Contradiction spans multiple related entities
   - Measures whether graph relationships participate in conflict reasoning

## Why Fictional Entities

The benchmark uses invented names so the LLM provider cannot "know" the answer from pretraining. This keeps the benchmark focused on Iranti's memory and conflict machinery rather than on accidental world knowledge.

## Score Interpretation

The runner reports:

- `PASS` for scenarios the current system handled correctly
- `FAIL` for scenarios expected to pass but that did not
- `XFAIL` for known capability gaps that are intentionally benchmarked but not yet implemented
- `XPASS` for scenarios marked as known gaps that unexpectedly succeed

The total score is `PASS + XPASS` over all cases. This gives one headline number while still keeping the missing capabilities visible.

## Current Scope

The current benchmark intentionally does **not** modify Librarian behavior to make scenarios pass. It measures today's system honestly.

Current benchmark coverage now includes:

- same-key contradiction handling
- deterministic `validFrom` tie-breaking for equal-score temporal conflicts
- deterministic same-entity cross-key contradiction checks
- narrow relationship-aware contradiction checks for selected graph patterns

Current benchmark limitations:

- contradiction handling is still rule-bounded rather than ontology-complete
- graph-aware checks are targeted to explicit relationship and key combinations, not arbitrary multi-hop inference

## How To Run

The benchmark requires:

- a reachable PostgreSQL database in `DATABASE_URL`
- seeded Staff Namespace entries
- the mock LLM provider

Recommended command:

```bash
npm run test:conflict-benchmark
```

If your default local database is unhealthy, point the benchmark at a clean validation database first:

```bash
DATABASE_URL=postgresql://postgres:password@localhost:5433/iranti_temporal npm run test:conflict-benchmark
```

## Current Baseline

Validated on March 14, 2026 against a clean local PostgreSQL validation database:

```text
Conflict resolution benchmark
------------------------------
Direct contradiction: 4/4
Temporal conflict:    4/4
Cascading conflict:   4/4
Multi-hop conflict:   4/4
------------------------------
Total: 16/16 (100%)
```

Interpretation:

- Iranti is strong on direct same-key contradiction handling.
- Temporal history now uses a deterministic recency tie-break for equal-score contradictory writes.
- Same-entity cross-key contradictions are now rejected deterministically for covered rule pairs.
- Relationship-aware contradiction checks now catch the benchmark's covered one-hop and narrow multi-hop graph cases.

## Related

- `tests/conflict/run_conflict_benchmark.ts`
- `src/librarian/index.ts`
- `src/library/queries.ts`
- `docs/internal/validation_results.md`
