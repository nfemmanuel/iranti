# Iranti Chat Guide

`iranti chat` is the built-in interactive CLI chatbot for exploring Iranti memory without writing code.

## Start a Session

Load `.env.iranti` or set `IRANTI_URL` and `IRANTI_API_KEY`, then run:

```bash
iranti chat
```

Optional flags:

- `--agent <agent-id>`: session identity, defaults to `iranti_chat`
- `--provider <provider>`: override `LLM_PROVIDER` for this session
- `--model <model>`: override the model used for chat turns

On startup the chat command:

1. Loads runtime env from `.env`, instance env, and `.env.iranti`
2. Calls `handshake()` for the selected agent
3. Prints the active provider/model and the number of working-memory entries loaded

## Slash Commands

### `/help`

Show the available commands.

### `/memory`

List facts currently stored under `session/<agent-id>`.

### `/search <query>`

Search the KB and print matching facts:

```bash
/search project deadline
```

### `/inject <entity> <key>`

Queue a specific fact for the next model turn:

```bash
/inject project/starfall_nexus deadline
```

### `/write <key> <value> [confidence]`

Write a fact to `session/<agent-id>`. Values are treated as strings unless they parse as JSON.

```bash
/write goal "ship iranti v1" 80
/write state {"phase":"beta"} 90
```

### `/observe`

Run `observe()` against the current conversation history and queue any returned facts for the next turn.

### `/clear`

Clear local conversation history and queued memory injections. Persisted KB facts are not deleted.

### `/provider <name> [model]`

Switch the provider for the rest of the session. Optionally override the model at the same time.

```bash
/provider openai gpt-5-mini
/provider mock
```

### `/exit` or `/quit`

Leave the chat session cleanly.

## Memory Behavior

- `handshake()` loads the agent's working-memory brief at session start
- `attend()` decides whether memory should be injected for each user turn
- `/observe` exposes the current `observe()` behavior, which is retrieval/injection, not fact persistence
- `/write` is the explicit persistence path for session facts

Facts written with `/write` persist in the KB under `session/<agent-id>`, so using the same `--agent` value on later sessions gives you continuity.

## Provider and Model Selection

By default, `iranti chat` uses the configured `LLM_PROVIDER` and the provider's default routed fast model. Override either at startup:

```bash
iranti chat --provider claude --model claude-sonnet-4
```

Or switch providers mid-session with `/provider`.
