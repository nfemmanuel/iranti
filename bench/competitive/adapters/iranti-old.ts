// Adapter for the OLD iranti build (v0.4.1), installed globally and LIVE
// against a local Postgres instance (localhost:5432).
//
// Tool contract verified live (probed the running `iranti mcp` server's
// tools/list on 2026-07-04):
//   - iranti_ingest {entity, content, confidence?, source?} — entity is a
//     "entityType/entityId" STRING (unlike the new build's object-shaped
//     entityHints). confidence is an INTEGER 0-100 (not the new build's
//     0..1 float), per the live inputSchema; omitted here to use the
//     server's own default.
//   - iranti_search {query, entityType?, entityId?, limit?} — flat filters,
//     matches the task brief exactly.
//   - iranti_attend enforces a call-before-discovery protocol on some hosts
//     (ProtocolViolationError). A quick live probe of a fresh, handshake-less
//     session did not trip it on a bare iranti_search call, but the task's
//     verified contract says the old build requires iranti_attend before any
//     discovery tool — so query() always calls iranti_attend first
//     regardless, which is harmless if unenforced and correct if the
//     violation only fires under session states this adapter's probe didn't
//     reach (e.g. after a handshake has occurred).
//   - entityHints on iranti_attend are "entityType/entityId" STRINGS (live
//     schema: `{"type":"array","items":{"type":"string"}}`), matching the
//     task brief's project/lme-<scope> form.
import type { Adapter, AdapterFactory, QueryResult, RunConfig, WriteInput, WriteResult } from "../types.js";
import { McpClient } from "../mcp-client.js";

function entityForScope(scope: string): string {
  return `project/lme-${scope}`;
}

class IrantiOldAdapter implements Adapter {
  readonly systemName = "iranti-old";
  private client: McpClient | null = null;
  private initPromise: Promise<void> | null = null;

  private async ensureClient(): Promise<McpClient> {
    if (this.client) return this.client;
    if (!this.initPromise) this.initPromise = this.spawnAndInit();
    await this.initPromise;
    return this.client!;
  }

  private async spawnAndInit(): Promise<void> {
    // The old build's own runtime env chain already has DATABASE_URL
    // configured; these are set explicitly as a safety net so the adapter
    // does not depend on ambient shell state. LLM_PROVIDER=mock avoids
    // spending on the old build's own (unrelated) LLM calls — the bench
    // only ever scores adapter.query()'s retrieved[], never the old build's
    // native reasoning.
    this.client = new McpClient("iranti", ["mcp"], {
      env: {
        DATABASE_URL: "postgresql://postgres:053435@localhost:5432/iranti",
        LLM_PROVIDER: "mock",
      },
      shell: true, // global `iranti` bin is a Windows .cmd shim; needs shell to resolve via PATH.
    });
    await this.client.init();
  }

  async write(input: WriteInput, scope: string, _config: RunConfig): Promise<WriteResult> {
    const client = await this.ensureClient();
    const start = Date.now();
    try {
      const result = await client.callTool("iranti_ingest", {
        entity: entityForScope(scope),
        content: input.conversation,
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
      // Required call sequence: iranti_attend before any discovery tool.
      // Its own retrieval result is not used — iranti_search below is the
      // clean, explicit retrieval list this adapter scores.
      await client.callTool("iranti_attend", {
        latestMessage: question,
        entityHints: [entityForScope(scope)],
        phase: "pre-response",
      });

      const result = await client.callTool("iranti_search", {
        query: question,
        entityType: "project",
        entityId: `lme-${scope}`,
        limit: config.topK,
      });
      const latencyMs = Date.now() - start;
      if (result.isError || !result.text) {
        return { retrieved: [], nativeAnswer: null, latencyMs, raw: result.raw };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.text);
      } catch {
        return { retrieved: [result.text], nativeAnswer: null, latencyMs, raw: result.raw };
      }
      const retrieved = extractSearchValues(parsed).slice(0, config.topK);
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

// The old build's iranti_search response shape was observed live as
// {result: [...]} via structuredContent and a JSON array/object in the text
// block; this helper tolerates both a bare array of result objects and an
// object with a `results`/`result` array field, pulling `.value` (or
// `.summary`, the "short retrieval-safe summary" field iranti_write
// documents) off each entry.
function extractSearchValues(parsed: unknown): string[] {
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { results?: unknown[] })?.results)
      ? (parsed as { results: unknown[] }).results
      : Array.isArray((parsed as { result?: unknown[] })?.result)
        ? (parsed as { result: unknown[] }).result
        : [];

  const values: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const value = rec["value"] ?? rec["summary"] ?? rec["valueJson"] ?? rec["content"];
    if (typeof value === "string") values.push(value);
  }
  return values;
}

export const irantiOldFactory: AdapterFactory = () => new IrantiOldAdapter();
