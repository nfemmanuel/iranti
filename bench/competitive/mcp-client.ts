// Tiny MCP stdio client for benchmarking: spawn a server command, speak
// newline-delimited JSON-RPC, await responses by id.
//
// TypeScript port of the proven ai-mem bench client
// (mem2-for-ai-by-ai/bench/mcpclient.mjs). Behavior is reproduced exactly —
// same transport (newline-delimited JSON-RPC 2.0 over stdio, NOT
// Content-Length framing), same timeout/pending/error semantics. Standalone:
// does not import from types.ts.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

// ---------------------------------------------------------------------------
// JSON-RPC wire shapes.
// ---------------------------------------------------------------------------

interface JsonRpcError {
  code: number;
  message: string;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface McpClientOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
}

// MCP tools/call result content block (only the "text" variant is consumed
// here — other content types, e.g. images, are ignored by callTool).
interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface McpToolCallResult {
  content?: McpContentBlock[];
  isError?: boolean;
  [key: string]: unknown;
}

export interface CallToolResult {
  text: string;
  isError: boolean;
  raw: McpToolCallResult;
}

// Minimal shape of an MCP tool descriptor as returned by tools/list. Only the
// fields the bench harness touches are typed; inputSchema is left as unknown
// since each server's JSON Schema shape varies.
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}

export class McpClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stderr = "";
  private closed = false;

  constructor(command: string, args: string[], opts: McpClientOptions = {}) {
    this.proc = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: opts.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.proc.stderr.on("data", (d: Buffer) => {
      this.stderr += d.toString();
    });

    // If the server dies, fail every pending request loudly. Otherwise the
    // only thing left on the event loop is an unref'd timer and node exits 0
    // silently, which buries the real error.
    this.proc.on("exit", (code, signal) => {
      if (this.closed) return;
      console.error(
        `[mcp-client] server process exited unexpectedly: code=${code} signal=${signal}, pending=${this.pending.size}`,
      );
      const err = new Error(
        `MCP server exited (code=${code} signal=${signal}) with ${this.pending.size} request(s) in flight. stderr tail: ${this.stderr.slice(-1500)}`,
      );
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });

    let buf = "";
    this.proc.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg: JsonRpcResponse;
        try {
          msg = JSON.parse(line) as JsonRpcResponse;
        } catch {
          continue; // non-JSON noise on stdout
        }
        if (msg.id !== undefined && typeof msg.id === "number" && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
          else resolve(msg.result);
        }
      }
    });
  }

  request(method: string, params?: unknown, timeoutMs = 30000): Promise<unknown> {
    const id = this.nextId++;
    const p = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(
            new Error(`timeout on ${method} (id ${id}). stderr tail: ${this.stderr.slice(-400)}`),
          );
        }
      }, timeoutMs);
      timer.unref();
    });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return p;
  }

  notify(method: string, params?: unknown): void {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async init(): Promise<unknown> {
    const r = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "bench", version: "0.1.0" },
    });
    this.notify("notifications/initialized");
    return r;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.request("tools/list")) as { tools: McpToolDescriptor[] };
    return result.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = 60000,
  ): Promise<CallToolResult> {
    const r = (await this.request(
      "tools/call",
      { name, arguments: args },
      timeoutMs,
    )) as McpToolCallResult;
    const text = (r.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    return { text, isError: !!r.isError, raw: r };
  }

  close(): void {
    this.closed = true;
    try {
      this.proc.stdin.end();
    } catch {
      // stdin already closed — ignore.
    }
    const pid = this.proc.pid;
    const kill = () => {
      // On Windows with shell:true, this.proc is cmd.exe — proc.kill() leaves
      // the tsx/node grandchild orphaned, and its still-open stdout pipe keeps
      // OUR event loop alive (the runner hangs at teardown, leaking servers).
      // taskkill /T kills the whole tree. Elsewhere a plain kill suffices.
      if (process.platform === "win32" && pid) {
        try {
          spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        } catch {
          this.proc.kill();
        }
      } else {
        this.proc.kill();
      }
    };
    const timer = setTimeout(kill, 300);
    timer.unref();
    // Release our ends of the pipes so a slow/orphaned child can't keep the
    // parent process alive after the run is done.
    try {
      this.proc.stdout.destroy();
      this.proc.stderr.destroy();
    } catch {
      // already destroyed — ignore.
    }
  }
}
