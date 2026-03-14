# TypeScript HTTP Client

## Overview
The TypeScript client under `clients/typescript/` is a publishable HTTP wrapper for the Iranti REST API. It is separate from the internal in-process SDK in `src/sdk/index.ts` and exists for external Node/TypeScript consumers who want typed `fetch`-based access to the API.

## Inputs

| Input | Type | Description |
|---|---|---|
| `baseUrl` | `string` | Base URL for the Iranti API, defaulting to `http://localhost:3001`. |
| `apiKey` | `string` | `X-Iranti-Key` token used for authenticated requests. |
| `timeout` | `number` | Optional request timeout in milliseconds. |

## Outputs

| Output | Type | Description |
|---|---|---|
| `IrantiClient` | `class` | External HTTP client with typed methods for KB, memory, graph, agents, and maintenance routes. |
| `IrantiError` | `class` | Base typed error carrying HTTP status and parsed response body. |
| `IrantiAuthError` | `class` | Error for `401` responses. |
| `IrantiNotFoundError` | `class` | Error for `404` responses. |
| `IrantiValidationError` | `class` | Error for `400` responses. |
| `types.ts` exports | `interfaces` | Request and response types for all public client methods. |

## Decision Tree / Flow
1. Construct `IrantiClient` with `baseUrl`, `apiKey`, and optional timeout.
2. For each client call:
   - serialize request parameters to REST field names
   - attach `X-Iranti-Key`
   - use native `fetch`
   - abort on timeout
3. Parse JSON responses when possible; preserve raw text if the body is not JSON.
4. Throw typed errors for non-2xx responses.
5. Return strongly typed response objects with the exact REST field names used by the API.

## Edge Cases
- Invalid entity strings throw `IrantiValidationError` before the HTTP request is sent.
- `getAgent()` returns `null` on `404` to preserve the existing Python client behavior.
- Health checks do not require auth on the server, but the client still handles them through the same timeout and parse rules.
- `Date` inputs for `validFrom` and `asOf` are converted to ISO-8601 strings before sending.
- The client exports aliases for `related()` / `getRelated()` and `relatedDeep()` / `getRelatedDeep()` to match existing ergonomics.

## Test Results
Compilation validated with:

```bash
npx tsc -p clients/typescript/tsconfig.json
```

Focused live-API smoke validated with:

```bash
npm run test:ts-client-smoke
```

The smoke covers:
- health check
- agent registration and readback
- KB write/query/queryAll/search
- graph relationship create + traversal
- handshake
- observe
- attend

Validation run used a temporary local API instance on `http://localhost:3002` with a known test key so the smoke did not depend on the separately running developer server on `3001`.

## Related
- [client.ts](/c:/Users/NF/Documents/Projects/iranti/clients/typescript/src/client.ts)
- [types.ts](/c:/Users/NF/Documents/Projects/iranti/clients/typescript/src/types.ts)
- [README.md](/c:/Users/NF/Documents/Projects/iranti/clients/typescript/README.md)
- [index.ts](/c:/Users/NF/Documents/Projects/iranti/src/sdk/index.ts)
- [knowledge.ts](/c:/Users/NF/Documents/Projects/iranti/src/api/routes/knowledge.ts)
- [memory.ts](/c:/Users/NF/Documents/Projects/iranti/src/api/routes/memory.ts)
- [agents.ts](/c:/Users/NF/Documents/Projects/iranti/src/api/routes/agents.ts)
