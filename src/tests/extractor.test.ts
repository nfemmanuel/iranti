// Unit tests — extractor.ts (pure, no database)

import { describe, expect, it } from "vitest";
import {
  MAX_EXTRACTS_PER_MESSAGE,
  extractArtifacts,
} from "../mcp/extractor.js";

describe("extractArtifacts — URLs", () => {
  it("extracts a plain URL", () => {
    const result = extractArtifacts("check out https://example.com/docs for info");
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("url");
    expect(result[0]!.value).toBe("https://example.com/docs");
  });

  it("strips trailing sentence punctuation", () => {
    const result = extractArtifacts("see https://example.com/page.");
    expect(result[0]!.value).toBe("https://example.com/page");
  });

  it("extracts the URL from a markdown link without the closing paren", () => {
    const result = extractArtifacts("read [the docs](https://example.com/api) first");
    expect(result).toHaveLength(1);
    expect(result[0]!.value).toBe("https://example.com/api");
  });

  it("extracts multiple distinct URLs", () => {
    const result = extractArtifacts(
      "compare https://a.com/x and https://b.com/y",
    );
    expect(result.map((r) => r.value)).toEqual([
      "https://a.com/x",
      "https://b.com/y",
    ]);
  });

  it("dedupes the same URL appearing twice", () => {
    const result = extractArtifacts(
      "https://example.com/x and again https://example.com/x",
    );
    expect(result).toHaveLength(1);
  });
});

describe("extractArtifacts — file paths", () => {
  it("extracts a Windows path", () => {
    const result = extractArtifacts(String.raw`the file is at C:\Users\NF\project\file.ts ok`);
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("file_path");
    expect(result[0]!.value).toBe(String.raw`C:\Users\NF\project\file.ts`);
  });

  it("extracts a Unix absolute path with two or more segments", () => {
    const result = extractArtifacts("config lives in /etc/nginx/nginx.conf there");
    expect(result).toHaveLength(1);
    expect(result[0]!.value).toBe("/etc/nginx/nginx.conf");
  });

  it("does not extract a single-segment slash token", () => {
    // "/a" or "and/or"-like fragments should not become facts.
    const result = extractArtifacts("either /yes or no");
    expect(result).toHaveLength(0);
  });

  it("extracts a relative path", () => {
    const result = extractArtifacts("edit ./src/db/schema.ts next");
    expect(result).toHaveLength(1);
    expect(result[0]!.value).toBe("./src/db/schema.ts");
  });

  it("does not double-extract the tail of a relative path as a unix path", () => {
    const result = extractArtifacts("edit ./src/db/schema.ts next");
    expect(result).toHaveLength(1);
  });

  it("does not extract the path component of a URL as a file path", () => {
    const result = extractArtifacts("see https://example.com/docs/api/reference");
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("url");
  });
});

describe("extractArtifacts — keys", () => {
  it("generates collision-safe keys: same value → same key, different value → different key", () => {
    const [a1] = extractArtifacts("https://example.com/one");
    const [a2] = extractArtifacts("https://example.com/one");
    const [b] = extractArtifacts("https://example.com/two");

    expect(a1!.key).toBe(a2!.key); // deterministic
    expect(a1!.key).not.toBe(b!.key); // collision-safe
    expect(a1!.key).toMatch(/^shared_url:[0-9a-f]{12}$/);
  });

  it("uses the referenced_file prefix for paths", () => {
    const [a] = extractArtifacts("look in /var/log/app.log please");
    expect(a!.key).toMatch(/^referenced_file:[0-9a-f]{12}$/);
  });
});

describe("extractArtifacts — limits", () => {
  it("caps extraction at MAX_EXTRACTS_PER_MESSAGE", () => {
    const urls = Array.from(
      { length: 30 },
      (_, i) => `https://example.com/page-${i}`,
    ).join(" ");
    const result = extractArtifacts(urls);
    expect(result).toHaveLength(MAX_EXTRACTS_PER_MESSAGE);
  });

  it("returns an empty array for a message with no artifacts", () => {
    expect(extractArtifacts("just a plain sentence about nothing")).toEqual([]);
  });

  it("returns an empty array for an empty message", () => {
    expect(extractArtifacts("")).toEqual([]);
  });
});
