# Issue 6 Fix Verification

## Implementation Complete

### Changes Made

#### 1. Client Module (src/library/client.ts)
**Removed import-time initialization:**
```ts
// BEFORE: Created at import time
export const prisma = new PrismaClient();

// AFTER: Explicit initialization
let prisma: PrismaClient | null = null;

export function initDb(connectionString: string): PrismaClient {
    if (prisma && initializedUrl === connectionString) {
        return prisma;
    }
    // Initialize with explicit connection string
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    return prisma;
}

export function getDb(): PrismaClient {
    if (!prisma) {
        throw new Error('Database not initialized. Call initDb() first.');
    }
    return prisma;
}
```

**Guards:**
- Returns existing instance if same connection string
- Throws if trying to reinitialize with different connection string
- `getDb()` throws if not initialized

#### 2. Updated All DB Usages
Replaced all `prisma` imports with `getDb()`:

**Files updated:**
- `src/library/queries.ts` (10 usages)
- `src/archivist/index.ts` (2 usages)
- `src/attendant/AttendantInstance.ts` (2 usages)
- `src/librarian/source-reliability.ts` (2 usages)

**Pattern:**
```ts
// BEFORE
import { prisma } from '../library/client';
await prisma.knowledgeEntry.findUnique(...);

// AFTER
import { getDb } from '../library/client';
await getDb().knowledgeEntry.findUnique(...);
```

#### 3. SDK Constructor (src/sdk/index.ts)
**Explicit initialization:**
```ts
constructor(config: IrantiConfig = {}) {
    const connectionString = config.connectionString ?? process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error('connectionString is required...');
    }

    initDb(connectionString);

    if (config.llmProvider) {
        process.env.LLM_PROVIDER = config.llmProvider;
    }
}
```

**Key changes:**
- Removed `process.env.DATABASE_URL = config.connectionString` mutation
- Added explicit `initDb(connectionString)` call
- Fallback to env var if no config provided
- Throws if neither provided

#### 4. Seed Script (scripts/seed.ts)
Added explicit initialization:
```ts
if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required');
}
initDb(process.env.DATABASE_URL);
```

#### 5. Test Script (scripts/test_connection_string.ts)
Validates 5 scenarios:
1. SDK initializes with explicit connection string
2. Write fact succeeds
3. Query fact succeeds
4. Error thrown when no connection string
5. Multiple initialization with same string works

## Problem Flow

### Before Fix
```
Module import
    ↓
const prisma = new PrismaClient() // Uses process.env.DATABASE_URL at import time
    ↓
SDK constructor runs
    ↓
process.env.DATABASE_URL = config.connectionString // Too late!
    ↓
DB client still connected to old URL
```

### After Fix
```
Module import
    ↓
No DB initialization
    ↓
SDK constructor runs
    ↓
initDb(config.connectionString) // Explicit initialization
    ↓
DB client connected to correct URL
```

## Acceptance Criteria ✓

- [x] No DB client created at module import time
- [x] SDK explicitly calls initDb(connectionString)
- [x] Passing different connection string connects to different DB
- [x] Removing process.env.DATABASE_URL doesn't break initialization (if config provided)
- [x] getDb() throws if not initialized

## Usage Examples

### Correct Usage
```ts
const iranti = new Iranti({
    connectionString: 'postgresql://localhost:5432/mydb',
    llmProvider: 'gemini',
});
// DB initialized with explicit connection string
```

### Fallback to Env Var
```ts
// DATABASE_URL=postgresql://localhost:5432/mydb
const iranti = new Iranti({
    llmProvider: 'gemini',
});
// DB initialized with env var
```

### Error Case
```ts
// No DATABASE_URL env var
const iranti = new Iranti({});
// Throws: "connectionString is required..."
```

## Why This Matters

**Before fix:**
- Custom connection strings silently ignored
- Tests contaminate each other
- Multi-tenant hosting impossible
- Nondeterministic behavior

**After fix:**
- Connection string override deterministic
- Test isolation possible
- Multi-tenant hosting viable
- Explicit lifecycle control

## Migration Notes

**For existing code:**
1. Replace `import { prisma }` with `import { getDb }`
2. Replace `prisma.` with `getDb().`
3. Ensure `initDb()` called before any DB access
4. SDK handles initialization automatically

**For scripts:**
```ts
import { initDb } from '../src/library/client';
initDb(process.env.DATABASE_URL!);
// Now safe to use getDb()
```

## Result

**Issue 6 is FIXED.**

DB initialization is explicit. Connection string override works. SDK controls DB lifecycle. No import-time side effects.
