# Issue 10: Concurrency Safety Implementation

## Problem

Race conditions could corrupt the "single source of truth" when multiple writes hit the same `(entityType, entityId, key)` simultaneously. Without serialization, the read-decide-write flow could result in:

- Double archiving of the same entry
- Lost conflict log entries
- Non-deterministic escalation decisions
- Updates overwriting each other without proper conflict tracking

## Solution

Implemented **PostgreSQL advisory locks** to serialize writes to the same identity triple.

## Implementation

### 1. Advisory Lock Wrapper (`src/library/locks.ts`)

```typescript
export async function withIdentityLock<T>(
    identity: { entityType: string; entityId: string; key: string },
    fn: (tx: TransactionClient) => Promise<T>
): Promise<T>
```

- Acquires transaction-scoped advisory lock using `pg_advisory_xact_lock`
- Lock key derived from stable hash of identity triple
- Lock automatically released when transaction commits/rolls back
- Guarantees only one write can mutate a given identity triple at a time

### 2. Transaction-Aware Query Functions (`src/library/queries.ts`)

All query functions now accept optional `db` parameter:

```typescript
findEntry(query, db?)
createEntry(input, db?)
updateEntry(query, updates, db?)
archiveEntry(entry, reason, supersededBy?, db?)
appendConflictLog(entryId, event, db?)
getWriteReceipt(requestId, db?)
createWriteReceipt(data, db?)
```

This allows them to run within a transaction context or standalone.

### 3. Serialized Write Flow (`src/librarian/index.ts`)

```typescript
export async function librarianWrite(input: EntryInput) {
    // Fast-fail checks (outside lock)
    if (input.requestId) {
        const receipt = await getWriteReceipt(input.requestId);
        if (receipt) return idempotentReplay;
    }
    enforceWritePermissions(...);
    
    // Critical section (inside lock)
    return withIdentityLock(identity, async (tx) => {
        // All DB operations use tx
        const existing = await findEntry(query, tx);
        // ... conflict resolution ...
        await createEntry(input, tx);
        await createWriteReceipt(data, tx);
    });
}
```

**Key design decisions:**

- Idempotency check happens **before** lock (fast path for replays)
- Permission checks happen **before** lock (fail fast)
- All DB reads/writes inside lock use same transaction client
- Escalation files use `requestId` in filename to prevent duplicates

## Testing

### Concurrency Torture Test (`scripts/test_concurrent_writes.ts`)

Validates race condition prevention:

```bash
npm run test:concurrency
```

**Test scenario:**
- 25 simultaneous writes to same `(entityType, entityId, key)`
- Different values (MIT vs Cambridge)
- Different confidence scores (50-74)
- Different agents and sources

**Assertions:**
- ✓ Exactly 1 active KB entry (confidence > 0)
- ✓ All 25 writes get unique receipts
- ✓ No duplicate archives
- ✓ Conflict logs are consistent
- ✓ No unique constraint violations

## Performance Characteristics

**Lock granularity:** Per identity triple (not table-level or entity-level)

- Writes to `researcher/jane/affiliation` don't block writes to `researcher/jane/email`
- Writes to `researcher/jane/affiliation` don't block writes to `researcher/bob/affiliation`
- Only writes to the **exact same** `(entityType, entityId, key)` are serialized

**Lock duration:** Minimal (only during read-decide-write, not during LLM calls)

- LLM reasoning for conflict resolution happens **outside** the lock
- Only the final DB operations are serialized

**Deadlock prevention:** Single lock per operation (no lock ordering issues)

## Acceptance Criteria

✅ Concurrent writes to same identity triple produce deterministic results  
✅ Archive entries do not duplicate due to races  
✅ Conflict logs don't miss events or double-apply  
✅ Escalation folder doesn't get spammed by concurrent conflicts  
✅ No unique constraint violations leak to callers under normal concurrency  

## Migration Notes

**Breaking changes:** None (backward compatible)

**New dependencies:** None (uses existing PostgreSQL features)

**Database changes:** None (advisory locks are in-memory, no schema changes)

## Future Improvements

1. **Metrics:** Track lock wait times and contention
2. **Monitoring:** Alert on high lock contention for specific entities
3. **Optimization:** Consider batching writes to same entity in high-throughput scenarios
