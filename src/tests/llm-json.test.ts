// parseLlmJson unit tests.
//
// Pure unit tests — no database needed, no network calls. Covers the full
// input space of nondeterministic LLM output that parseLlmJson must handle.

import { describe, expect, it } from "vitest";
import { parseLlmJson } from "../library/llm-json.js";

// ---------------------------------------------------------------------------
// Plain JSON (no fencing)
// ---------------------------------------------------------------------------

describe("parseLlmJson — plain JSON inputs", () => {
  it("parses a plain JSON object", () => {
    const result = parseLlmJson<{ a: number }>('{"a": 1}');
    expect(result).toEqual({ a: 1 });
  });

  it("parses a plain JSON array", () => {
    const result = parseLlmJson<number[]>("[1, 2, 3]");
    expect(result).toEqual([1, 2, 3]);
  });

  it("parses an empty array", () => {
    const result = parseLlmJson<unknown[]>("[]");
    expect(result).toEqual([]);
  });

  it("parses a nested object/array", () => {
    const input = '{"key": "decision:use-typescript", "nested": [1, {"deep": true}]}';
    const result = parseLlmJson<{ key: string; nested: unknown[] }>(input);
    expect(result.key).toBe("decision:use-typescript");
    expect(result.nested).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Markdown fenced JSON
// ---------------------------------------------------------------------------

describe("parseLlmJson — markdown fence stripping", () => {
  it("parses a ```json fenced block", () => {
    const input = "```json\n{\"a\": 1}\n```";
    const result = parseLlmJson<{ a: number }>(input);
    expect(result).toEqual({ a: 1 });
  });

  it("parses a bare ``` fenced block (no 'json' tag)", () => {
    const input = "```\n{\"a\": 2}\n```";
    const result = parseLlmJson<{ a: number }>(input);
    expect(result).toEqual({ a: 2 });
  });

  it("parses a fenced block preceded by leading prose (the case the old vision regex missed)", () => {
    const input = "Here is the JSON description:\n```json\n{\"description\": \"a cat\", \"tags\": [\"cat\"]}\n```";
    const result = parseLlmJson<{ description: string; tags: string[] }>(input);
    expect(result.description).toBe("a cat");
    expect(result.tags).toEqual(["cat"]);
  });

  it("parses a fenced block with trailing text after the closing fence", () => {
    const input = "```json\n[{\"key\": \"decision:use-react\"}]\n```\n\nLet me know if you need more.";
    const result = parseLlmJson<Array<{ key: string }>>(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.key).toBe("decision:use-react");
  });

  it("parses a fenced block with both leading prose and trailing text", () => {
    const input = "Sure! Here you go:\n```json\n{\"v\": 42}\n```\nHope that helps.";
    const result = parseLlmJson<{ v: number }>(input);
    expect(result).toEqual({ v: 42 });
  });
});

// ---------------------------------------------------------------------------
// Balanced-scan fallback (prose with no fence)
// ---------------------------------------------------------------------------

describe("parseLlmJson — balanced-scan fallback", () => {
  it("extracts JSON from prose without any fence", () => {
    const input = 'The answer is {"key": "preference:no-var", "value": "never use var"} as requested.';
    const result = parseLlmJson<{ key: string; value: string }>(input);
    expect(result.key).toBe("preference:no-var");
  });

  it("handles a { inside a JSON string value without breaking the scan", () => {
    // This is the key correctness test for the balanced scanner — a naive
    // greedy regex would incorrectly parse from { to the last } in the string.
    const input = '{"v": "a { b"}';
    const result = parseLlmJson<{ v: string }>(input);
    expect(result).toEqual({ v: "a { b" });
  });

  it("handles a ] inside a JSON string value", () => {
    const input = '[{"note": "items: [1,2,3]"}]';
    const result = parseLlmJson<Array<{ note: string }>>(input);
    expect(result[0]!.note).toBe("items: [1,2,3]");
  });

  it("handles escaped quotes inside string values", () => {
    const input = '{"msg": "he said \\"hello\\""}';
    const result = parseLlmJson<{ msg: string }>(input);
    expect(result.msg).toBe('he said "hello"');
  });
});

// ---------------------------------------------------------------------------
// Error path — genuinely non-JSON input must throw
// ---------------------------------------------------------------------------

describe("parseLlmJson — throws on unparseable input", () => {
  it("throws on a plain prose string with no JSON structure", () => {
    expect(() => parseLlmJson("sorry I cannot help with that")).toThrow();
  });

  it("throws on an empty string", () => {
    expect(() => parseLlmJson("")).toThrow();
  });

  it("throws on whitespace-only input", () => {
    expect(() => parseLlmJson("   \n  ")).toThrow();
  });
});
