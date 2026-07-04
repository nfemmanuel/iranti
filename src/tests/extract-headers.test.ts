// Unit tests — buildHeaders (extract/index.ts), pure, no database.
//
// extraction-measurement.md §3 change 2: LocalLlmExtractor's fetch gains
// optional auth headers from IRANTI_LLM_API_KEY. buildHeaders is the pure
// (endpoint, apiKey) -> headers function that assembly logic was pulled
// into specifically so it has a direct unit test without a real or mocked
// network call.

import { describe, expect, it } from "vitest";
import { buildHeaders } from "../extract/index.js";

describe("buildHeaders", () => {
  it("returns only Content-Type when no key is set", () => {
    const headers = buildHeaders("http://localhost:11434/v1", undefined);
    expect(headers).toEqual({ "Content-Type": "application/json" });
  });

  it("returns only Content-Type when the key is an empty string", () => {
    const headers = buildHeaders("http://localhost:11434/v1", "");
    expect(headers).toEqual({ "Content-Type": "application/json" });
  });

  it("sends both Authorization: Bearer and x-api-key when a key is set", () => {
    const headers = buildHeaders("https://api.some-provider.com/v1", "sk-test-123");
    expect(headers["Authorization"]).toBe("Bearer sk-test-123");
    expect(headers["x-api-key"]).toBe("sk-test-123");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("adds anthropic-version only when the endpoint host contains anthropic.com", () => {
    const headers = buildHeaders("https://api.anthropic.com/v1", "sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("does not add anthropic-version for a non-Anthropic endpoint (e.g. Ollama or NIM)", () => {
    const ollama = buildHeaders("http://localhost:11434/v1", "some-key");
    expect(ollama["anthropic-version"]).toBeUndefined();

    const nim = buildHeaders("https://integrate.api.nvidia.com/v1", "nvapi-test");
    expect(nim["anthropic-version"]).toBeUndefined();
  });

  it("does not add anthropic-version when no key is set, even against an anthropic.com endpoint", () => {
    // No key => no auth at all => no reason to send a version header either
    // (the request would be unauthenticated regardless).
    const headers = buildHeaders("https://api.anthropic.com/v1", undefined);
    expect(headers).toEqual({ "Content-Type": "application/json" });
  });

  it("never includes the raw key under any other header name (only Authorization/x-api-key)", () => {
    const headers = buildHeaders("https://api.anthropic.com/v1", "sk-ant-secret");
    const values = Object.entries(headers).filter(
      ([name]) => name !== "Authorization" && name !== "x-api-key",
    );
    for (const [, value] of values) {
      expect(value).not.toContain("sk-ant-secret");
    }
  });
});
