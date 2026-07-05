// Adapter: chunk-RAG (no-LLM semantic retrieval) — the "Shodh answer".
//
// Bench-only, NO iranti source changes: stores each ingested session as a raw
// chunk, embeds with the local Ollama `nomic-embed-text` model, and at query
// time embeds the question and returns the top-K chunks by cosine similarity.
// The reader composes the answer from those chunks. Zero generative-LLM calls,
// $0, deterministic.
//
// Purpose: measure whether retrieval-BY-MEANING closes the retrieval
// bottleneck the extractor configs hit on LongMemEval's 48-session haystacks.
// NOT the production design (that reuses CORE-16 inside iranti's store) — this
// is the concept test on the canonical stack.
//
// Perf: write() only BUFFERS the raw chunk; the whole case's chunks are
// embedded in ONE batched Ollama call on the first query (Ollama /api/embed
// accepts an input array). This is ~N× fewer HTTP round-trips than embedding
// per session — critical when anything else is sharing the Ollama box.
import type { Adapter, AdapterFactory, QueryResult, RunConfig, WriteInput, WriteResult } from "../types.js";

const OLLAMA_EMBED_URL = process.env["IRANTI_EMBED_URL"] ?? "http://127.0.0.1:11434/api/embed";
const EMBED_MODEL = process.env["IRANTI_EMBED_MODEL"] ?? "nomic-embed-text";

// Batch-embed: one HTTP call for many texts. Ollama /api/embed returns
// { embeddings: number[][] } aligned to the input array.
async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await fetch(OLLAMA_EMBED_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts.map((t) => t.slice(0, 8000)) }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`embed endpoint returned ${res.status}`);
  const json = (await res.json()) as { embeddings?: number[][] };
  const vecs = json.embeddings;
  if (!vecs || vecs.length !== texts.length) {
    throw new Error(`embed batch returned ${vecs?.length ?? 0} vectors for ${texts.length} inputs`);
  }
  return vecs;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface Chunk {
  text: string;
  vec: number[];
}

class ChunkRagAdapter implements Adapter {
  readonly systemName = "iranti-next:chunk-rag";
  // Per-scope raw chunks (buffered on write); embedded lazily+batched on query.
  private readonly raw = new Map<string, string[]>();
  private readonly embedded = new Map<string, Chunk[]>();

  async write(input: WriteInput, scope: string, _config: RunConfig): Promise<WriteResult> {
    const start = Date.now();
    const arr = this.raw.get(scope) ?? [];
    arr.push(input.conversation);
    this.raw.set(scope, arr);
    // Invalidate any prior embedding for this scope (new chunk added).
    this.embedded.delete(scope);
    return { ok: true, latencyMs: Date.now() - start };
  }

  private async ensureEmbedded(scope: string): Promise<Chunk[]> {
    const cached = this.embedded.get(scope);
    if (cached) return cached;
    const texts = this.raw.get(scope) ?? [];
    const vecs = await embedBatch(texts);
    const chunks = texts.map((text, i) => ({ text, vec: vecs[i]! }));
    this.embedded.set(scope, chunks);
    return chunks;
  }

  async query(question: string, scope: string, config: RunConfig): Promise<QueryResult> {
    const start = Date.now();
    try {
      const chunks = await this.ensureEmbedded(scope);
      if (chunks.length === 0) return { retrieved: [], nativeAnswer: null, latencyMs: Date.now() - start };
      const [qvec] = await embedBatch([question]);
      const ranked = chunks
        .map((c) => ({ text: c.text, score: cosine(qvec!, c.vec) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, config.topK)
        .map((r) => r.text);
      return { retrieved: ranked, nativeAnswer: null, latencyMs: Date.now() - start };
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
    this.raw.clear();
    this.embedded.clear();
  }
}

export const chunkRagFactory: AdapterFactory = () => new ChunkRagAdapter();
