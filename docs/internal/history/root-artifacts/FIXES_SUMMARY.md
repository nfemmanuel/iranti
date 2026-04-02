# Issue 1 & 2 Fixes - Summary

## Issue 1: Staff Writers Normalization ✅

### Problem
- Mixed casing in staff identities: `"Archivist"` vs `"archivist"`
- Case mismatch could cause:
  - Legitimate staff writes blocked
  - Namespace protections failing silently
  - Environment-dependent behavior

### Solution
**All staff identities normalized to lowercase**

### Changes

**1. Staff Writers Set** (`src/library/queries.ts`):
```typescript
const STAFF_WRITERS = new Set([
    'seed',
    'archivist',
    'attendant',
    'librarian',  // Added
    'system',     // Added
]);
```

**2. Normalized Comparison** (`src/library/queries.ts`):
```typescript
export function canWriteToStaffNamespace(createdBy: string, entityType: string, key?: string): boolean {
    const writer = createdBy.toLowerCase();
    if (STAFF_WRITERS.has(writer)) return true;
    // ...
}
```

**3. Entry Point Normalization** (`src/librarian/index.ts`):
```typescript
export async function librarianWrite(input: EntryInput) {
    input.createdBy = input.createdBy.toLowerCase();
    // ...
}
```

**4. Guards Normalization** (`src/librarian/guards.ts`):
- All staff identities lowercase
- All reserved key writers lowercase
- Normalized comparison in `enforceWritePermissions`

**5. Component Updates**:
- `src/archivist/index.ts`: `'Archivist'` → `'archivist'`
- `src/attendant/AttendantInstance.ts`: `'Attendant'` → `'attendant'`

### Testing
```bash
npm run test:staff
```

Tests verify:
- Mixed case accepted: `"Archivist"` → works
- Lowercase accepted: `"librarian"` → works
- Uppercase accepted: `"ATTENDANT"` → works
- Non-staff blocked: `"AgentA"` → fails correctly

---

## Issue 2: Duplicate Metrics Routes ✅

### Problem
- Duplicate import: `import { snapshot, reset } from '../lib/metrics';` (2x)
- Duplicate routes: `/metrics` and `/metrics/reset` (2x each)
- Last registration overrides earlier
- Confusing logs

### Solution
**Single import, single route registration**

### Changes

**1. Removed Duplicate Import** (`src/api/server.ts`):
```typescript
// Before: 2 imports
import { snapshot, reset } from '../lib/metrics';
import { snapshot, reset } from '../lib/metrics';  // REMOVED

// After: 1 import
import { snapshot, reset } from '../lib/metrics';
```

**2. Removed Duplicate Routes** (`src/api/server.ts`):
```typescript
// Observability (single block)
app.get('/metrics', authenticate, (_req, res) => {
    res.json(snapshot());
});

app.post('/metrics/reset', authenticate, (_req, res) => {
    reset();
    res.json({ ok: true });
});
```

### Verification
```bash
npm run api
curl -H "X-Iranti-Key: $IRANTI_API_KEY" http://localhost:3001/metrics
```

Should return JSON once with no duplicate logs.

---

## System Status

### Identity Integrity ✅
- All staff identities normalized to lowercase
- Case-insensitive comparisons throughout
- No silent protection failures
- Librarian explicitly in staff list

### API Cleanliness ✅
- Single metrics import
- Single route registration
- No duplicate handlers
- Clean logs

### Complete Hardening Checklist ✅

✅ Idempotency (Issue 9)  
✅ Concurrency safety (Issue 10)  
✅ Deterministic conflicts (Issue 11)  
✅ Observability (Issue 12)  
✅ Observe fanout control (Must Do #1)  
✅ LLM call budget (Must Do #2)  
✅ Atomic escalations (Must Do #3)  
✅ Staff normalization (Issue 1)  
✅ Clean API wiring (Issue 2)  

**Iranti is production-ready.**
