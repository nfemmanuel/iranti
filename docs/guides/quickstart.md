# Quickstart

This is the shortest path to a working Iranti instance and one bound project.

If you need the full operator model, repair flows, or lower-level commands, use the [Operator Manual](./manual.md).

## Prerequisites

- Node.js 18+
- Docker or a pgvector-capable PostgreSQL instance
- Codex or Claude Code only if you want host integration immediately

## 1. Install Iranti

Installed-package path:

```bash
npm install -g iranti
```

If you are validating from this source checkout instead of the published package:

```bash
npm install
npm run build
npm install -g .
```

## 2. Run Guided Setup

Use the interactive setup flow:

```bash
iranti setup
```

What setup does:
- prepares the runtime root
- creates or updates an instance
- configures PostgreSQL access
- collects provider settings
- creates an Iranti client API key
- can bind the current project

Automation-oriented variants:

```bash
iranti setup --defaults
iranti setup --config ./iranti.setup.json
```

If Docker is available, setup prefers that path because it guarantees pgvector. If you use local PostgreSQL, Iranti now expects that server to provide pgvector before bootstrap continues.

## 3. Start The Instance

```bash
iranti run --instance local
```

In another terminal, confirm the runtime is healthy:

```bash
iranti status
iranti doctor --instance local
curl http://localhost:3001/health
```

## 4. Bind A Project

From the project that should use this instance:

```bash
cd /path/to/your/project
iranti project init . --instance local --agent-id my_agent
```

That writes `.env.iranti` with the project binding and default memory entities.

If you intentionally want several projects to share one memory space on the same instance:

```bash
iranti project init . --instance team_memory --agent-id my_agent --mode shared
```

## 5. Connect Your Host

Claude Code:

```bash
iranti claude-setup
```

Codex:

```bash
iranti codex-setup
```

Those commands wire the current project to `iranti mcp` through the existing `.env.iranti` binding.

## 6. Sanity Check

You should now have:
- a running instance visible in `iranti status`
- a bound project with `.env.iranti`
- MCP setup files for your host if you ran `claude-setup` or `codex-setup`

Useful first checks:

```bash
iranti instance show local
type .env.iranti
```

Then open Claude Code or Codex in that bound project and ask it to list available MCP tools. You should see the Iranti tool surface.

## Common Fast Fixes

- If setup or run fails, start with `iranti doctor --debug`.
- If the API is not reachable, confirm the instance is actually running with `iranti status`.
- If host tools do not appear, rerun `iranti claude-setup` or `iranti codex-setup` from the bound project.
- If PostgreSQL bootstrap fails, switch to Docker or a managed pgvector-capable PostgreSQL target.

## Next Steps

- [Operator Manual](./manual.md) for runtime lifecycle, project binding, keys, and repair flows
- [Claude Code Guide](./claude-code.md)
- [Codex Guide](./codex.md)
- [Python Client Guide](./python-client.md)
- [Providers Guide](./providers.md)
- [API Reference](../API.md)
