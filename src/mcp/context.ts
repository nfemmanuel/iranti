// MCP server context — Phase 1
//
// One stdio MCP server serves one AI host process. This module holds the
// per-process state: which agent this server is serving and which session
// is open. Both are created lazily on the first tool call (the "handshake")
// — the host never has to register explicitly.
//
// First-call-wins: the first tool call that names an agent fixes the agent
// for the lifetime of the process. This matches the stdio deployment model
// (one host = one server process = one agent). Serving multiple agents from
// one server is a Phase 5 (HTTP transport) concern.
//
// Session cleanup is best-effort. Hosts typically kill the server process
// rather than shutting it down gracefully, so sessions WILL sometimes leak
// open. That is expected: getOpenSessions() exists to detect exactly this.
// We close the session on SIGINT/SIGTERM when we get the chance.

import type { Agent, ProjectRow, Session } from "../db/schema.js";
import { registerAgent } from "../library/agents.js";
import { closeSession, openSession } from "../library/sessions.js";
import { resolveCurrentProject } from "../library/projects.js";

export interface McpContext {
  agent: Agent;
  session: Session;
  // Layer 0 (D5/D6): the project this server's cwd resolves to. Resolved
  // once per process alongside the agent/session handshake below — an MCP
  // host never chdir()s its server mid-process, so re-resolving per call
  // would be wasted work and could never observe a different answer anyway.
  project: ProjectRow;
}

// The default agent name when the host doesn't provide one.
// IRANTI_AGENT_NAME lets a host config pin the name without tool-call params.
const DEFAULT_AGENT_NAME =
  process.env["IRANTI_AGENT_NAME"] ?? "mcp-host";

let current: McpContext | null = null;
let pending: Promise<McpContext> | null = null;

// Get the process-wide context, performing the handshake on first call:
// register the agent (get-or-create by name) and open a session.
// Concurrent first calls share one handshake — no duplicate sessions.
export async function ensureContext(agentName?: string): Promise<McpContext> {
  if (current) return current;

  pending ??= (async () => {
    const agent = await registerAgent({
      name: agentName ?? DEFAULT_AGENT_NAME,
      description: "Registered via iranti MCP server handshake",
      metadata: { transport: "stdio", phase: 1 },
    });
    const session = await openSession(agent.id, { transport: "stdio" });
    const project = await resolveCurrentProject();
    current = { agent, session, project };
    return current;
  })();

  return pending;
}

// Close the open session, if any. Called from signal handlers — must be
// safe to call when no handshake ever happened, and safe to call twice.
export async function shutdownContext(): Promise<void> {
  if (!current) return;
  const { session } = current;
  current = null;
  pending = null;
  await closeSession(session.id);
}
