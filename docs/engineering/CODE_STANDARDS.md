# Code Standards — Iranti

Read this before writing any code in this repository.

---

## Language and Runtime

- TypeScript everywhere — no plain JavaScript files in src/
- Node.js runtime
- Strict mode enabled in tsconfig.json — no implicit any, no implicit returns

---

## Formatting

- 4 spaces for indentation — no tabs
- Single quotes for strings
- Semicolons required
- Max line length: 100 characters
- Trailing commas in multi-line objects and arrays

---

## Naming Conventions

- Files: camelCase (e.g. `knowledgeEntry.ts`, `conflictResolver.ts`)
- Classes: PascalCase (e.g. `LibrarianAgent`, `KnowledgeEntry`)
- Functions and variables: camelCase (e.g. `writeEntry`, `entityType`)
- Constants: SCREAMING_SNAKE_CASE (e.g. `MAX_CONFIDENCE`, `STAFF_NAMESPACE`)
- Database models: PascalCase matching Prisma schema (e.g. `KnowledgeEntry`)
- Environment variables: SCREAMING_SNAKE_CASE (e.g. `DATABASE_URL`)

---

## File Structure Rules

- One responsibility per file — no catch-all utility dumps
- Each Staffer (Librarian, Attendant, Archivist) lives in its own directory
- Shared types go in `src/types.ts`
- Database client singleton goes in `src/library/client.ts` — import from
  there everywhere, never instantiate PrismaClient more than once

---

## Functions

- Max function length: 40 lines — if longer, break it up
- Single responsibility — one function does one thing
- Always define return types explicitly
- Prefer async/await over raw Promises
- Never swallow errors silently — always log or rethrow
```typescript
// ✅ Good
async function writeEntry(entry: EntryInput): Promise<KnowledgeEntry> {
    const existing = await findEntry(entry.entityType, entry.entityId, entry.key);
    if (existing) {
        return handleConflict(existing, entry);
    }
    return createEntry(entry);
}

// ❌ Bad
async function write(e: any) {
    try { return await db.knowledgeEntry.create({ data: e }) } catch {}
}
```

---

## TypeScript Specifics

- No `any` — ever. Use `unknown` if type is truly unknown, then narrow it
- Define interfaces and types in `src/types.ts` unless tightly scoped to one file
- Use Prisma's generated types for all database operations — never hand-roll
  DB types
- Prefer `interface` for object shapes, `type` for unions and aliases

---

## Database Rules

- Never write directly to the database from outside `src/library/`
- All writes go through the Librarian — this is enforced architecturally,
  not just by convention
- Never delete from the `archive` table — this is a hard rule
- Never modify entries where `isProtected = true` outside of `scripts/seed.ts`
- Always use Prisma transactions for multi-step writes

---

## Error Handling

- Every async function gets a try/catch or propagates the error intentionally
- Errors include context — not just the message, but what was being attempted
- Conflict errors are not exceptions — they are expected states, handle them
  with control flow not try/catch
```typescript
// ✅ Good
if (existing.confidence > incoming.confidence) {
    return flagConflict(existing, incoming);
}

// ❌ Bad
throw new Error('conflict');
```

---

## Security

- Never log raw database entries that might contain sensitive values
- Never commit .env — it is in .gitignore for a reason
- Never expose the Prisma client directly through the SDK
- isProtected entries are read-only outside of seed scripts — enforce this
  in the Librarian write logic, not just by convention

---

## Testing

- Every function in src/library/ gets a unit test
- Tests live in a __tests__/ folder mirroring the src/ structure
- Test file naming: `filename.test.ts`
- Test the behavior, not the implementation — test what a function returns,
  not how it does it internally

---

## Git

- Commit messages: `[component] short description of what changed`
  - e.g. `[library] add writeEntry function`
  - e.g. `[librarian] handle duplicate conflict case`
  - e.g. `[docs] update AGENTS.md build status`
- One logical change per commit — don't bundle unrelated changes
- Never commit directly to main — branch, then PR
- Branch naming: `feature/description` or `fix/description`