# Iranti consistency model

## Overview
Iranti provides per-identity serialized writes for a single `(entityType, entityId, key)` on one PostgreSQL primary. The Librarian wraps each write in a PostgreSQL transaction and acquires a transaction-scoped advisory lock for that identity triple before reading or mutating state. Reads are not wrapped in a shared snapshot transaction; they rely on PostgreSQL committed-read behavior. The practical result is: same-key writes are serialized, completed writes are immediately visible to later reads on the same primary, and agent read paths do not observe partially-written rows, but multi-query read flows such as `observe()` and `attend()` are not globally snapshot-consistent.

## Write semantics
Concurrent writes to the same identity triple are serialized by [`withIdentityLock()`](c:\Users\NF\Documents\Projects\iranti\src\library\locks.ts), which:

- opens a Prisma transaction
- acquires `pg_advisory_xact_lock(hash(entityType, entityId, key))`
- runs the full read-decide-write sequence inside that transaction

The Librarian write entry point [`librarianWrite()`](c:\Users\NF\Documents\Projects\iranti\src\librarian\index.ts) does the following inside that lock:

1. reads the current row with [`findEntry()`](c:\Users\NF\Documents\Projects\iranti\src\library\queries.ts)
2. decides whether to create, reject, replace, or escalate
3. performs archive/current-row mutations inside the same transaction
4. writes an idempotency receipt in the same transaction

This gives Iranti a strong guarantee for conflicting writes to the same key:

- there is a single total order for completed writes to one identity triple
- the second writer always reasons over the first writer's committed result, never over a partially-updated row
- callers do not see leaked unique-constraint races under normal operation because the lock serializes the critical section before the unique index on [`knowledge_base`](c:\Users\NF\Documents\Projects\iranti\prisma\schema.prisma) is exercised

What Iranti does **not** provide:

- no global sequential consistency across unrelated keys
- no formal causal metadata or vector clocks across agents
- no cross-key transaction for multi-fact updates

So the honest claim is: **per-key serialized writes, not full-system sequential consistency and not a formal causal consistency implementation.**

## Read-after-write guarantee
After a write call returns successfully, a later read on the same PostgreSQL primary sees that committed result. There is no read-replica path or asynchronous propagation layer in the codebase.

This guarantee is strongest in the normal case:

- `write()` resolves only after the transaction commits
- `query()` and `queryAll()` then issue ordinary committed reads

What a racing reader sees while a write is still in progress is weaker:

- read paths do **not** take the advisory lock
- read paths are not wrapped in an explicit snapshot transaction
- they can therefore read the last committed version while the writer is still in flight

Because the write path is transactional, these racing reads still do **not** see a partial row. They either see the pre-commit state or the post-commit state.

One implementation caveat: the code does not set an explicit Prisma transaction isolation level, so behavior follows the database default. On PostgreSQL that is ordinarily `READ COMMITTED`. If an operator changes the database default, Iranti inherits that behavior.

## Librarian escalation state
Conflict escalation is implemented in [`escalateConflict()`](c:\Users\NF\Documents\Projects\iranti\src\librarian\index.ts) as one transaction:

1. re-read the current row inside the locked transaction
2. insert a `segment_closed` archive row covering the uncontested interval up to `escalationTs`
3. insert an `escalated` archive row with `resolutionState = pending`
4. delete the current row from `knowledge_base`
5. create or append to the escalation file

The observable state depends on timing:

- while that transaction is still open, outside readers continue to see the old committed current row
- after the transaction commits, `knowledge_base` has no current row for that identity
- at that point, normal `query(entity, key)` returns not found
- temporal `query(entity, key, { asOf })` and `history()` can still surface the archived contested interval

That means Iranti does **not** preserve a readable current value during pending human escalation. It intentionally prefers “current truth unavailable” over exposing contested data as current truth.

Resolution is also atomic. In [`processEscalationFile()`](c:\Users\NF\Documents\Projects\iranti\src\archivist\index.ts), the Archivist:

1. updates the pending `escalated` archive row to close its `validUntil`
2. marks it `resolved`
3. inserts the restored or replacement current row into `knowledge_base`

Those steps happen in one transaction, so readers do not see a half-resolved state.

## Observe / attend isolation
`observe()` and `attend()` do not run inside a database transaction or shared snapshot. `attend()` makes an LLM-backed “memory needed?” decision first, then delegates to `observe()`. `observe()` then:

- optionally calls the extraction model
- resolves hinted/detected entities
- runs `findEntriesByEntity()` per resolved entity
- filters in memory
- records access in a separate write

The consequences are:

- they do **not** see uncommitted rows from in-flight writes
- they do **not** see partially-written rows
- they **can** observe a mix of old and new committed states across separate queries if another write commits during the middle of a long `observe()` / `attend()` call

So the consistency level for these memory reads is best described as **statement-level committed reads**, not snapshot isolation.

For a single entity+key being mutated by the Librarian:

- before the write commits, `observe()`/`attend()` sees the old committed row or no row
- after the write commits, they see the new committed row or the escalated “no current row” state
- they do not see the delete/insert transition mid-transaction

## Known limitations
- The advisory lock is per identity triple only. Cross-key invariants are not serialized.
- There is no explicit transaction isolation level in code, so the database default governs read phenomena.
- `observe()` and `attend()` are not snapshot-consistent across the whole operation.
- Idempotency receipts are checked once before entering the lock. The write receipt itself is still committed transactionally, but replay suppression is not itself lock-guarded.
- Escalation file writes happen after database state changes inside the same Prisma callback, but file I/O is outside PostgreSQL's durability model. The database and escalation folder are not one atomic commit domain.
- There is no formal distributed consistency story across multiple database primaries, replicas, or regions.

Stronger guarantees would require:

- explicit documented transaction isolation settings
- snapshot or repeatable-read wrappers for multi-query read flows
- formal causal metadata for cross-agent ordering
- a transactional outbox or similar mechanism for DB-plus-filesystem coordination

## Empirical validation
Empirical validation is implemented in [run_consistency_tests.ts](c:\Users\NF\Documents\Projects\iranti\tests\consistency\run_consistency_tests.ts).

Current validation baseline:

- Concurrent write serialization: `PASS`
- Read-after-write visibility: `PASS`
- Escalation state integrity: `PASS`
- Observe isolation against uncommitted writes: `PASS`

Summary: `4/4` tests passed on the local validation database.
