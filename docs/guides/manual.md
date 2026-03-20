# Iranti Manual

This is the operator manual for Iranti.

Use it when you want the full picture:
- what Iranti installs
- how projects bind to instances
- how keys work
- which commands to run for common tasks
- how to inspect and repair a local setup

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

If local PostgreSQL is reachable and `psql` is installed, setup can create the target localhost database automatically before bootstrap.

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
iranti add api-key openai --instance local --key sk-... --set-default
```

Update a key:

```bash
iranti update api-key claude --instance local --key sk-ant-...
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
iranti configure instance local --provider openai --provider-key sk-... --db-url "postgresql://postgres:realpassword@localhost:5432/iranti_local"
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
| Open local operator chat | `iranti chat` |
| Resolve conflicts | `iranti resolve` |
| Inspect Attendant state | `iranti handshake`, `iranti attend` |
| Upgrade CLI/runtime | `iranti upgrade` |

---

## Related Guides

- [Quickstart](./quickstart.md)
- [Claude Code](./claude-code.md)
- [Codex](./codex.md)
- [Chat Guide](./chat.md)
- [Conflict Resolution](./conflict-resolution.md)
- [Providers](./providers.md)
- [Security Quickstart](./security-quickstart.md)
