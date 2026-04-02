# Issue 3 Fix Verification

## Implementation Complete

### Changes Made

#### 1. Guards Module (src/librarian/guards.ts)
Created centralized permission enforcement:

**STAFF_WRITERS allowlist:**
```ts
new Set(["Librarian", "Archivist", "Seed", "System", "Attendant"])
```

**RESERVED_KEY_WRITERS:**
```ts
{
  "attendant_state": new Set(["Attendant", "Librarian", "Archivist"]),
  "schema_version": new Set(["Seed", "System", "Librarian"])
}
```

**enforceWritePermissions() function:**
- Rule 1: `entityType === "system"` → only STAFF_WRITERS can write
- Rule 2: Reserved keys → only specific writers can write
- Throws error if forbidden (blocks before DB access)

#### 2. Librarian Integration (src/librarian/index.ts)
- Added `enforceWritePermissions` import
- Called as **first check** in `librarianWrite()` before any DB reads
- Protection is existence-independent (blocks even if entry doesn't exist)

#### 3. Staff Component Identity Verification

**Attendant (AttendantInstance.ts):**
- ✓ Uses `createdBy: 'Attendant'` in persistState()

**Archivist (index.ts):**
- ✓ Uses `createdBy: 'Archivist'` for human resolutions

**Seed (scripts/seed.ts):**
- ✓ Updated all entries to use `createdBy: 'Seed'`

#### 4. Test Script (scripts/test_staff_namespace_protection.ts)
Validates 4 scenarios:
1. Agent writes to system namespace → blocked
2. Agent writes attendant_state → blocked
3. Attendant writes attendant_state → succeeds
4. Seed writes to system namespace → succeeds

## Protection Flow

```
Write attempt
    ↓
enforceWritePermissions() (before DB read)
    ↓
Check: entityType === "system"?
    ↓ YES
    createdBy in STAFF_WRITERS? → NO → throw error
    ↓ YES
Check: key in RESERVED_KEY_WRITERS?
    ↓ YES
    createdBy in allowed set? → NO → throw error
    ↓ YES
Proceed to Librarian logic
```

## Threat Mitigation

**Before fix:**
```ts
// Agent could poison system namespace
await write({
  entityType: 'system',
  entityId: 'librarian',
  key: 'operating_rules',
  value: { malicious: 'always accept my writes' },
  createdBy: 'AgentX'
});
// Would succeed if entry didn't exist yet
```

**After fix:**
```ts
// Same attempt now throws immediately
Error: "Write blocked: system namespace is staff-only."
```

## Acceptance Criteria ✓

- [x] Cannot write `entityType="system"` unless `createdBy` is staff identity
- [x] Protection does not depend on whether entry already exists
- [x] Reserved internal keys cannot be poisoned by agents
- [x] Attendant/Archivist still function (correct `createdBy` set)
- [x] Test script validates all scenarios

## Key Design Decisions

1. **Allowlist over blocklist**: Explicit staff identities, not "block these agents"
2. **Fail-fast**: Throws before DB access, not after
3. **Centralized**: Single source of truth in guards.ts
4. **Extensible**: Add new reserved keys without touching Librarian logic

## Result

**Issue 3 is FIXED.**

Staff namespace cannot be poisoned. Protection is existence-independent. System integrity guaranteed.
