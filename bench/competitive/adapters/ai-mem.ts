// Adapter for ai-mem (mem2-for-ai-by-ai), a markdown-file-backed project
// memory MCP server with BM25 retrieval and zero runtime dependencies.
//
// ASSUMPTIONS / VERIFIED FACTS (read C:\Users\NF\Documents\Projects\
// mem2-for-ai-by-ai\src\mcp.js, bin\mem.js, src\store.js, package.json
// directly rather than only running listTools() at runtime, since the
// server's tool set is a small fixed TOOLS array, not something the CLI
// negotiates):
//
//   - Entrypoint: `bin/mem.js serve [--root <dir>]` (package.json declares
//     `"bin": {"mem": "bin/mem.js"}`; `mem serve` calls
//     `src/mcp.js`'s `serve(rootArg)`). Spawned directly via the shebang
//     script with `node`, so no shell/PATH dependency the way the globally
//     installed `iranti` bin needs.
//   - VERIFIED tool names + schemas (src/mcp.js's TOOLS const):
//       memory_recall    {query (required), k?, type?}       -> read
//       memory_remember   {type, title, body, tags?, files?, confidence?, supersedes?} -> write
//       memory_revise    {id, action, ...}                    -> not used by this adapter
//       memory_briefing  {max_chars?}                          -> not used by this adapter
//   - ASSUMPTION (isolation mapping): ai-mem has NO user/session/namespace
//     parameter anywhere in its tool surface — its only isolation unit is
//     the store ROOT DIRECTORY the server process was started with
//     (`serve(rootArg)` -> `rootArg || findRoot() || process.cwd()`;
//     store.js's `addMemory` auto-creates `<root>/.ai-memory/` on first
//     write, so no `mem init` is required beforehand). This adapter maps
//     `scope` onto isolation by spawning ONE MCP subprocess PER SCOPE, each
//     with `--root <scratchDir>/<scope>` pointed at its own empty directory
//     under the OS temp dir — never at this repo or any shared location, so
//     one EvalCase's memories cannot leak into another's.
//   - ASSUMPTION (query mapping): memory_recall's response is
//     human-formatted text (store.js's fmtMemory: a numbered list of
//     "N. [id] title (type, confidence, updated)\n   files: ...\n   tags: ...\n   <body lines>"),
//     not JSON — there is no structured recall output in this tool surface.
//     This adapter parses that format back into one retrieved[] string per
//     memory (title + body, the closest equivalent to the "fact value" the
//     Adapter contract wants), capped at config.topK. If ai-mem ever changes
//     its response format this parsing silently degrades to a single
//     whole-blob entry (see parseRecallText's fallback) rather than throwing.
//   - ASSUMPTION (write mapping): memory_remember requires title+body+type.
//     There is no free-text "ingest a conversation" tool, so write() invents
//     a short deterministic title from the scope + a running counter and
//     puts the full conversation text in `body`, tagged type: "context"
//     (the TYPES enum's catch-all) and source: "bench". This is a lossier
//     write path than ai-mem's intended usage (curated decisions/fixes with
//     hand-written titles) but is the only mapping available from raw
//     conversation text onto this tool's required fields.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, AdapterFactory, QueryResult, RunConfig, WriteInput, WriteResult } from "../types.js";
import { McpClient } from "../mcp-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// bench/competitive/adapters -> mem2-for-ai-by-ai is a SIBLING project
// directory, not inside this repo. Resolved relative to this repo's parent
// (both projects live under the same Projects/ folder per the task brief).
const AI_MEM_REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "mem2-for-ai-by-ai");
const MEM_BIN = path.join(AI_MEM_REPO_ROOT, "bin", "mem.js");

// One isolated store directory per scope, under the OS temp dir — never
// inside either project's own working tree.
const SCRATCH_ROOT = path.join(os.tmpdir(), "iranti-bench-ai-mem");

function storeDirForScope(scope: string): string {
  // Sanitize scope into a filesystem-safe directory name; EvalCase ids are
  // expected to already be simple slugs, but this guards against surprises.
  const safe = scope.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(SCRATCH_ROOT, safe);
}

// Parses ai-mem's memory_recall text format (store.js's fmtMemory / mcp.js's
// local fmtMemory — identical shape) back into one string per memory. Splits
// on the numbered-list marker ("1. [m-abc123] ...", "2. [m-def456] ...");
// each chunk's first line (title + metadata) plus indented body lines are
// joined into one retrieved[] entry. Falls back to the whole text as a
// single entry if the expected marker is absent (e.g. the "no memories
// match" message, or a future format change).
function parseRecallText(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const chunks = trimmed.split(/\n(?=\d+\.\s\[)/g).filter((c) => /^\d+\.\s\[/.test(c.trim()));
  if (chunks.length === 0) return [trimmed];
  return chunks.map((c) => c.trim());
}

class AiMemAdapter implements Adapter {
  readonly systemName = "ai-mem";
  private readonly clients = new Map<string, McpClient>();
  private readonly initPromises = new Map<string, Promise<void>>();
  private readonly writeCounters = new Map<string, number>();

  private async ensureClient(scope: string): Promise<McpClient> {
    const existing = this.clients.get(scope);
    if (existing) return existing;

    let initPromise = this.initPromises.get(scope);
    if (!initPromise) {
      initPromise = this.spawnAndInit(scope);
      this.initPromises.set(scope, initPromise);
    }
    await initPromise;
    return this.clients.get(scope)!;
  }

  private async spawnAndInit(scope: string): Promise<void> {
    const dir = storeDirForScope(scope);
    fs.mkdirSync(dir, { recursive: true });
    const client = new McpClient("node", [MEM_BIN, "serve", "--root", dir], {
      shell: false,
    });
    await client.init();
    this.clients.set(scope, client);
  }

  async write(input: WriteInput, scope: string, _config: RunConfig): Promise<WriteResult> {
    const client = await this.ensureClient(scope);
    const start = Date.now();
    const n = (this.writeCounters.get(scope) ?? 0) + 1;
    this.writeCounters.set(scope, n);
    try {
      const result = await client.callTool("memory_remember", {
        type: "context",
        title: `bench conversation ${scope} #${n}`,
        body: input.conversation,
        source: "bench",
      });
      return { ok: !result.isError, latencyMs: Date.now() - start, raw: result.raw };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        raw: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  async query(question: string, scope: string, config: RunConfig): Promise<QueryResult> {
    const client = await this.ensureClient(scope);
    const start = Date.now();
    try {
      const result = await client.callTool("memory_recall", {
        query: question,
        k: config.topK,
      });
      const latencyMs = Date.now() - start;
      if (result.isError) {
        return { retrieved: [], nativeAnswer: null, latencyMs, raw: result.raw };
      }
      const retrieved = parseRecallText(result.text).slice(0, config.topK);
      return { retrieved, nativeAnswer: null, latencyMs, raw: result.raw };
    } catch (err) {
      return {
        retrieved: [],
        nativeAnswer: null,
        latencyMs: Date.now() - start,
        raw: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  async teardown(): Promise<void> {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    this.initPromises.clear();
  }
}

export const aiMemFactory: AdapterFactory = () => new AiMemAdapter();
