# Coding standards

**Status:** draft  
**[Back to map](../MAP.md)**

---

> Write these before writing the first line of code. Standards applied after the fact are harder to enforce.

## Purpose

Define how code is written, structured, and reviewed in the iranti-core codebase. The goal is consistency, readability, and a codebase where every part feels like it was written by the same person.

## Language and tooling

- **Language:** TypeScript 5.x (strict mode, no `any`)
- **Runtime:** Node.js 22 LTS
- **Package manager:** pnpm 11
- **Formatter:** Prettier 3 (config in `.prettierrc`)
- **Linter:** ESLint 9 with flat config (`eslint.config.js`), type-aware rules via `typescript-eslint`
- **Database toolkit:** TBD in Phase 0 (Drizzle or Prisma, decided when schema is implemented)
- **Test framework:** Vitest 3

## File and folder structure

```
src/
  library/      — fact storage, CRUD, session management, entity model
  staff/        — Attendant, Librarian, Archivist
  graph/        — GraphBackend interface and PostgreSQL implementation
  mcp/          — MCP server and tool handlers
  types/        — shared TypeScript types and interfaces
tests/
  integration/  — tests that require a running database
  e2e/          — full session scenario tests
```

Unit tests live alongside the code they test: `src/library/facts.test.ts` next to `src/library/facts.ts`.

One file per logical unit. A file that exports more than one primary thing is usually two files.

## Naming conventions

- **Files:** `kebab-case.ts`
- **Classes:** `PascalCase`
- **Functions and variables:** `camelCase`
- **Constants:** `SCREAMING_SNAKE_CASE`
- **Types and interfaces:** `PascalCase`
- **Database tables:** `snake_case` (Prisma convention)

## TypeScript standards

- No `any`. If you need an escape hatch, use `unknown` and narrow it.
- Prefer `interface` for public-facing types, `type` for internal utility types.
- All public functions have explicit return types.
- All errors are typed — no `catch (e: any)`.
- Async functions always handle errors explicitly.

## Functions and modules

- Functions do one thing. If a function is doing two things, it is two functions.
- Functions are short. If a function is longer than 40 lines, consider splitting it.
- Modules export a clear public interface. Internal functions are not exported.
- No circular dependencies.

## Comments

- Comments explain why, not what. The code explains what.
- If code needs a comment to be understood, consider rewriting it to be clearer.
- JSDoc for all public API methods.
- TODO comments are allowed but must include a description of what needs doing.

## Error handling

- All errors are caught at the appropriate level — never swallowed silently.
- Error messages are human-readable and include enough context to debug.
- Do not re-throw raw database errors — wrap them in domain errors.

## Open items

- Import alias setup (`@iranti/` prefix) — add when the project grows enough to need it
- Pre-commit hooks (lint + format + type-check on staged files) — set up with `lefthook` in Phase 1
- Database toolkit (Drizzle vs. Prisma) — decided at start of Phase 0

## Related docs

- [Git workflow](git-workflow.md)
- [Testing strategy](testing-strategy.md)
- [CI/CD setup](ci-cd.md)
