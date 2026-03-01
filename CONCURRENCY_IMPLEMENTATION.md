# Concurrency Safety - Implementation Summary

## What Changed

### New Files
- `src/library/locks.ts` - Advisory lock wrapper
- `scripts/test_concurrent_writes.ts` - Concurrency torture test
- `docs/CONCURRENCY_SAFETY.md` - Full documentation

### Modified Files
- `src/library/queries.ts` - All query functions now accept optional `db` parameter for transaction support
- `src/librarian/index.ts` - Write flow wrapped in `withIdentityLock()`, all resolution functions use transaction client
- `package.json` - Added `test:concurrency` script

## How It Works

1. **Advisory Lock**: When a write arrives for `(entityType, entityId, key)`, acquire PostgreSQL advisory lock
2. **Transaction**: All DB operations run in same transaction with lock held
3. **Serialization**: Only one write can mutate a given identity triple at a time
4. **Auto-release**: Lock released when transaction commits/rolls back

## Key Benefits

✅ **No race conditions** - Reads and writes are atomic per identity triple  
✅ **Fine-grained** - Only blocks writes to exact same key, not entire entity  
✅ **Deterministic** - Conflict resolution always produces consistent results  
✅ **No schema changes** - Uses PostgreSQL built-in advisory locks  
✅ **Backward compatible** - Existing code works unchanged  

## Testing

```bash
npm run test:concurrency
```

Fires 25 simultaneous writes to same key and validates:
- Exactly 1 active entry
- All writes get unique receipts
- No duplicate archives
- No constraint violations

## Performance

- **Lock scope**: Per `(entityType, entityId, key)` - very fine-grained
- **Lock duration**: Only during DB operations, not during LLM calls
- **Contention**: Minimal unless many agents write to exact same key simultaneously

## Example

```typescript
// Before: Race condition possible
const existing = await findEntry(query);
// ... another write could happen here ...
await createEntry(input);

// After: Serialized
return withIdentityLock(identity, async (tx) => {
    const existing = await findEntry(query, tx);
    await createEntry(input, tx);
    // Atomic - no races possible
});
```

## Next Steps

Consider implementing **Issue 11**: Deterministic conflict winner rules + source reliability policies
