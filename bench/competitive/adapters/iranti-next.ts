// Adapter for the NEW iranti build (this repo, src/mcp/server.ts).
//
// Tool contract verified against src/mcp/tools/attend.ts, src/mcp/tools/search.ts,
// and src/mcp/register.ts:
//
//   - There is no free-text ingest tool. Ingestion is a SIDE EFFECT of
//     iranti_attend: the `message` param is heuristically scanned for
//     artifacts (URLs, file paths) AND, asynchronously, the extractor
//     (heuristic/local/frontier, selected by IRANTI_EXTRACTOR) mines durable
//     facts from it and writes them to the primary entity (entityHints[0]).
//     write() therefore calls iranti_attend with phase='post-response' (the
//     phase that also extracts from currentContext) so the conversation text
//     is committed to memory as a normal turn would.
//   - entityHints is an array of {entityType, entityId} OBJECTS (not the
//     "type/id" strings the OLD build uses — see attend.ts's
//     entityHintSchema). scope is isolated by using entityId
//     "lme-<scope>" under entityType "project", so each EvalCase gets its
//     own project bucket and never sees another case's facts.
//   - iranti_search {query, entityType, entityId, limit} is a plain
//     full-text search over stored facts (search.ts) — used for query()
//     because it returns a clean, explicit retrieval list rather than the
//     budgeted/ranked injection shape iranti_attend returns.
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type { Adapter, AdapterFactory, QueryResult, RunConfig, WriteInput, WriteResult } from "../types.js";
import { McpClient } from "../mcp-client.js";

export type IrantiNextExtractor = "heuristic" | "local" | "frontier";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// bench/competitive/adapters -> repo root is three levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "src", "mcp", "server.ts");
// .mcp.json pins the iranti-next server to this exact tsx binary path.
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx.CMD");

function entityIdForScope(scope: string): string {
  return `lme-${scope}`;
}

class IrantiNextAdapter implements Adapter {
  readonly systemName: string;
  private client: McpClient | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly extractor: IrantiNextExtractor) {
    this.systemName = `iranti-next:${extractor}`;
  }

  private async ensureClient(): Promise<McpClient> {
    if (this.client) return this.client;
    if (!this.initPromise) {
      this.initPromise = this.spawnAndInit();
    }
    await this.initPromise;
    return this.client!;
  }

  private async spawnAndInit(): Promise<void> {
    // Fresh, per-config, isolated PGlite data dir. Two reasons: (1) the default
    // ~/.iranti/db is corrupt in this environment (PGlite WASM aborts on open —
    // there is even a db.junk-* quarantine sibling from a prior corruption);
    // (2) each config must be reproducible from an empty store and the three
    // configs must not share memory. Per-CASE isolation still rides on the
    // lme-<scope> project entityId inside this one store.
    const dataDir = path.join(REPO_ROOT, "bench", "competitive", ".data", `iranti-next-${this.extractor}`);
    mkdirSync(dataDir, { recursive: true });

    // IRANTI_EXTRACTOR only knows "heuristic" | "local" (buildExtractor() in
    // src/extract/index.ts — "local" falls through to HeuristicExtractor for
    // any other value, so "frontier" would SILENTLY run heuristic). "frontier"
    // is not a mode: it is the SAME LocalLlmExtractor pointed at Anthropic's
    // OpenAI-compatible endpoint with the temp key. local vs frontier differ
    // ONLY in endpoint/model/key.
    const env: NodeJS.ProcessEnv = {
      IRANTI_DATA_DIR: dataDir,
      IRANTI_EMBEDDER: "off", // full-text retrieval only — deterministic, no embed model
      // Make write()=iranti_attend BLOCK until extraction lands, so ingest-then-
      // query in the runner doesn't race the server's detached extraction chain
      // (src/mcp/tools/attend.ts). Without this, retrieval is empty and every
      // score is a false 0.
      IRANTI_EXTRACT_SYNC: "1",
      // Generous ceiling: a cold qwen2.5:7b extraction can take ~45s; the 8s
      // default would time out and extract nothing. Warm calls are unaffected
      // (this is a ceiling, not a delay). Anthropic (frontier) is well under it.
      IRANTI_LLM_TIMEOUT_MS: "120000",
    };
    if (this.extractor === "heuristic") {
      env["IRANTI_EXTRACTOR"] = "heuristic";
    } else if (this.extractor === "local") {
      env["IRANTI_EXTRACTOR"] = "local";
      env["IRANTI_LLM_ENDPOINT"] = "http://127.0.0.1:11434/v1"; // Ollama
      env["IRANTI_LLM_MODEL"] = "qwen2.5:7b"; // installed model (code default qwen2.5:3b is NOT pulled)
      env["IRANTI_LLM_API_KEY"] = ""; // Ollama needs no auth; don't inherit a key from process.env
    } else {
      // frontier — LocalLlmExtractor against Anthropic's OpenAI-compat endpoint.
      env["IRANTI_EXTRACTOR"] = "local";
      env["IRANTI_LLM_ENDPOINT"] = "https://api.anthropic.com/v1";
      env["IRANTI_LLM_MODEL"] = "claude-sonnet-5";
      const parsed = dotenv.parse(readFileSync(path.join(REPO_ROOT, "bench", ".env")));
      env["IRANTI_LLM_API_KEY"] = parsed["IRANTI_LLM_API_KEY"] ?? parsed["ANTHROPIC_API_KEY"] ?? "";
    }

    // Mirrors .mcp.json's iranti-next entry: tsx binary running
    // src/mcp/server.ts, cwd at repo root.
    this.client = new McpClient(TSX_BIN, [SERVER_ENTRY], {
      cwd: REPO_ROOT,
      env,
      shell: true, // tsx.CMD is a Windows batch shim; needs shell to resolve.
    });
    await this.client.init();
  }

  async write(input: WriteInput, scope: string, _config: RunConfig): Promise<WriteResult> {
    const client = await this.ensureClient();
    const start = Date.now();
    try {
      const result = await client.callTool("iranti_attend", {
        entityHints: [{ entityType: "project", entityId: entityIdForScope(scope) }],
        message: input.conversation,
        // post-response also extracts from currentContext and persists
        // continuity state — using it here (rather than pre-response) makes
        // write() commit the turn the way a real host would after replying,
        // which is what actually triggers durable fact extraction.
        currentContext: input.conversation,
        phase: "post-response",
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
    const client = await this.ensureClient();
    const start = Date.now();
    try {
      // Retrieve via iranti_attend, NOT iranti_search. The new build's
      // iranti_search is purely lexical, so a full natural-language question
      // ("which ORM did we choose...") returns nothing — only bare keywords
      // match. iranti_attend is iranti's actual retrieval path: given the
      // question as `message`, it returns the relevant stored facts RANKED
      // (matched-first), which is exactly what a host surfaces to an agent.
      // We then take the top `topK` of that ranked list.
      //
      // phase='mid-turn' (NOT pre-response): mid-turn SKIPS extraction from the
      // message (attend.ts gates message extraction on `!isMidTurn`), so a
      // query does NOT trigger a second, useless LLM extraction on the question
      // itself — under IRANTI_EXTRACT_SYNC that wasted ~20s (local) per query
      // for zero facts. maxFacts is set to topK so mid-turn's small default
      // budget doesn't cap retrieval below the track's depth.
      const result = await client.callTool("iranti_attend", {
        entityHints: [{ entityType: "project", entityId: entityIdForScope(scope) }],
        message: question,
        phase: "mid-turn",
        maxFacts: config.topK,
      });
      const latencyMs = Date.now() - start;
      if (result.isError || !result.text) {
        return { retrieved: [], nativeAnswer: null, latencyMs, raw: result.raw };
      }
      let parsed: { facts?: Array<{ key?: string; value?: string }> };
      try {
        parsed = JSON.parse(result.text) as { facts?: Array<{ key?: string; value?: string }> };
      } catch {
        // Not JSON — fall back to raw text as a single retrieved item so a
        // schema drift in the server doesn't silently zero out the score.
        return { retrieved: [result.text], nativeAnswer: null, latencyMs, raw: result.raw };
      }
      const retrieved = (parsed.facts ?? [])
        // Give the reader "key: value" so a bare value like "3" or "Drizzle"
        // carries its own context (which decision/preference it answers).
        .map((f) => (typeof f.value === "string" ? (f.key ? `${f.key}: ${f.value}` : f.value) : undefined))
        .filter((v): v is string => typeof v === "string")
        .slice(0, config.topK);
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
    this.client?.close();
    this.client = null;
    this.initPromise = null;
  }
}

export function irantiNextFactory(extractor: IrantiNextExtractor): AdapterFactory {
  return () => new IrantiNextAdapter(extractor);
}
