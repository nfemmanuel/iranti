# Provider Error Normalization

## Overview
Iranti normalizes common remote-provider failure modes such as exhausted credits, disabled billing, quota exhaustion, and rate limiting into direct operator-facing error messages. This prevents raw vendor payloads from leaking through as vague or inconsistent CLI/API failures.

## Inputs

| Input | Type | Description |
|---|---|---|
| `provider` | `string` | Provider name such as `openai`, `claude`, `gemini`, `groq`, or `mistral`. |
| HTTP status | `number` | Remote provider response status when using REST-based providers. |
| HTTP status text | `string` | Remote provider status text for REST-based providers. |
| raw response body | `string` | Provider error payload used for normalization heuristics. |
| caught SDK error | `Error` | SDK-thrown error used by providers such as Claude. |

## Outputs

| Output | Type | Description |
|---|---|---|
| normalized quota error | `Error` | Clear message telling the operator credits or billing are exhausted. |
| normalized rate-limit error | `Error` | Clear message telling the operator to retry later or reduce load. |
| generic provider error | `Error` | Provider-specific error with status and truncated body when no special case matches. |

## Decision Tree / Flow
1. Collect the provider name plus either HTTP error details or a caught SDK error.
2. Build a lowercase search string from the status text and raw body or from the caught error message.
3. If the payload indicates quota exhaustion, insufficient credits, billing failure, or exhausted resources, return a direct provider-specific quota message.
4. Else if the payload indicates `429` or rate limiting, return a provider-specific rate-limit message.
5. Else return a generic provider-specific API error with status information and a truncated body snippet.
6. Surface the normalized message back through the router/CLI/API layers.

## Edge Cases
- Unknown providers still return a generic provider-specific error label using the original provider name.
- Oversized vendor payloads are truncated so operators get signal without logging full opaque blobs.
- Local providers such as `mock` and `ollama` do not use this normalization path.
- SDK-thrown errors without status codes still normalize based on message content.

## Test Results
- `npm run build` completed successfully after wiring the normalization helpers into OpenAI, Claude, Gemini, Groq, and Mistral providers.
- Local smoke inspection confirmed each provider path now calls `normalizeProviderApiError(...)` or `normalizeProviderCaughtError(...)` before surfacing failures.

## Related
- [`src/lib/llm.ts`](C:\Users\NF\Documents\Projects\iranti\src\lib\llm.ts)
- [`src/lib/providers/openai.ts`](C:\Users\NF\Documents\Projects\iranti\src\lib\providers\openai.ts)
- [`src/lib/providers/claude.ts`](C:\Users\NF\Documents\Projects\iranti\src\lib\providers\claude.ts)
- [`src/lib/providers/gemini.ts`](C:\Users\NF\Documents\Projects\iranti\src\lib\providers\gemini.ts)
- [`src/lib/providers/groq.ts`](C:\Users\NF\Documents\Projects\iranti\src\lib\providers\groq.ts)
- [`src/lib/providers/mistral.ts`](C:\Users\NF\Documents\Projects\iranti\src\lib\providers\mistral.ts)
