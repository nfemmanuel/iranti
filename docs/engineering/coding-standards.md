# Coding standards

**Status:** template  
**[Back to map](../MAP.md)**

---

> Write these before writing the first line of code. Standards applied after the fact are harder to enforce.

## Purpose

Define how code is written, structured, and reviewed in the iranti-core codebase. The goal is consistency, readability, and a codebase where every part feels like it was written by the same person.

## Language and tooling

- **Language:** TypeScript (strict mode, no `any`)
- **Runtime:** Node.js
- **Package manager:** _choose one_
- **Formatter:** Prettier
- **Linter:** ESLint
- **Database toolkit:** Prisma
- **Test framework:** _choose one_

## File and folder structure

_Define the conventions for how code is organized. For example:_

- Feature code lives in `src/<feature-name>/`
- Unit tests live alongside the code they test: `src/<feature-name>/<file>.test.ts`
- Integration tests live in `tests/integration/`
- Shared types live in `src/types/`
- Database queries live in `src/library/`

_Fill in the actual conventions when the project structure is decided._

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

_Fill in:_
- Package manager decision (npm, pnpm, yarn)
- Test framework decision (Jest, Vitest, etc.)
- Full folder structure for `src/`
- Import alias setup (`@iranti/` prefix or similar)
- Pre-commit hook setup (lint + format + type-check)

## Related docs

- [Git workflow](git-workflow.md)
- [Testing strategy](testing-strategy.md)
- [CI/CD setup](ci-cd.md)
