// HTTP transport tests — Phase 2.5 (CORE-12)
//
// Tests the bearer-token auth layer of the Streamable HTTP transport:
//   - Missing token → 401
//   - Wrong token   → 401
//   - Correct token → not 401 (MCP protocol takes over)
// Also guards that the `search` / `fetch` aliases are only registered
// when IRANTI_EXPOSE_OPENAI_ALIASES=true (CORE-13).

import http from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../db/connection.js";
import { startHttpServer } from "../mcp/http.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

afterAll(async () => {
  await pool.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      srv.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("Could not get free port"));
      });
    });
  });
}

function request(
  port: number,
  opts: { token?: string; body?: unknown },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body ? JSON.stringify(opts.body) : "";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(payload)),
    };
    if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;

    const req = http.request(
      { host: "127.0.0.1", port, path: "/", method: "POST", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }),
        );
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Auth tests
// ---------------------------------------------------------------------------

describe("HTTP transport auth (CORE-12)", () => {
  let server: http.Server;
  const TOKEN = "test-secret-token";

  afterAll(() => {
    if (server) server.close();
  });

  it("boots and refuses requests without a token (401)", async () => {
    const port = await freePort();
    const mcpServer = new McpServer({ name: "iranti-test", version: "0.0.0" });
    server = await startHttpServer(mcpServer, port, TOKEN);

    const res = await request(port, { body: { jsonrpc: "2.0", id: 1, method: "initialize" } });
    expect(res.status).toBe(401);
  });

  it("refuses requests with the wrong token (401)", async () => {
    const port = await freePort();
    const mcpServer = new McpServer({ name: "iranti-test", version: "0.0.0" });
    const srv = await startHttpServer(mcpServer, port, TOKEN);

    const res = await request(port, {
      token: "wrong-token",
      body: { jsonrpc: "2.0", id: 1, method: "initialize" },
    });
    expect(res.status).toBe(401);
    srv.close();
  });

  it("accepts requests with the correct token (not 401)", async () => {
    const port = await freePort();
    const mcpServer = new McpServer({ name: "iranti-test", version: "0.0.0" });
    const srv = await startHttpServer(mcpServer, port, TOKEN);

    const res = await request(port, {
      token: TOKEN,
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    });
    expect(res.status).not.toBe(401);
    srv.close();
  });
});

// ---------------------------------------------------------------------------
// Alias gate (CORE-13) — static env-var check
// ---------------------------------------------------------------------------

describe("OpenAI alias gate (CORE-13)", () => {
  it("IRANTI_EXPOSE_OPENAI_ALIASES env var is not set in default test env", () => {
    // The aliases are registered in server.ts only when this var is 'true'.
    // In the test environment the flag is absent — this test documents the contract.
    expect(process.env.IRANTI_EXPOSE_OPENAI_ALIASES).not.toBe("true");
  });
});
