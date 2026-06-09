// Integration tests — MCP tool pipelines (attend, write, write_rule, archive)
//
// These call the tool pipeline functions directly against the database,
// bypassing the stdio transport. The MCP plumbing (JSON-RPC framing, zod
// validation) is the SDK's responsibility; what we test here is iranti's
// behavior: the bidirectional attend, handshake, caps, and archival.
//
// ensureContext holds module state (one agent + session per process), which
// matches production: vitest forks give this file its own process.

import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../db/connection.js";
import { writeCheckpoint } from "../library/checkpoints.js";
import { findFact, writeFact } from "../library/facts.js";
import { getRuleById } from "../library/rules.js";
import { EXTRACT_SOURCE } from "../mcp/extractor.js";
import { attend, MAX_TOTAL_FACTS } from "../mcp/tools/attend.js";
import { archive } from "../mcp/tools/archive.js";
import { write } from "../mcp/tools/write.js";
import { writeRuleTool } from "../mcp/tools/write-rule.js";

afterAll(async () => {
  await pool.end({ timeout: 5 });
});

describe("attend — write side (extraction)", () => {
  it("stores URLs from the message as facts on the primary entity", async () => {
    const entityId = randomUUID();

    const result = await attend({
      entityHints: [{ entityType: "project", entityId }],
      message: "the design doc is at https://example.com/design-doc check it",
      agentName: "test-agent",
    });

    expect(result.extracted).toHaveLength(1);
    expect(result.extracted[0]!.value).toBe("https://example.com/design-doc");

    // The fact must actually be in the database, tagged as an extract.
    const stored = result.extracted[0]!;
    expect(stored).toBeDefined();
    const facts = await attend({
      entityHints: [{ entityType: "project", entityId }],
    });
    const urlFact = facts.facts.find(
      (f) => f.value === "https://example.com/design-doc",
    );
    expect(urlFact).toBeDefined();
    expect(urlFact!.source).toBe(EXTRACT_SOURCE);
  });

  it("two different URLs produce two facts — no key collision", async () => {
    const entityId = randomUUID();

    await attend({
      entityHints: [{ entityType: "project", entityId }],
      message: "first https://example.com/one",
    });
    await attend({
      entityHints: [{ entityType: "project", entityId }],
      message: "second https://example.com/two",
    });

    const result = await attend({
      entityHints: [{ entityType: "project", entityId }],
    });
    const urls = result.facts.map((f) => f.value).sort();
    expect(urls).toEqual([
      "https://example.com/one",
      "https://example.com/two",
    ]);
  });

  it("re-sharing the same URL does not create a duplicate fact", async () => {
    const entityId = randomUUID();
    const msg = "again: https://example.com/same-link";

    await attend({ entityHints: [{ entityType: "project", entityId }], message: msg });
    await attend({ entityHints: [{ entityType: "project", entityId }], message: msg });

    const result = await attend({
      entityHints: [{ entityType: "project", entityId }],
    });
    expect(result.facts).toHaveLength(1);
  });

  it("extracts nothing when no message is provided", async () => {
    const result = await attend({
      entityHints: [{ entityType: "project", entityId: randomUUID() }],
    });
    expect(result.extracted).toEqual([]);
  });
});

describe("attend — read side", () => {
  it("returns rules for hinted entities plus system/global", async () => {
    const entityId = randomUUID();

    await writeRuleTool({
      entityType: "project",
      entityId,
      text: "Always write tests first.",
      priority: 50,
    });

    const result = await attend({
      entityHints: [{ entityType: "project", entityId }],
    });

    const projectRules = result.rules.filter(
      (r) => r.entity === `project/${entityId}`,
    );
    expect(projectRules).toHaveLength(1);
    expect(projectRules[0]!.text).toBe("Always write tests first.");
  });

  it("returns the active checkpoint separately, not in the facts list", async () => {
    const entityId = randomUUID();

    await writeCheckpoint("project", entityId, "halfway through migration");
    await writeFact({
      entityType: "project",
      entityId,
      key: "tech_stack",
      value: "typescript",
      source: "test",
    });

    const result = await attend({
      entityHints: [{ entityType: "project", entityId }],
    });

    expect(result.checkpoint?.text).toBe("halfway through migration");
    // The checkpoint must not be duplicated in facts.
    expect(result.facts.every((f) => f.key !== "checkpoint")).toBe(true);
    expect(result.facts.map((f) => f.key)).toContain("tech_stack");
  });

  it("caps the total facts returned at MAX_TOTAL_FACTS", async () => {
    const a = randomUUID();
    const b = randomUUID();

    // 15 facts on each of two entities = 30 total, must cap at 20.
    for (const entityId of [a, b]) {
      for (let i = 0; i < 15; i++) {
        await writeFact({
          entityType: "project",
          entityId,
          key: `fact-${i}`,
          value: `value-${i}`,
          source: "test",
        });
      }
    }

    const result = await attend({
      entityHints: [
        { entityType: "project", entityId: a },
        { entityType: "project", entityId: b },
      ],
    });

    expect(result.facts.length).toBeLessThanOrEqual(MAX_TOTAL_FACTS);
  });

  it("returns empty results for an entity with no memory", async () => {
    const result = await attend({
      entityHints: [{ entityType: "project", entityId: randomUUID() }],
    });
    expect(result.facts).toEqual([]);
    expect(result.checkpoint).toBeNull();
  });
});

describe("write", () => {
  it("stores a fact with agent and session provenance", async () => {
    const entityId = randomUUID();

    const result = await write({
      entityType: "project",
      entityId,
      key: "language",
      value: "typescript",
    });

    expect(result.isCheckpoint).toBe(false);

    const fact = await findFact("project", entityId, "language");
    expect(fact?.value).toBe("typescript");
    expect(fact?.agentId).not.toBeNull();
    expect(fact?.sessionId).not.toBeNull();
    expect(fact?.source).toMatch(/^mcp:/);
  });

  it("flags checkpoint writes", async () => {
    const result = await write({
      entityType: "project",
      entityId: randomUUID(),
      key: "checkpoint",
      value: "resume at step 3",
    });
    expect(result.isCheckpoint).toBe(true);
  });
});

describe("write_rule", () => {
  it("stores an active rule with provenance", async () => {
    const entityId = randomUUID();

    const result = await writeRuleTool({
      entityType: "user",
      entityId,
      text: "Respond in English.",
      priority: 100,
    });

    const rule = await getRuleById(result.ruleId);
    expect(rule?.text).toBe("Respond in English.");
    expect(rule?.isActive).toBe(true);
    expect(rule?.priority).toBe(100);
    expect(rule?.agentId).not.toBeNull();
  });
});

describe("archive", () => {
  it("archives by factId", async () => {
    const entityId = randomUUID();
    const written = await write({
      entityType: "project",
      entityId,
      key: "to-go",
      value: "old",
    });

    const result = await archive({ factId: written.factId });
    expect(result.archived).toBe(true);
    expect(await findFact("project", entityId, "to-go")).toBeUndefined();
  });

  it("archives by entity + key", async () => {
    const entityId = randomUUID();
    await write({
      entityType: "project",
      entityId,
      key: "stale",
      value: "old",
    });

    const result = await archive({
      entityType: "project",
      entityId,
      key: "stale",
    });
    expect(result.archived).toBe(true);
    expect(await findFact("project", entityId, "stale")).toBeUndefined();
  });

  it("reports failure cleanly for an unknown entity + key", async () => {
    const result = await archive({
      entityType: "project",
      entityId: randomUUID(),
      key: "never-existed",
    });
    expect(result.archived).toBe(false);
    expect(result.reason).toContain("No active fact");
  });

  it("reports failure cleanly for insufficient identifiers", async () => {
    const result = await archive({ entityType: "project" });
    expect(result.archived).toBe(false);
    expect(result.reason).toContain("Provide either");
  });
});
