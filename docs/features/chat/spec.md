# Chat

## Overview
The chat feature adds `iranti chat`, an interactive CLI session that uses Iranti APIs for memory lookup and routed LLM calls for response generation. It is a developer-facing exploration surface, not a second orchestration layer.

## Inputs
| Input | Type | Description |
|---|---|---|
| `--agent` | `string` | Session identity, default `iranti_chat` |
| `--provider` | `string` | Optional provider override for the session |
| `--model` | `string` | Optional model override for the session |
| `IRANTI_URL` | `string` | Base URL for the Iranti API |
| `IRANTI_API_KEY` | `string` | API key used for KB and memory endpoints |
| User input | `string` | Free-form chat message or slash command |

## Outputs
| Output | Type | Description |
|---|---|---|
| Model response | Console output | Assistant reply generated through `completeWithFallback()` |
| Session writes | API result | `/write` persists facts to `session/<agent-id>` |
| Injected memory | Console output | `/inject`, `/observe`, and `attend()` queue memory facts for the next turn |

## Decision Tree / Flow
1. Load runtime env from `.env`, instance env, and `.env.iranti`.
2. Resolve provider/model defaults from the current config and CLI flags.
3. Call `handshake()` for the selected agent and print the session header.
4. Enter a readline loop:
   1. Slash command:
      - `/help`, `/memory`, `/search`, `/inject`, `/write`, `/observe`, `/clear`, `/provider`, `/exit`
   2. Normal message:
      - call `attend()` with the current transcript and latest message
      - merge automatic memory facts with any manual injections
      - send the transcript, preamble, and injected memory to the LLM provider
      - print the assistant response
      - append both turns to local history
      - fire a background `observe()` call to warm the next-turn memory path

## Edge Cases
- Missing `IRANTI_URL` or `IRANTI_API_KEY`: command fails fast with a clear error.
- Unsupported provider: rejected before the chat session starts or when `/provider` is used.
- Ctrl+C: exits cleanly without a stack trace.
- Empty session entity: `/memory` prints `No memory entries for this session.`
- Invalid `/write` confidence or malformed entity in `/inject`: command prints usage/help text rather than crashing the loop.

## Test Results
Validation performed during implementation:
- `npx tsc --noEmit`
- `npm run test:integration`
- `npm run test:librarian`
- `npm run test:attendant`
- `npm run test:reliability`

## Related
- [src/chat/index.ts](/c:/Users/NF/Documents/Projects/iranti/src/chat/index.ts)
- [scripts/iranti-cli.ts](/c:/Users/NF/Documents/Projects/iranti/scripts/iranti-cli.ts)
- [docs/guides/chat.md](/c:/Users/NF/Documents/Projects/iranti/docs/guides/chat.md)
- [src/lib/llm.ts](/c:/Users/NF/Documents/Projects/iranti/src/lib/llm.ts)
