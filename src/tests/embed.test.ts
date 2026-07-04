// Unit tests — src/embed/* (CORE-16).
//
// Pure logic only: cosine math, regime-signature matching, and the
// serialize/parse round-trip both engines' storage formats reduce to (see
// src/embed/vector-column.ts's module comment — both engines store the same
// JSON-array text shape, just bound differently on write and cast
// differently on read; parseStoredVector is the one shared parser). No DB
// here — dual-engine round-trip against a real store is covered by
// src/tests/facts.test.ts's CORE-16 section instead.

import { describe, expect, it } from "vitest";
import { cosineSimilarity, SIMILARITY_FLOOR } from "../embed/cosine.js";
import { buildEmbedRegime, regimeMatches, composeEmbedText } from "../embed/regime.js";
import { parseStoredVector } from "../embed/vector-column.js";
import { MockEmbedder } from "../embed/mock.js";
import type { EmbedderIdentity } from "../embed/index.js";

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("is -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it("is scale-invariant (same direction, different magnitude)", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it("returns 0 for mismatched dimensions rather than throwing", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("returns 0 for an empty vector rather than NaN", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 when either vector is all-zero (no divide-by-zero NaN)", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(Number.isNaN(cosineSimilarity([0, 0], [0, 0]))).toBe(false);
  });

  it("SIMILARITY_FLOOR is the documented 0.60 constant", () => {
    expect(SIMILARITY_FLOOR).toBe(0.6);
  });
});

describe("regime signature (D4 — model-swap invalidation)", () => {
  const identity: EmbedderIdentity = { provider: "ollama", model: "nomic-embed-text", dim: 768, version: "1" };

  it("a vector's own regime matches itself", () => {
    const regime = buildEmbedRegime(identity);
    expect(regimeMatches(regime, regime)).toBe(true);
  });

  it("a different model invalidates the match", () => {
    const active = buildEmbedRegime(identity);
    const stored = buildEmbedRegime({ ...identity, model: "other-model" });
    expect(regimeMatches(stored, active)).toBe(false);
  });

  it("a different dim invalidates the match", () => {
    const active = buildEmbedRegime(identity);
    const stored = buildEmbedRegime({ ...identity, dim: 384 });
    expect(regimeMatches(stored, active)).toBe(false);
  });

  it("a different embedder version invalidates the match", () => {
    const active = buildEmbedRegime(identity);
    const stored = buildEmbedRegime({ ...identity, version: "2" });
    expect(regimeMatches(stored, active)).toBe(false);
  });

  it("missing/malformed stored regime is always a mismatch (treated as absent, never assumed valid)", () => {
    const active = buildEmbedRegime(identity);
    expect(regimeMatches(undefined, active)).toBe(false);
    expect(regimeMatches(null, active)).toBe(false);
    expect(regimeMatches("not-an-object", active)).toBe(false);
    expect(regimeMatches({}, active)).toBe(false);
  });

  it("composeEmbedText clamps pathologically long values", () => {
    const longValue = "x".repeat(5000);
    const text = composeEmbedText("some-key", longValue);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text.startsWith("some-key: ")).toBe(true);
  });
});

describe("serialization round-trip (both engines' text-column storage shape)", () => {
  it("round-trips a vector through JSON.stringify/parseStoredVector", () => {
    const vec = [0.1, -0.5, 2.25, 0];
    const serialized = JSON.stringify(vec);
    expect(parseStoredVector(serialized)).toEqual(vec);
  });

  it("returns null for a null/undefined stored value", () => {
    expect(parseStoredVector(null)).toBeNull();
    expect(parseStoredVector(undefined)).toBeNull();
  });

  it("returns null for malformed JSON rather than throwing", () => {
    expect(parseStoredVector("not json")).toBeNull();
  });

  it("returns null for valid JSON that isn't a number array", () => {
    expect(parseStoredVector('{"not":"a vector"}')).toBeNull();
    expect(parseStoredVector('["a","b"]')).toBeNull();
  });

  it("round-trips the exact pgvector text-cast rendering shape (no spaces)", () => {
    // Postgres's `::text` cast of a vector column renders as "[1,2,3]" (no
    // spaces) — same shape JSON.stringify produces, so one parser serves
    // both engines (see vector-column.ts's module comment).
    expect(parseStoredVector("[1,2,3]")).toEqual([1, 2, 3]);
  });
});

describe("MockEmbedder (test-only backend)", () => {
  it("is deterministic: same text embeds to the same vector every time", async () => {
    const embedder = new MockEmbedder();
    const [a] = await embedder.embed(["the quick brown fox"]);
    const [b] = await embedder.embed(["the quick brown fox"]);
    expect(a).toEqual(b);
  });

  it("similar text produces higher cosine than unrelated text", async () => {
    const embedder = new MockEmbedder();
    const [base, similar, unrelated] = await embedder.embed([
      "the figma design file for the homepage",
      "the figma design file for the homepage redesign",
      "quarterly tax filing deadline reminder",
    ]);
    const simToSimilar = cosineSimilarity(base!, similar!);
    const simToUnrelated = cosineSimilarity(base!, unrelated!);
    expect(simToSimilar).toBeGreaterThan(simToUnrelated);
  });

  it("exposes a stable identity descriptor", () => {
    const embedder = new MockEmbedder();
    expect(embedder.identity.provider).toBe("mock");
    expect(embedder.identity.dim).toBeGreaterThan(0);
  });
});
