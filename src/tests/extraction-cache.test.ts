// Extraction cache tests — AX-2.
//
// Unit tests for the pure helpers (hashInput, buildRegimeSignature) and the
// LocalLlmExtractor cache wiring. DB-backed read/write tests are skipped when
// no database is available (same pattern as facts.test.ts and mcp-tools.test.ts).
//
// The critical acceptance criteria testable without a DB:
//   - hashInput is deterministic, sensitive to content, normalizes whitespace.
//   - buildRegimeSignature includes all four dimensions.
//   - LocalLlmExtractor degrades gracefully when cache read throws.
//   - EXTRACTION_PROMPT_VERSION is exported and a string.
//   - NORMALIZER_VERSION is exported from keys.ts and is a string.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { hashInput, buildRegimeSignature } from "../library/extraction-cache.js";
import { EXTRACTION_PROMPT_VERSION, LocalLlmExtractor } from "../extract/index.js";
import { NORMALIZER_VERSION } from "../library/keys.js";

// ---------------------------------------------------------------------------
// hashInput — pure, no DB
// ---------------------------------------------------------------------------

describe("hashInput — determinism and sensitivity", () => {
  it("returns the same hash for the same input", () => {
    const a = hashInput("we decided to use TypeScript");
    const b = hashInput("we decided to use TypeScript");
    expect(a).toBe(b);
  });

  it("returns a different hash for different inputs", () => {
    const a = hashInput("we decided to use TypeScript");
    const b = hashInput("we decided to use JavaScript");
    expect(a).not.toBe(b);
  });

  it("returns a hex string", () => {
    const h = hashInput("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("normalizes CRLF and LF to the same hash", () => {
    const unix = hashInput("line1\nline2");
    const windows = hashInput("line1\r\nline2");
    expect(unix).toBe(windows);
  });

  it("trims leading/trailing whitespace before hashing", () => {
    const trimmed = hashInput("hello world");
    const padded = hashInput("  hello world  ");
    expect(trimmed).toBe(padded);
  });

  it("is sensitive to internal content differences", () => {
    const a = hashInput("hello world");
    const b = hashInput("hello  world"); // extra space inside — not trimmed
    // normalizeForCache only trims edges and normalizes line endings, not internal spaces
    // so this SHOULD differ
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// buildRegimeSignature — all four dimensions present
// ---------------------------------------------------------------------------

describe("buildRegimeSignature — encodes all dimensions", () => {
  it("produces a pipe-delimited string with all four parts", () => {
    const sig = buildRegimeSignature("local", "qwen2.5:3b", "1", "1");
    expect(sig).toBe("local|qwen2.5:3b|1|1");
  });

  it("changes when extractorMode changes", () => {
    const a = buildRegimeSignature("local", "qwen2.5:3b", "1", "1");
    const b = buildRegimeSignature("heuristic", "qwen2.5:3b", "1", "1");
    expect(a).not.toBe(b);
  });

  it("changes when modelId changes", () => {
    const a = buildRegimeSignature("local", "qwen2.5:3b", "1", "1");
    const b = buildRegimeSignature("local", "llama3:8b", "1", "1");
    expect(a).not.toBe(b);
  });

  it("changes when promptVersion changes", () => {
    const a = buildRegimeSignature("local", "qwen2.5:3b", "1", "1");
    const b = buildRegimeSignature("local", "qwen2.5:3b", "2", "1");
    expect(a).not.toBe(b);
  });

  it("changes when normalizerVersion changes", () => {
    const a = buildRegimeSignature("local", "qwen2.5:3b", "1", "1");
    const b = buildRegimeSignature("local", "qwen2.5:3b", "1", "2");
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// EXTRACTION_PROMPT_VERSION and NORMALIZER_VERSION — exported constants
// ---------------------------------------------------------------------------

describe("version constants", () => {
  it("EXTRACTION_PROMPT_VERSION is a non-empty string", () => {
    expect(typeof EXTRACTION_PROMPT_VERSION).toBe("string");
    expect(EXTRACTION_PROMPT_VERSION.length).toBeGreaterThan(0);
  });

  it("NORMALIZER_VERSION is a non-empty string", () => {
    expect(typeof NORMALIZER_VERSION).toBe("string");
    expect(NORMALIZER_VERSION.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// LocalLlmExtractor — cache error degrades to plain extraction
//
// We verify that when the cache read throws (simulating DB offline), the
// extractor still returns results and does not propagate the error.
// ---------------------------------------------------------------------------

describe("LocalLlmExtractor — cache read failure degrades gracefully", () => {
  // Spy on console.error to confirm the error is logged (not swallowed silently
  // without trace) but not thrown.
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("returns heuristic facts even when cache read throws", async () => {
    // Port 19999 is the unreachable endpoint; the DB is also unreachable in unit
    // tests so the cache read will throw. The extractor must still return heuristic
    // results.
    const ex = new LocalLlmExtractor("http://localhost:19999", "dummy-model");
    const facts = await ex.extract("we decided to use Bun as the runtime");
    // Heuristic pass always runs; the cache and LLM both degrade.
    expect(facts.some((f) => f.source === "extractor_heuristic")).toBe(true);
    // cache read error logged
    const logs = errorSpy.mock.calls.map((args) => String(args[0]));
    expect(logs.some((l) => l.includes("extraction-cache read error"))).toBe(true);
  });

  it("does not throw when cache write fails", async () => {
    // Same setup — cache write will also fail when DB is offline.
    const ex = new LocalLlmExtractor("http://localhost:19999", "dummy-model");
    await expect(ex.extract("the weather today is fine")).resolves.not.toThrow();
  });
});
