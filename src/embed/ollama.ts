// OllamaEmbedder — CORE-16.
//
// POSTs to Ollama's native /api/embed endpoint: {model, input: string[]} ->
// {embeddings: number[][]}. Falls back to the OpenAI-compatible
// /v1/embeddings shape ({model, input} -> {data: [{embedding}]}) if the
// native endpoint 404s — trivial to support (same request, different
// response unwrap) so both are covered; PRD only required Ollama-native.
//
// Degrades gracefully: an unreachable endpoint or malformed response returns
// empty vectors (never throws) — mirrors LocalLlmExtractor's degrade-to-
// heuristic posture in src/extract/index.ts. Callers (the write-side embed
// hook, the read-side query embed) already treat "no vector"/"no candidates"
// as a valid outcome, so this failure mode is safe by construction.

import type { EmbedderBackend, EmbedderIdentity } from "./index.js";

const DEFAULT_ENDPOINT = "http://localhost:11434";
const DEFAULT_MODEL = "nomic-embed-text";
const DEFAULT_DIM = 768;

export class OllamaEmbedder implements EmbedderBackend {
  private readonly endpoint: string;
  private readonly model: string;
  readonly identity: EmbedderIdentity;

  constructor(
    endpoint = process.env["IRANTI_EMBED_ENDPOINT"] ?? DEFAULT_ENDPOINT,
    model = process.env["IRANTI_EMBED_MODEL"] ?? DEFAULT_MODEL,
    dim = DEFAULT_DIM,
  ) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.model = model;
    this.identity = { provider: "ollama", model, dim, version: "1" };
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    try {
      const res = await fetch(`${this.endpoint}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: AbortSignal.timeout(15000),
      });

      if (res.status === 404) return await this.embedOpenAiShape(texts);
      if (!res.ok) throw new Error(`Ollama embed endpoint returned ${res.status}`);

      const json = (await res.json()) as { embeddings?: unknown };
      if (!Array.isArray(json.embeddings)) return texts.map(() => []);
      return json.embeddings.map((v) => (Array.isArray(v) ? (v as number[]) : []));
    } catch (err) {
      console.error("[iranti] embed error (ollama):", err);
      return texts.map(() => []);
    }
  }

  // OpenAI-compatible /v1/embeddings fallback — trivial to support (same
  // request shape, different response envelope), so both are covered even
  // though the PRD only mandated Ollama-native.
  private async embedOpenAiShape(texts: string[]): Promise<number[][]> {
    try {
      const res = await fetch(`${this.endpoint}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`OpenAI-shape embeddings endpoint returned ${res.status}`);
      const json = (await res.json()) as { data?: Array<{ embedding?: unknown }> };
      if (!Array.isArray(json.data)) return texts.map(() => []);
      return json.data.map((d) => (Array.isArray(d.embedding) ? (d.embedding as number[]) : []));
    } catch (err) {
      console.error("[iranti] embed error (openai-shape fallback):", err);
      return texts.map(() => []);
    }
  }
}
