# Access Control

## Overview

Iranti now supports namespace-aware API key authorization for entity-bound knowledge-base routes. Existing global scopes such as `kb:read` and `kb:write` remain valid, while operators can also grant or deny access for specific entity namespaces like `kb:read:project/acme` or `kb:write:project/*`. Enforcement happens at the API layer and does not change KB or archive storage schemas.

## Inputs

| Input | Type | Description |
|---|---|---|
| Scope string | `string` | `resource:action` or `resource:action:entityType/entityId` |
| Wildcard namespace | `string` | Supported only as `entityType/*` |
| Deny rule | `string` | `resource:deny:entityType/entityId` or `resource:deny:entityType/*` |
| Entity-bound request | HTTP request | Request carrying entity identity in route params or body |

## Outputs

| Output | Type | Description |
|---|---|---|
| Allow decision | `boolean` | Request proceeds to route handler |
| Deny decision | `boolean` | Request is rejected with `403` |
| Deny reason | `string` | Explicit human-readable reason for namespace mismatch or deny rule |
| Key creation validation error | `string` | Clear error describing malformed scope syntax |

## Decision Tree / Flow

1. Parse and validate each requested API key scope at key creation time.
2. For entity-bound KB routes, extract the target entity or entities from request params/body.
3. Determine read vs write scope requirement from the HTTP method.
4. Evaluate the granted scopes in this order:
   - exact deny
   - wildcard deny
   - global deny
   - exact allow
   - wildcard allow
   - global allow
5. If a deny matches, return `403` with an explicit deny reason.
6. If no deny matches but an allow matches, continue to the route handler.
7. If no rule matches, return `403` with a namespace-mismatch reason.
8. For cross-entity routes that remain coarse in this pass (`GET /kb/search`, `POST /kb/batchQuery`, `/memory/*`), require the existing global scopes only.

## Edge Cases

- Existing keys with only global scopes remain fully backward-compatible.
- `*/entityId` is rejected as an invalid namespace shape.
- Empty namespace suffixes such as `kb:read:` are rejected at key creation time.
- `POST /kb/relate` must be allowed for both `fromEntity` and `toEntity`.
- Deny rules always override broader or narrower allow rules in this implementation.
- Entity resolution helper routes such as `POST /kb/resolve` authorize against the resolved target namespace, not arbitrary raw text.

## Test Results

- `cmd /c npx tsc --noEmit` passed.
- `cmd /c npm run test:contracts` passed.
- `DATABASE_URL=postgresql://postgres:053435@localhost:5433/iranti_temporal npm run test:access-control` passed.
- Access-control suite baseline:
  - Global scope still works: `PASS`
  - Wildcard namespace allow: `PASS`
  - Exact namespace allow: `PASS`
  - Exact deny overrides allow: `PASS`
  - Wildcard deny overrides allow: `PASS`
  - Missing namespace access returns `403`: `PASS`
  - Malformed scope rejected at key creation: `PASS`
  - `POST /kb/relate` requires both entities: `PASS`
  - Total: `8/8`

## Related

- `src/security/scopes.ts`
- `src/security/apiKeys.ts`
- `src/api/middleware/authorization.ts`
- `src/api/routes/knowledge.ts`
- `tests/access-control/run_access_control_tests.ts`
- `docs/guides/security-quickstart.md`
