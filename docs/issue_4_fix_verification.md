# Issue 4 Fix Verification

## Implementation Complete

### Changes Made

#### 1. Schema Update (prisma/schema.prisma)
Added stable supersession pointer fields to Archive model:
```prisma
supersededByEntityType String?
supersededByEntityId   String?
supersededByKey        String?
```

**Why stable pointers:**
- Not coupled to numeric IDs
- Survives migrations and cross-db merges
- Uses entity identity triple (entityType/entityId/key)
- Replacement always lives at same identity triple

#### 2. Migration
- ✓ Created migration: `20260301223834_add_superseded_by_pointer`
- ✓ Applied to database
- ✓ Backward compatible (kept old `supersededBy Int?` field)

#### 3. Archive Helper Update (src/library/queries.ts)
**New type:**
```ts
type SupersededByPointer = {
    entityType: string;
    entityId: string;
    key: string;
};
```

**Updated signature:**
```ts
export async function archiveEntry(
    entry: KnowledgeEntry,
    reason: 'superseded' | 'contradicted' | 'expired' | 'duplicate',
    supersededBy?: SupersededByPointer
)
```

**Stores pointer:**
```ts
supersededByEntityType: supersededBy?.entityType ?? null,
supersededByEntityId: supersededBy?.entityId ?? null,
supersededByKey: supersededBy?.key ?? null,
```

#### 4. Librarian Updates (src/librarian/index.ts)
Updated all replacement code paths to pass stable pointer:

**Reasoning-based replacement:**
```ts
await archiveEntry(existing, 'superseded', {
    entityType: existing.entityType,
    entityId: existing.entityId,
    key: existing.key,
});
```

**Confidence-based replacement:**
```ts
await archiveEntry(existing, 'superseded', {
    entityType: existing.entityType,
    entityId: existing.entityId,
    key: existing.key,
});
```

#### 5. Test Script (scripts/test_archive_traceability.ts)
Validates 7 scenarios:
1. Write initial entry → succeeds
2. Write higher-confidence replacement → succeeds
3. Archive entry exists → verified
4. supersededBy pointer populated → verified
5. Archive preserves old value/metadata → verified
6. KB has new value → verified
7. conflictLog preserved in archive → verified

## Traceability Flow

```
Initial write
    ↓
KB: { version: 1, confidence: 70 }
    ↓
Higher-confidence replacement
    ↓
Archive old entry with pointer:
  - supersededByEntityType: "test"
  - supersededByEntityId: "traceability_test"
  - supersededByKey: "value"
    ↓
KB: { version: 2, confidence: 90 }
    ↓
Query archive → follow pointer → find current truth
```

## Archive Record Structure

```json
{
  "entityType": "researcher",
  "entityId": "jane_smith",
  "key": "affiliation",
  "valueRaw": { "text": "Stanford" },
  "valueSummary": "Stanford",
  "confidence": 75,
  "source": "agent_001",
  "createdBy": "agent_001",
  "createdAt": "2024-01-15T10:00:00.000Z",
  "conflictLog": [...],
  "archivedAt": "2024-01-15T11:00:00.000Z",
  "archivedReason": "superseded",
  "supersededByEntityType": "researcher",
  "supersededByEntityId": "jane_smith",
  "supersededByKey": "affiliation"
}
```

## Query Pattern for History

```ts
// Find what replaced an archived entry
const archived = await prisma.archive.findFirst({
  where: { entityType, entityId, key }
});

if (archived.supersededByEntityType) {
  const current = await prisma.knowledgeEntry.findUnique({
    where: {
      entityType_entityId_key: {
        entityType: archived.supersededByEntityType,
        entityId: archived.supersededByEntityId,
        key: archived.supersededByKey,
      }
    }
  });
  // current = what replaced it
}
```

## Acceptance Criteria ✓

- [x] Every superseded KB entry creates archive row with pointer
- [x] Can follow "old truth → current truth" deterministically
- [x] No archive record loses provenance fields
- [x] Can debug history without reading escalation files
- [x] Pointer uses stable identity triple, not numeric IDs

## Key Design Decisions

1. **Stable identity over numeric IDs**: Replacement lives at same (entityType, entityId, key)
2. **Backward compatible**: Kept old `supersededBy Int?` field
3. **Fail-safe**: Pointer fields nullable, won't break on expired/duplicate archives
4. **Complete provenance**: Archive preserves valueRaw, conflictLog, all metadata

## Result

**Issue 4 is FIXED.**

Archive traceability is complete. Every supersession is traceable. History is recoverable without external files.
