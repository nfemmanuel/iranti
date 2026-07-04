// Embeddings — CORE-16 (the semantic retrieval tier, bottom rung).
//
// See docs/prds/phases/core-16-semantic-retrieval.md for the full design.
// Summary: when exact-key and keyword tiers yield fewer than the per-entity
// cap, embed the query and cosine-match it against the entity's own
// embedded-fact pool (its OWN candidate fetch — see fetchSemanticCandidates + SEMANTIC_CANDIDATE_CAP in src/library/facts.ts
// for why this must NOT reuse the keyword path's 50-row recency window).
// Above-floor hits fill only the REMAINING slots, labeled `semantic: true`,
// never `matched: true` (D3). Off by default (IRANTI_EMBEDDER=off).
//
// Mirrors the ExtractorBackend/GraphBackend precedent: one interface, an
// identity descriptor for regime-signature versioning (AX-2 pattern), and a
// module-level singleton selected by env.

import { OllamaEmbedder } from "./ollama.js";
import { MockEmbedder } from "./mock.js";

export interface EmbedderIdentity {
  provider: string;
  model: string;
  dim: number;
  version: string;
}

export interface EmbedderBackend {
  readonly identity: EmbedderIdentity;
  embed(texts: string[]): Promise<number[][]>;
}

// ---------------------------------------------------------------------------
// NoopEmbedder — the "off" backend (default).
// ---------------------------------------------------------------------------

// Never called in practice (every call site checks isEmbedderActive() first
// — see attend.ts), but implemented for completeness / defensive callers:
// returns empty vectors rather than throwing, so a future caller that
// forgets the guard degrades to "no semantic facts" instead of crashing.
export class NoopEmbedder implements EmbedderBackend {
  readonly identity: EmbedderIdentity = {
    provider: "noop",
    model: "none",
    dim: 0,
    version: "1",
  };

  async embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map(() => []));
  }
}

// ---------------------------------------------------------------------------
// Singleton — selected by IRANTI_EMBEDDER env var
// ---------------------------------------------------------------------------

// "mock" is a test-only mode (never selected via env in production — no
// host sets IRANTI_EMBEDDER=mock; tests call getEmbedder("mock") directly,
// or set the env var themselves when they specifically want the singleton
// path exercised). Keeping it a real mode value (not a separate code path)
// means the singleton caching/invalidation logic above is exercised by the
// mock too, not just by "off"/"ollama".
export type EmbedderMode = "off" | "ollama" | "mock";

export function getEmbedderMode(): EmbedderMode {
  const mode = process.env["IRANTI_EMBEDDER"];
  if (mode === "ollama") return "ollama";
  if (mode === "mock") return "mock";
  return "off";
}

export function isEmbedderActive(): boolean {
  return getEmbedderMode() !== "off";
}

let cached: EmbedderBackend | undefined;
let cachedMode: EmbedderMode | undefined;

// Re-derives the backend if IRANTI_EMBEDDER changes between calls (tests
// flip env vars per-case; a stale cached backend from a previous test would
// silently mis-report `identity`/active state — same reasoning as
// buildExtractor() NOT being memoized at module scope in src/extract/index.ts,
// except here we DO cache (constructing OllamaEmbedder is cheap and
// allocation-free until embed() is actually called) but invalidate on mode
// change so tests that toggle env mid-suite still see the right backend.
export function getEmbedder(): EmbedderBackend {
  const mode = getEmbedderMode();
  if (cached && cachedMode === mode) return cached;
  cachedMode = mode;
  if (mode === "ollama") {
    cached = new OllamaEmbedder();
  } else if (mode === "mock") {
    cached = new MockEmbedder();
  } else {
    cached = new NoopEmbedder();
  }
  return cached;
}

// Test-only escape hatch: force the cached singleton back to unset so a test
// that mutates process.env.IRANTI_EMBEDDER mid-suite (rather than via a
// fresh module graph) doesn't read a stale cached backend. Production code
// never calls this.
export function resetEmbedderCache(): void {
  cached = undefined;
  cachedMode = undefined;
}

export * from "./cosine.js";
export * from "./regime.js";
export * from "./vector-column.js";
export * from "./ollama.js";
export * from "./mock.js";
