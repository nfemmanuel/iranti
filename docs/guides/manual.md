# Iranti Manual

This is the operator manual for Iranti.

Use it when you want the full picture:
- what Iranti installs
- how projects bind to instances
- how keys work
- which commands to run for common tasks
- how to inspect and repair a local setup

CLI help now includes short "what it does" and "use this when" guidance for operator-facing commands. Use `iranti <command> --help` for the fast path; use this manual for the full workflow and surrounding context.

---

## Core Model

Iranti has three layers:

1. **Runtime root**
   - The machine-level install location.
   - Holds instances, logs, and runtime metadata.

2. **Instance**
   - A named Iranti server configuration.
   - Has its own `.env`, `DATABASE_URL`, API port, provider config, and escalation path.

3. **Project binding**
   - A local `.env.iranti` file inside one app/repo.
   - Points that project at one Iranti instance.

Important:
- Iranti is still PostgreSQL-only.
- Docker is optional.
- Shared memory between projects only happens when they intentionally bind to the same instance in `shared` mode.

---

## Recommended Default

For most users:
- use `isolated` mode
- keep one project bound to one instance
- use `iranti setup`

Use `shared` mode only when you explicitly want multiple projects or agents to share one memory space.

---

## First Install

Install the CLI:

```bash
npm install -g iranti
```

Run the guided setup:

```bash
iranti setup
```

What setup does:
- prepares the runtime root
- creates or updates an instance
- helps you choose `local`, `docker`, or `managed` PostgreSQL
- collects provider keys
- creates a usable Iranti client API key
- optionally binds a project

If local PostgreSQL is reachable, `psql` is installed, and the server provides `pgvector`, setup can create the target localhost database automatically before bootstrap.
If the server does not provide `pgvector`, setup now fails early with a direct recommendation to switch to Docker or a managed pgvector-capable database.
If you choose Docker PostgreSQL during setup and leave the password blank, Iranti now uses the local-development default password `postgres` instead of forcing a custom value.

---

## Start And Check

Start an instance:

```bash
iranti run --instance local
```

Check it:

```bash
iranti doctor --instance local
iranti status
```

Use `doctor` when something feels wrong.
Use `status` when you want to see what this machine and current directory are bound to.
`status` and `instance show` now also surface runtime metadata for live or stale instance-backed API processes.

When a command fails and you need more detail:

```bash
iranti doctor --debug
iranti run --instance local --debug
iranti upgrade --verbose
```

Debugging flags:
- `--debug` prints extra CLI diagnostics, structured error details, and stack traces
- `--verbose` prints subprocess trace output

---

## Runtime Lifecycle

Iranti now records runtime metadata for instance-backed API servers. That metadata includes:
- PID
- port
- start time
- last heartbeat
- health URL
- running vs stale status

Use it here:

```bash
iranti status
iranti instance show local
iranti upgrade --check
```

If you want an installed upgrade to take effect on a running instance immediately:

```bash
iranti upgrade --restart --instance local
```

This is a staged operator flow, not live in-place binary replacement. Clients should reconnect after restart.

If you need to remove Iranti:

```bash
iranti uninstall --dry-run
iranti uninstall --all --yes
```

Notes:
- plain `iranti uninstall` removes package installs and stops live Iranti processes, but keeps runtime data and project bindings
- `--all` also removes discovered runtime roots, `.env.iranti`, Iranti MCP entries in `.mcp.json`, Claude hook settings, and Codex MCP registration
- use `--scan-root` when your projects or isolated `.iranti-runtime` folders live outside the default scan roots

---

## Interrupted Sessions

Iranti now supports durable session checkpoints for long-running agent work.

Use this when an agent is in the middle of a multi-step task and you do not want to lose progress if the process dies or the session ends unexpectedly.

Available programmatic operations:
- `checkpoint()`
- `inspectSession()`
- `listSessions()`
- `resumeSession()`
- `completeSession()`
- `abandonSession()`

On the next handshake or checkpoint cycle, the Attendant can surface interrupted-session recovery information, including:
- whether recovery is available
- whether the current task matches the interrupted task
- a recommendation to resume, review, or ignore
- the last saved checkpoint payload

Operator inspection surfaces:
- `GET /memory/session/:agentId` returns one agent's persisted checkpoint plus a derived summary
- `GET /memory/sessions` returns operator-oriented checkpoint inventory across agents, with filters such as `agentId`, `operatorState`, and `staleOnly`

Important distinction:
- `sessionCheckpoint.status` is the raw persisted checkpoint status
- `summary.operatorState` is the operator-facing classification

That means a stale persisted checkpoint can still have `status = active` while the operator summary reports `operatorState = interrupted`.
If you want `inspectSession()` to also derive a recovery recommendation for a candidate return task, pass the same task context you would give a real handshake.

This preserves task continuity better, but it is not a workflow engine. Only what has been checkpointed or written through the Librarian is durable.

---

## Cross-Tool Handoffs

Use shared `task/...` entities when Claude Code needs to hand work to Codex or vice versa. Do not treat one tool's session checkpoint as if the other tool can resume it directly.

Recommended pattern:
- write shared task facts such as `status`, `next_step`, `blockers`, `artifacts`, and `current_owner`
- checkpoint the sender only if the sender also needs its own recovery state
- have the receiver query, observe, or attend against the same `task/...` entity

CLI helper:

```bash
iranti handoff task/runtime_verification_pass \
  --agent claude_code_main \
  --owner codex_code_main \
  --status ready_for_codex \
  --next-step "Implement the CLI runtime verification pass." \
  --blockers "Preserve compatibility docs." \
  --artifacts "docs/guides/codex.md||docs/guides/claude-code.md"
```

This command writes standardized shared-memory facts. It does not orchestrate either tool. For the full collaboration pattern, see [Cross-Tool Handoffs](./cross-tool-handoffs.md).

---

## Project Binding

Bind the current project:

```bash
iranti project init . --instance local
```

Bind explicitly in shared mode:

```bash
iranti project init . --instance team_memory --mode shared
```

Update an existing binding:

```bash
iranti configure project . --instance local
iranti configure project . --mode shared
iranti configure project . --interactive
```

Project binding file:
- `.env.iranti`

Key fields in that file:
- `IRANTI_URL`
- `IRANTI_API_KEY`
- `IRANTI_AGENT_ID`
- `IRANTI_MEMORY_ENTITY`
- `IRANTI_PROJECT_MODE`
- `IRANTI_INSTANCE`
- `IRANTI_INSTANCE_ENV`

---

## Keys

Iranti uses two key types.

### 1. Iranti Client API Keys

These authorize apps and agents against your Iranti instance.

Create one:

```bash
iranti auth create-key --instance local --key-id app_main --owner "App Main" --scopes "kb:read,kb:write,memory:read,memory:write"
```

Write it back into the instance env:

```bash
iranti auth create-key --instance local --key-id app_main --owner "App Main" --scopes "kb:read,kb:write,memory:read,memory:write" --write-instance
```

Write it into a bound project:

```bash
iranti auth create-key --instance local --key-id app_main --owner "App Main" --scopes "kb:read,kb:write,memory:read,memory:write" --project .
```

List keys:

```bash
iranti auth list-keys --instance local
```

Revoke a key:

```bash
iranti auth revoke-key --instance local --key-id app_main
```

### 2. Upstream Provider API Keys

These are OpenAI, Claude, Gemini, and similar provider secrets.

See what is stored:

```bash
iranti list api-keys --instance local
```

Add a key:

```bash
iranti add api-key openai --instance local --key replace-with-real-openai-key --set-default
```

Update a key:

```bash
iranti update api-key claude --instance local --key replace-with-real-anthropic-key
```

Remove a key:

```bash
iranti remove api-key gemini --instance local
```

---

## Configure Instances

Create an instance directly:

```bash
iranti instance create local --port 3001 --db-url "postgresql://postgres:password@localhost:5432/iranti_local" --provider mock
```

Show it:

```bash
iranti instance show local
```

List all instances:

```bash
iranti instance list
```

Update one interactively:

```bash
iranti configure instance local --interactive
```

Update one directly:

```bash
iranti configure instance local --provider openai --provider-key replace-with-real-openai-key --db-url "postgresql://postgres:realpassword@localhost:5432/iranti_local"
```

---

## Integrations

### Claude Code

Bind the project, then scaffold Claude files:

```bash
iranti project init . --instance local
iranti claude-setup .
```

Batch scaffold projects with `.claude` folders:

```bash
iranti claude-setup --scan C:\path\to\Projects --recursive
```

### Codex

Register Iranti with Codex:

```bash
iranti codex-setup
```

Alias:

```bash
iranti integrate codex
```

### MCP Server

Run the stdio MCP server directly:

```bash
iranti mcp
```

---

## Chat And Operator Tools

Open the local chat shell:

```bash
iranti chat
```

Useful slash commands inside chat:
- `/help`
- `/memory`
- `/search <query>`
- `/history <entity> <key>`
- `/relate <from> <to> <type>`
- `/related <entity>`
- `/write <key> <value> [conf]`
- `/confidence <entity> <key> <n>`
- `/resolve`

Manual Attendant inspection:

```bash
iranti handshake --task "Debug current memory state"
iranti attend "What did we decide earlier?" --context-file transcript.txt
```

These are operator/debug tools. Normal Claude Code usage should still rely on hooks and MCP.

---

## Conflict Review

Walk through unresolved escalations:

```bash
iranti resolve
```

Use a custom escalation directory:

```bash
iranti resolve --dir C:\path\to\escalation
```

---

## Upgrade And Maintenance

Check upgrade status:

```bash
iranti upgrade --check
```

Dry run all upgrades:

```bash
iranti upgrade --all --dry-run
```

Run selected upgrades:

```bash
iranti upgrade --all --yes
iranti upgrade --target npm-global,python --yes
```

---

## Common Workflows

### New Local Project

```bash
iranti setup
iranti run --instance local
cd /path/to/project
iranti project init . --instance local
iranti claude-setup .
```

### Shared Team Memory

```bash
iranti setup
iranti run --instance team_memory
cd /path/to/project-a
iranti project init . --instance team_memory --mode shared
cd /path/to/project-b
iranti project init . --instance team_memory --mode shared
```

### Repair A Broken Local Setup

```bash
iranti doctor
iranti status
iranti configure instance local --interactive
iranti configure project . --interactive
```

---

## Troubleshooting Shortlist

If setup fails:
- run `iranti doctor`
- check that `DATABASE_URL` is real, not a placeholder
- confirm PostgreSQL is reachable
- if bootstrap fails on `pgvector`, use a pgvector-capable PostgreSQL server or Docker path

If a project cannot talk to Iranti:
- inspect `.env.iranti`
- confirm `IRANTI_URL`
- confirm `IRANTI_API_KEY`
- rerun `iranti configure project .`

If provider calls fail:
- run `iranti list api-keys --instance local`
- confirm the correct provider key exists
- confirm `LLM_PROVIDER` is what you expect

If ambiguous writes fail under load:
- set `IRANTI_CONFLICT_RESOLUTION_TIMEOUT_MS` below `IRANTI_TX_TIMEOUT_MS`
- optionally tune `IRANTI_TX_MAX_WAIT_MS`
- rerun the write so Iranti escalates cleanly instead of hitting the interactive transaction ceiling

If upgrade behaves strangely on Windows:
- rerun `iranti upgrade --check`
- open a fresh shell after global npm upgrades

---

## Command Map

| Task | Command |
|---|---|
| First-run install | `iranti setup` |
| Start server | `iranti run --instance <name>` |
| Inspect machine/project state | `iranti status` |
| Diagnose problems | `iranti doctor` |
| Create Iranti client key | `iranti auth create-key ...` |
| Manage provider keys | `iranti add|update|remove api-key ...` |
| Bind project | `iranti project init ...` |
| Reconfigure project | `iranti configure project ...` |
| Scaffold Claude Code | `iranti claude-setup ...` |
| Register Codex | `iranti codex-setup` |
| Write shared Codex/Claude handoff state | `iranti handoff task/<task_id> ...` |
| Open local operator chat | `iranti chat` |
| Resolve conflicts | `iranti resolve` |
| Inspect Attendant state | `iranti handshake`, `iranti attend` |
| Inspect persisted session state | `GET /memory/session/:agentId`, `GET /memory/sessions` |
| Upgrade CLI/runtime | `iranti upgrade` |

---

## Related Guides

- [Quickstart](./quickstart.md)
- [Cross-Tool Handoffs](./cross-tool-handoffs.md)
- [Claude Code](./claude-code.md)
- [Codex](./codex.md)
- [Chat Guide](./chat.md)
- [Conflict Resolution](./conflict-resolution.md)
- [Providers](./providers.md)
- [Security Quickstart](./security-quickstart.md)
