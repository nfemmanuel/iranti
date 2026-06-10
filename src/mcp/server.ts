// iranti MCP server — Phase 1
//
// Exposes the Phase 0 library over the Model Context Protocol via stdio.
// The host process (Claude Desktop, Claude Code, Cursor, ...) spawns this
// server and pipes JSON-RPC over stdin/stdout.
//
// IMPORTANT: stdout belongs to the protocol. Never console.log here —
// diagnostics go to stderr (console.error), which hosts surface in logs.
//
// Single-instance constraint (Phase 1): one server process per host, no
// concurrent-write safety across processes. See implementation.md.
//
// Usage (host config):
//   { "command": "node", "args": ["<repo>/dist/mcp/server.js"],
//     "env": { "DATABASE_URL": "...", "IRANTI_AGENT_NAME": "claude-desktop" } }

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pool } from "../db/connection.js";
import { shutdownContext } from "./context.js";
import { startHttpServer } from "./http.js";
import { registerIrantiTools } from "./register.js";

// One McpServer per transport — SDK 1.29.0 throws "Already connected to a
// transport" on a second connect(). The tool surface is identical on both;
// registerIrantiTools is the single source of truth.
const server = new McpServer({
  name: "iranti",
  version: "0.1.0",
});
registerIrantiTools(server);

// Phase 2.5 (CORE-12): Optional Streamable HTTP transport.
// Starts when both IRANTI_HTTP_TOKEN and IRANTI_HTTP_PORT are set.
// stdio transport always starts regardless. Dedicated McpServer instance —
// see the one-transport-per-instance constraint above.
const httpToken = process.env.IRANTI_HTTP_TOKEN;
const httpPortStr = process.env.IRANTI_HTTP_PORT;
let httpServer: import("node:http").Server | undefined;
if (httpToken && httpPortStr) {
  const httpPort = parseInt(httpPortStr, 10);
  if (!isNaN(httpPort)) {
    const httpMcpServer = new McpServer({
      name: "iranti",
      version: "0.1.0",
    });
    registerIrantiTools(httpMcpServer);
    httpServer = await startHttpServer(httpMcpServer, httpPort, httpToken);
  }
}

// Best-effort cleanup. Hosts usually kill the process outright — leaked
// sessions are expected and detectable via getOpenSessions().
async function shutdown(signal: string): Promise<void> {
  console.error(`iranti: ${signal} received, closing session`);
  try {
    // Close the HTTP listener first so its socket is released before exit —
    // otherwise the port can linger and reject the next process on restart.
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    }
    await shutdownContext();
    await pool.end({ timeout: 5 });
  } catch (err) {
    console.error("iranti: shutdown error", err);
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("iranti MCP server running (stdio)");
