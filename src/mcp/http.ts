// iranti HTTP transport — Phase 2.5 (CORE-12)
//
// Wraps the existing McpServer in a Streamable HTTP transport so the same
// tool registry is reachable over HTTP alongside stdio. Off by default;
// stdio behaviour is byte-identical to Phase 2 when this module is not called.
//
// Auth: static bearer token from IRANTI_HTTP_TOKEN.
// Port: from IRANTI_HTTP_PORT.
//
// Usage:
//   import { startHttpServer } from "./http.js";
//   if (process.env.IRANTI_HTTP_TOKEN && process.env.IRANTI_HTTP_PORT) {
//     await startHttpServer(server, port, token);
//   }

import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export async function startHttpServer(
  server: McpServer,
  port: number,
  token: string,
): Promise<http.Server> {
  // Stateless transport: no session tracking, each request is independent.
  // One transport instance shared across all HTTP requests — the McpServer
  // tool registry is already stateless, so this is safe.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    // Bearer token check. All paths require auth — the MCP endpoint is the
    // only route this server exposes.
    const authHeader = req.headers["authorization"];
    if (!authHeader || authHeader !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    try {
      const body = await readBody(req);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      console.error("[iranti] HTTP request error:", err);
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  console.error(`iranti HTTP server listening on port ${port}`);
  return httpServer;
}
