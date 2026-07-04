// MockEmbedder — CORE-16 test-only backend.
//
// Deterministic hash-based pseudo-vectors so integration tests can exercise
// the whole semantic slot-fill path (regime signature, floor cutoff,
// candidate fetch, cosine ranking) without a live Ollama instance. Selected
// via IRANTI_EMBEDDER=mock (see src/embed/index.ts's getEmbedderMode).
//
// Determinism + "similar text -> similar vector" property: rather than a
// pure random hash (which would make cosine similarity meaningless — every
// pair of texts would land at ~0 similarity regardless of content, so the
// floor-cutoff and slot-fill tests couldn't distinguish a relevant match
// from an irrelevant one), this builds a bag-of-trigrams vector: each
// character trigram in the (lowercased, whitespace-collapsed) text hashes
// to one of DIM buckets and increments it, then the whole vector is
// L2-normalized. Two texts sharing more trigrams (i.e. actually similar
// substrings) land closer in cosine space than two unrelated texts — a weak
// but real and fully deterministic stand-in for a semantic embedding, which
// is exactly what the adversarial tests (high-lexical-overlap-but-wrong vs
// truly-relevant) need to be able to construct fixtures against.

import type { EmbedderBackend, EmbedderIdentity } from "./index.js";

const MOCK_DIM = 64;

function hashTrigram(trigram: string): number {
  let h = 0;
  for (let i = 0; i < trigram.length; i++) {
    h = (h * 31 + trigram.charCodeAt(i)) >>> 0;
  }
  return h % MOCK_DIM;
}

function embedOne(text: string): number[] {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const vec = new Array<number>(MOCK_DIM).fill(0);
  if (normalized.length < 3) {
    // Degenerate short input: still return a valid unit vector (bucket 0)
    // rather than an all-zero vector, which would break cosine (0/0).
    vec[0] = 1;
    return vec;
  }
  for (let i = 0; i <= normalized.length - 3; i++) {
    vec[hashTrigram(normalized.slice(i, i + 3))]! += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

export class MockEmbedder implements EmbedderBackend {
  readonly identity: EmbedderIdentity = {
    provider: "mock",
    model: "mock-trigram-v1",
    dim: MOCK_DIM,
    version: "1",
  };

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map(embedOne));
  }
}
