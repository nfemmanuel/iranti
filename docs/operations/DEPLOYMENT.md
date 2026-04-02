# Deployment Guide

This guide describes the current Iranti deployment model:

- one or more named Iranti instances
- project-local `.env.iranti` bindings
- host integrations layered on top of those bindings

If you need the detailed operator workflow, use the [Operator Manual](../guides/manual.md). If you need the shortest path, use the [Quickstart](../guides/quickstart.md).

## Recommended Model

For most users:

1. Create an instance with `iranti setup`
2. Start it with `iranti run --instance <name>`
3. Bind each project with `iranti project init`
4. Run `iranti claude-setup` or `iranti codex-setup` inside each bound project

That model replaces older guidance that centered direct `npm run api`, hand-edited browser config, or copied middleware files as the primary onboarding path.

## Deployment Shapes

### Single Machine

Best for:
- local development
- one operator
- one or a few projects on the same machine

Suggested flow:

```bash
npm install -g iranti
iranti setup
iranti run --instance local
```

Then, inside each project:

```bash
iranti project init . --instance local --agent-id my_agent
iranti claude-setup
```

Or, for Codex:

```bash
iranti codex-setup
```

### Shared Team Instance

Best for:
- several projects intentionally sharing one memory space
- several devices pointing at one Iranti server
- hosted or always-on environments

Suggested flow on the instance host:

```bash
npm install -g iranti
iranti setup
iranti run --instance team_memory
```

Use a stable database target and a stable public URL or reverse-proxied hostname for the running instance.

Then, inside each client project:

```bash
iranti project init . --instance team_memory --agent-id alice_main --mode shared
```

After the binding exists, add the host integration that project needs:

```bash
iranti claude-setup
```

or

```bash
iranti codex-setup
```

### Automated Or Managed Installs

When interactive setup is not appropriate, prefer:

```bash
iranti setup --defaults
iranti setup --config ./iranti.setup.json
```

If you need lower-level control, the manual documents the install, instance-create, configure, auth, and upgrade commands explicitly.

## Runtime Placement

An Iranti deployment has three layers:

1. runtime root
2. named instance
3. project binding

Keep those boundaries clear:

- runtime and instance settings belong to the instance env
- project-specific routing belongs in `.env.iranti`
- host setup commands should be run from the bound project so they pin to the correct binding

## Production Baseline

For anything beyond local development:

- use a stable PostgreSQL target with pgvector available
- put the API behind TLS or a reverse proxy
- run the instance under a supervisor or service manager
- monitor `/health` and operator commands such as `iranti status`
- keep database backup and restore procedures documented
- use the namespace-aware API key model instead of a single shared secret where possible

Related docs:

- [Security Quickstart](../guides/security-quickstart.md)
- [Security Audit](./SECURITY_AUDIT.md)
- [Troubleshooting](./TROUBLESHOOTING.md)

## Host Integrations

Use the binding-driven guides for host setup instead of treating deployment as a browser-extension-only workflow:

- [Claude Code Guide](../guides/claude-code.md)
- [Codex Guide](../guides/codex.md)
- [Python Client Guide](../guides/python-client.md)

Legacy middleware or extension-specific notes may still exist in `clients/middleware/`, but they are not the primary deployment contract for the current product surface.

## Verification Checklist

After deployment, confirm:

- `iranti status` reports the expected instance
- `iranti doctor --instance <name>` passes or gives actionable diagnostics
- `GET /health` reports the expected runtime metadata
- each project has a valid `.env.iranti`
- Claude Code or Codex exposes Iranti MCP tools inside the bound project

## Common Mistakes

- Running host setup before creating `.env.iranti`
- Treating one shared instance as isolated project memory
- Hand-editing per-project runtime settings instead of using `iranti configure` or `iranti project init`
- Using a PostgreSQL target without pgvector during bootstrap
- Treating old implementation notes as the current deployment contract
