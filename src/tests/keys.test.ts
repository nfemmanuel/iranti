// Unit tests for normalizeKey (AX-1).
// Pure function — no database, no async.

import { describe, expect, it } from "vitest";
import { normalizeKey, withRawKey } from "../library/keys.js";

// ---------------------------------------------------------------------------
// Core collapse rules
// ---------------------------------------------------------------------------

describe("normalizeKey — case collapse", () => {
  it("lowercases a simple key", () => {
    expect(normalizeKey("Timezone")).toBe("timezone");
  });

  it("lowercases a multi-word key", () => {
    expect(normalizeKey("Research Focus")).toBe("research-focus");
  });

  it("lowercases ALL_CAPS", () => {
    expect(normalizeKey("PREFERRED_LANGUAGE")).toBe("preferred-language");
  });
});

describe("normalizeKey — separator collapse", () => {
  it("collapses spaces to hyphens", () => {
    expect(normalizeKey("research focus")).toBe("research-focus");
  });

  it("collapses underscores to hyphens", () => {
    expect(normalizeKey("research_focus")).toBe("research-focus");
  });

  it("collapses mixed separators", () => {
    expect(normalizeKey("research__focus--area")).toBe("research-focus-area");
  });

  it("trims leading/trailing separators", () => {
    expect(normalizeKey("-research-focus-")).toBe("research-focus");
  });

  it("collapses multiple spaces to one hyphen", () => {
    expect(normalizeKey("research   focus")).toBe("research-focus");
  });
});

describe("normalizeKey — camelCase splitting", () => {
  it("splits lowerCamelCase", () => {
    expect(normalizeKey("researchFocus")).toBe("research-focus");
  });

  it("splits UpperCamelCase / PascalCase", () => {
    expect(normalizeKey("ResearchFocus")).toBe("research-focus");
  });

  it("splits multi-word camel", () => {
    expect(normalizeKey("preferredProgrammingLanguage")).toBe(
      "preferred-programming-language",
    );
  });

  it("splits acronym → title-case boundary (HTTPSEndpoint)", () => {
    expect(normalizeKey("HTTPSEndpoint")).toBe("https-endpoint");
  });

  it("handles plain acronym (HTTP)", () => {
    expect(normalizeKey("HTTP")).toBe("http");
  });

  it("splits camelCase with digit (node3Js)", () => {
    expect(normalizeKey("node3Js")).toBe("node3-js");
  });
});

describe("normalizeKey — category prefix", () => {
  it("preserves a clean prefix", () => {
    expect(normalizeKey("decision:use-postgres")).toBe("decision:use-postgres");
  });

  it("normalizes the body but keeps the prefix", () => {
    expect(normalizeKey("decision:UsePostgres")).toBe("decision:use-postgres");
  });

  it("normalizes both category and body", () => {
    expect(normalizeKey("Decision:Research Focus")).toBe(
      "decision:research-focus",
    );
  });

  it("normalizes camelCase in body with prefix", () => {
    expect(normalizeKey("preference:preferredEditor")).toBe(
      "preference:preferred-editor",
    );
  });

  it("splits on first colon only — remaining colons in body collapse", () => {
    expect(normalizeKey("cat:sub:key")).toBe("cat:sub-key");
  });

  it("handles empty body after prefix", () => {
    expect(normalizeKey("category:")).toBe("category");
  });
});

// ---------------------------------------------------------------------------
// The canonical four spellings → one key
// ---------------------------------------------------------------------------

describe("normalizeKey — canonical collapse of the four spellings", () => {
  const variants = [
    "Research Focus",
    "research_focus",
    "researchFocus",
    "research-focus",
  ];

  it("all four spellings produce the same canonical key", () => {
    const results = variants.map(normalizeKey);
    const unique = new Set(results);
    expect(unique.size).toBe(1);
    expect(results[0]).toBe("research-focus");
  });
});

// ---------------------------------------------------------------------------
// Idempotency — the most important guarantee
// ---------------------------------------------------------------------------

describe("normalizeKey — idempotency", () => {
  const cases = [
    "research-focus",
    "decision:use-postgres",
    "preferred-editor",
    "https-endpoint",
    "preference:preferred-programming-language",
    "timezone",
  ];

  for (const c of cases) {
    it(`normalizeKey(normalizeKey(${JSON.stringify(c)})) === normalizeKey(${JSON.stringify(c)})`, () => {
      expect(normalizeKey(normalizeKey(c))).toBe(normalizeKey(c));
    });
  }

  it("is idempotent on all four research-focus variants", () => {
    const variants = [
      "Research Focus",
      "research_focus",
      "researchFocus",
      "research-focus",
    ];
    for (const v of variants) {
      const once = normalizeKey(v);
      const twice = normalizeKey(once);
      expect(twice).toBe(once);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("normalizeKey — edge cases", () => {
  it("returns empty string for empty input", () => {
    expect(normalizeKey("")).toBe("");
  });

  it("handles a single character", () => {
    expect(normalizeKey("X")).toBe("x");
  });

  it("handles numbers", () => {
    expect(normalizeKey("node18")).toBe("node18");
  });

  it("handles leading/trailing spaces", () => {
    expect(normalizeKey("  timezone  ")).toBe("timezone");
  });

  it("returns empty string for a punctuation-only key", () => {
    // These all collapse to "" — writeFact rejects them so they never collide.
    expect(normalizeKey("___")).toBe("");
    expect(normalizeKey("!!!")).toBe("");
    expect(normalizeKey(":")).toBe("");
    expect(normalizeKey("--")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Length cap — write/read/extract must agree on long keys
// ---------------------------------------------------------------------------

describe("normalizeKey — length cap", () => {
  it("caps a very long key at 80 characters", () => {
    const long = "a".repeat(200);
    expect(normalizeKey(long).length).toBe(80);
  });

  it("leaves no trailing hyphen when the cut lands on a separator", () => {
    // 79 chars then a separator then more — cut at 80 would land on the hyphen.
    const raw = "a".repeat(79) + " " + "b".repeat(40);
    const out = normalizeKey(raw);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("-")).toBe(false);
  });

  it("is idempotent on a key that hits the cap", () => {
    const long = "word ".repeat(40); // ~200 chars, many hyphens
    const once = normalizeKey(long);
    expect(normalizeKey(once)).toBe(once);
    expect(once.length).toBeLessThanOrEqual(80);
  });

  it("does not touch keys at or below the cap", () => {
    const k = "decision:" + "x".repeat(60);
    expect(normalizeKey(k)).toBe(k);
  });
});

// ---------------------------------------------------------------------------
// withRawKey helper
// ---------------------------------------------------------------------------

describe("withRawKey", () => {
  it("injects rawKey into an existing metadata object", () => {
    const result = withRawKey({ existing: true }, "Research Focus");
    expect(result).toEqual({ existing: true, rawKey: "Research Focus" });
  });

  it("creates a new object when metadata is null", () => {
    const result = withRawKey(null, "researchFocus");
    expect(result).toEqual({ rawKey: "researchFocus" });
  });

  it("creates a new object when metadata is undefined", () => {
    const result = withRawKey(undefined, "researchFocus");
    expect(result).toEqual({ rawKey: "researchFocus" });
  });

  it("overwrites a pre-existing rawKey on re-normalization", () => {
    const result = withRawKey({ rawKey: "oldSpelling" }, "newSpelling");
    expect(result).toEqual({ rawKey: "newSpelling" });
  });
});
