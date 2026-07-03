// Unit tests — extractor.ts (pure, no database)

import { describe, expect, it } from "vitest";
import {
  MAX_EXTRACTS_PER_MESSAGE,
  extractAliases,
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

// ---------------------------------------------------------------------------
// extractAliases — Layer 0c (entity resolution)
// ---------------------------------------------------------------------------

describe("extractAliases — the 4 real corpus phrasings", () => {
  it("matches 'everyone calls it X' bound to the URL earlier in the message", () => {
    const message =
      "See https://www.figma.com/file/abc123/dashboard-redesign for the latest mocks — everyone just calls it 'the figma file' in Slack.";
    const artifacts = extractArtifacts(message);
    const aliases = extractAliases(message, artifacts);
    expect(aliases).toHaveLength(1);
    expect(aliases[0]!.rawAlias).toBe("the figma file");
    expect(aliases[0]!.factKey).toBe(artifacts[0]!.key);
  });

  it("matches 'I keep calling it X' (gerund, not just 'call'/'calls')", () => {
    const message =
      "See https://github.com/acme/ledger-service/blob/main/docs/reconciliation.md for the reconciliation job — I keep calling it 'the reconciliation doc' in standup, same thing.";
    const artifacts = extractArtifacts(message);
    const aliases = extractAliases(message, artifacts);
    expect(aliases).toHaveLength(1);
    expect(aliases[0]!.rawAlias).toBe("the reconciliation doc");
    expect(aliases[0]!.factKey).toBe(artifacts[0]!.key);
  });

  it("matches 'I just call it X'", () => {
    const message =
      "See https://wandb.ai/acme/churn-model/runs/xyz for the full run comparison — I just call it 'the dashboard run' when I mention it in meetings.";
    const artifacts = extractArtifacts(message);
    const aliases = extractAliases(message, artifacts);
    expect(aliases).toHaveLength(1);
    expect(aliases[0]!.rawAlias).toBe("the dashboard run");
    expect(aliases[0]!.factKey).toBe(artifacts[0]!.key);
  });

  it("matches 'some people call it X'", () => {
    const message =
      "here's the thing, https://internal.acme.example/wiki/sync-job has the full runbook, way more than I can type here, some people call it 'the sync wiki page' too";
    const artifacts = extractArtifacts(message);
    const aliases = extractAliases(message, artifacts);
    expect(aliases).toHaveLength(1);
    expect(aliases[0]!.rawAlias).toBe("the sync wiki page");
    expect(aliases[0]!.factKey).toBe(artifacts[0]!.key);
  });
});

describe("extractAliases — precision guardrails", () => {
  it("returns [] when the alias phrase matches but the message has no artifact to bind to", () => {
    // This is the messy-conversationalist "the widget" entity-alias case —
    // out of scope per the PRD (entity-level aliasing, not fact-level), and
    // structurally impossible to bind since there is no in-message artifact.
    const message =
      "oh also — decision: we're calling it 'the widget' internally even though the doc says 'internal-tools-dashboard', don't let that confuse you";
    const artifacts = extractArtifacts(message);
    expect(artifacts).toHaveLength(0);
    expect(extractAliases(message, artifacts)).toEqual([]);
  });

  it("returns [] for ordinary sentences with no alias phrasing", () => {
    const message = "We decided to use PostgreSQL 16 with Drizzle as the ORM for the payments service.";
    const artifacts = extractArtifacts(message);
    expect(extractAliases(message, artifacts)).toEqual([]);
  });

  it("returns [] for an empty message", () => {
    expect(extractAliases("", [])).toEqual([]);
  });

  it("binds to the LAST artifact when a message contains more than one", () => {
    const message =
      "compare https://a.com/x and https://b.com/y — everyone calls it 'the good one'";
    const artifacts = extractArtifacts(message);
    expect(artifacts).toHaveLength(2);
    const aliases = extractAliases(message, artifacts);
    expect(aliases).toHaveLength(1);
    expect(aliases[0]!.factKey).toBe(artifacts[1]!.key);
  });

  it("supports 'aka X' shorthand", () => {
    const message = "check https://example.com/runbook, aka the runbook";
    const artifacts = extractArtifacts(message);
    const aliases = extractAliases(message, artifacts);
    expect(aliases).toHaveLength(1);
    expect(aliases[0]!.rawAlias).toBe("the runbook");
  });

  it("rejects an absurdly long alias phrase (probable false match)", () => {
    const longPhrase = "x".repeat(100);
    const message = `see https://example.com/thing, aka ${longPhrase}`;
    const artifacts = extractArtifacts(message);
    expect(extractAliases(message, artifacts)).toEqual([]);
  });
});
