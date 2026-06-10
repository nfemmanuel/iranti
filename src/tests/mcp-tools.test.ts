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
import { graph } from "../graph/index.js";
import { EXTRACT_SOURCE } from "../mcp/extractor.js";
import { attend, MAX_TOTAL_FACTS } from "../mcp/tools/attend.js";
import { archive } from "../mcp/tools/archive.js";
import { checkpointTool } from "../mcp/tools/checkpoint.js";
import { history } from "../mcp/tools/history.js";
import { query } from "../mcp/tools/query.js";
import { search } from "../mcp/tools/search.js";
import { write } from "../mcp/tools/write.js";
import { writeIssueTool } from "../mcp/tools/write-issue.js";
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

describe("attend — context window observation (Phase 1.2)", () => {
  it("suppresses a fact whose value is already in currentContext", async () => {
    const entityId = randomUUID();
    await writeFact({
      entityType: "project",
      entityId,
      key: "deploy_target",
      value: "production runs on fly.io in the ord region",
      source: "test",
    });

    const result = await attend({
      entityHints: [{ entityType: "project", entityId }],
      currentContext:
        "We already discussed that production runs on fly.io in the ord region earlier.",
    });

    expect(result.alreadyPresent).toBeGreaterThanOrEqual(1);
    expect(result.facts.some((f) => f.key === "deploy_target")).toBe(false);
  });

  it("still returns a relevant fact that is NOT in currentContext", async () => {
    const entityId = randomUUID();
    await writeFact({
      entityType: "project",
      entityId,
      key: "secret_sauce",
      value: "the caching layer uses a two-tier LRU with a redis backstop",
      source: "test",
    });

    const result = await attend({
      entityHints: [{ entityType: "project", entityId }],
      currentContext: "Totally unrelated window text about lunch plans.",
    });

    expect(result.facts.some((f) => f.key === "secret_sauce")).toBe(true);
    expect(result.alreadyPresent).toBe(0);
  });

  it("no currentContext means no suppression (backward compatible)", async () => {
    const entityId = randomUUID();
    await writeFact({
      entityType: "project",
      entityId,
      key: "framework",
      value: "built on drizzle and postgres.js",
      source: "test",
    });

    const result = await attend({
      entityHints: [{ entityType: "project", entityId }],
    });

    expect(result.alreadyPresent).toBe(0);
    expect(result.facts.some((f) => f.key === "framework")).toBe(true);
  });

  it("never suppresses the checkpoint even when present in currentContext", async () => {
    const entityId = randomUUID();
    await writeCheckpoint(
      "project",
      entityId,
      "midway through the auth refactor, next is token rotation",
    );

    const result = await attend({
      entityHints: [{ entityType: "project", entityId }],
      currentContext:
        "Recall: midway through the auth refactor, next is token rotation.",
    });

    expect(result.checkpoint?.text).toBe(
      "midway through the auth refactor, next is token rotation",
    );
  });

  it("does not suppress very short values (false-positive floor)", async () => {
    const entityId = randomUUID();
    await writeFact({
      entityType: "project",
      entityId,
      key: "ver",
      value: "v2",
      source: "test",
    });

    const result = await attend({
      entityHints: [{ entityType: "project", entityId }],
      currentContext: "this window mentions v2 somewhere",
    });

    // "v2" is below the presence floor, so it is not treated as present.
    expect(result.facts.some((f) => f.key === "ver")).toBe(true);
  });
});

describe("attend — keyword relevance scoring", () => {
  it("surfaces topically relevant facts ahead of recently written off-topic ones", async () => {
    const entityId = randomUUID();

    // UX-related facts written first (older updatedAt)
    await writeFact({
      entityType: "project",
      entityId,
      key: "ux_design_principles",
      value: "prefer minimal interfaces",
      source: "test",
    });
    await writeFact({
      entityType: "project",
      entityId,
      key: "onboarding_flow",
      value: "three-step wizard for new users",
      source: "test",
    });

    // Rate-limiting fact written last (most recent — would lead under pure recency)
    await writeFact({
      entityType: "project",
      entityId,
      key: "rate_limit_config",
      value: "100 requests per minute",
      source: "test",
    });

    const result = await attend({
      entityHints: [{ entityType: "project", entityId }],
      message: "what are the ux design decisions we made for onboarding",
    });

    const keys = result.facts.map((f) => f.key);
    const uxIndex = keys.findIndex(
      (k) => k === "ux_design_principles" || k === "onboarding_flow",
    );
    const rateIndex = keys.findIndex((k) => k === "rate_limit_config");

    // UX fact must appear before the rate limit fact (or rate limit absent entirely)
    if (uxIndex !== -1 && rateIndex !== -1) {
      expect(uxIndex).toBeLessThan(rateIndex);
    } else {
      expect(
        keys.some(
          (k) => k === "ux_design_principles" || k === "onboarding_flow",
        ),
      ).toBe(true);
    }
  });

  it("falls back to recency when no message is provided", async () => {
    const entityId = randomUUID();
    await writeFact({
      entityType: "project",
      entityId,
      key: "older_fact",
      value: "written first",
      source: "test",
    });
    await writeFact({
      entityType: "project",
      entityId,
      key: "newer_fact",
      value: "written second",
      source: "test",
    });

    const result = await attend({
      entityHints: [{ entityType: "project", entityId }],
    });

    expect(result.facts[0]?.key).toBe("newer_fact");
  });
});

describe("search", () => {
  it("finds facts by keyword in key", async () => {
    const entityId = randomUUID();
    await writeFact({
      entityType: "project",
      entityId,
      key: "auth_provider",
      value: "oauth2",
      source: "test",
    });
    await writeFact({
      entityType: "project",
      entityId,
      key: "db_host",
      value: "localhost",
      source: "test",
    });

    const result = await search({ query: "auth_provider" });
    expect(result.results.some((r) => r.key === "auth_provider")).toBe(true);
  });

  it("finds facts by keyword in value", async () => {
    const entityId = randomUUID();
    await writeFact({
      entityType: "project",
      entityId,
      key: "infra_notes",
      value: "migrate postgres to aurora rds",
      source: "test",
    });

    const result = await search({ query: "aurora" });
    expect(
      result.results.some(
        (r) => r.entity === `project/${entityId}` && r.key === "infra_notes",
      ),
    ).toBe(true);
  });

  it("returns empty for a query that matches nothing", async () => {
    const result = await search({ query: `zzznomatch-${randomUUID()}` });
    expect(result.count).toBe(0);
  });

  it("scopes to a specific entity when entityType + entityId provided", async () => {
    const a = randomUUID();
    const b = randomUUID();
    await writeFact({
      entityType: "project",
      entityId: a,
      key: "scope_signal",
      value: "entity-a",
      source: "test",
    });
    await writeFact({
      entityType: "project",
      entityId: b,
      key: "scope_signal",
      value: "entity-b",
      source: "test",
    });

    const result = await search({
      query: "scope_signal",
      entityType: "project",
      entityId: a,
    });
    expect(result.results.every((r) => r.entity === `project/${a}`)).toBe(true);
  });
});

describe("iranti_checkpoint (dedicated tool)", () => {
  it("saves a checkpoint and attend returns it", async () => {
    const entityId = randomUUID();

    const result = await checkpointTool({
      entityType: "project",
      entityId,
      text: "halfway through refactor, next: update tests",
    });

    expect(result.factId).toBeTruthy();
    expect(result.entity).toBe(`project/${entityId}`);

    const attended = await attend({
      entityHints: [{ entityType: "project", entityId }],
    });
    expect(attended.checkpoint?.text).toBe(
      "halfway through refactor, next: update tests",
    );
  });

  it("second checkpoint replaces the first", async () => {
    const entityId = randomUUID();
    await checkpointTool({
      entityType: "project",
      entityId,
      text: "first checkpoint",
    });
    await checkpointTool({
      entityType: "project",
      entityId,
      text: "second checkpoint",
    });

    const attended = await attend({
      entityHints: [{ entityType: "project", entityId }],
    });
    expect(attended.checkpoint?.text).toBe("second checkpoint");
  });
});

describe("history", () => {
  it("returns current value and change history after updates", async () => {
    const entityId = randomUUID();
    await write({
      entityType: "project",
      entityId,
      key: "status",
      value: "planning",
    });
    await write({
      entityType: "project",
      entityId,
      key: "status",
      value: "building",
    });
    await write({
      entityType: "project",
      entityId,
      key: "status",
      value: "shipped",
    });

    const result = await history({
      entityType: "project",
      entityId,
      key: "status",
    });

    expect(result.found).toBe(true);
    expect(result.current?.value).toBe("shipped");
    expect(result.history).toHaveLength(2);
    expect(result.history.map((h) => h.value)).toContain("building");
    expect(result.history.map((h) => h.value)).toContain("planning");
  });

  it("reports not found for a fact that was never written", async () => {
    const result = await history({
      entityType: "project",
      entityId: randomUUID(),
      key: "never-written",
    });
    expect(result.found).toBe(false);
    expect(result.current).toBeNull();
    expect(result.history).toHaveLength(0);
  });

  it("reports an error for insufficient input", async () => {
    const result = await history({ entityType: "project" });
    expect(result.found).toBe(false);
    expect(result.reason).toContain("Provide either");
  });
});

describe("query", () => {
  it("returns the exact current value for a known entity + key", async () => {
    const entityId = randomUUID();
    await write({
      entityType: "project",
      entityId,
      key: "language",
      value: "typescript",
    });

    const result = await query({
      entityType: "project",
      entityId,
      key: "language",
    });

    expect(result.found).toBe(true);
    expect(result.fact?.value).toBe("typescript");
    expect(result.fact?.entity).toBe(`project/${entityId}`);
  });

  it("returns found=false for an unknown key", async () => {
    const result = await query({
      entityType: "project",
      entityId: randomUUID(),
      key: "never-written",
    });
    expect(result.found).toBe(false);
    expect(result.fact).toBeNull();
  });
});

describe("write_issue", () => {
  it("stores a structured issue fact", async () => {
    const entityId = randomUUID();

    const result = await writeIssueTool({
      entityType: "project",
      entityId,
      title: "Dark mode not working",
      description: "Setting is ignored on mobile",
      status: "open",
      priority: "high",
    });

    expect(result.key).toBe("issue:dark-mode-not-working");
    expect(result.status).toBe("open");

    const fact = await findFact(
      "project",
      entityId,
      "issue:dark-mode-not-working",
    );
    const parsed = JSON.parse(fact!.value);
    expect(parsed.title).toBe("Dark mode not working");
    expect(parsed.priority).toBe("high");
    expect(parsed.description).toBe("Setting is ignored on mobile");
  });

  it("same title upserts the issue (status update)", async () => {
    const entityId = randomUUID();
    await writeIssueTool({
      entityType: "project",
      entityId,
      title: "Login bug",
      status: "open",
      priority: "medium",
    });
    await writeIssueTool({
      entityType: "project",
      entityId,
      title: "Login bug",
      status: "resolved",
      priority: "medium",
    });

    const fact = await findFact("project", entityId, "issue:login-bug");
    const parsed = JSON.parse(fact!.value);
    expect(parsed.status).toBe("resolved");
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

// ---------------------------------------------------------------------------
// Phase 3 (CORE-15): two-pass peripheral retrieval via graph hops
// ---------------------------------------------------------------------------

describe("attend — CORE-15 two-pass peripheral retrieval", () => {
  it("graph-linked fact appears in peripheral[], not in facts[]", async () => {
    const entityIdA = randomUUID();
    const entityIdB = randomUUID();

    // Write one fact per entity with no keyword overlap.
    const factA = await writeFact({
      entityType: "project", entityId: entityIdA,
      key: "stack", value: "TypeScript and Node.js", source: "test",
    });
    const factB = await writeFact({
      entityType: "project", entityId: entityIdB,
      key: "database", value: "PostgreSQL 16", source: "test",
    });

    // Create a co_access edge and reinforce it 3× so its weight (3) beats the
    // about edge (weight 1) that recordWriteEdges creates for each fact.
    // The secondary pass picks the highest-weight relation, so co_access wins.
    for (let i = 0; i < 3; i++) {
      await graph.reinforceEdge(
        { type: "fact", id: factA.id },
        { type: "fact", id: factB.id },
        "co_access",
      );
    }

    // Attend for entity A only — factB has no keyword overlap with entity A's hint.
    const result = await attend({
      entityHints: [{ entityType: "project", entityId: entityIdA }],
    });

    // factA's key should be in the primary tier.
    expect(result.facts.some((f) => f.key === "stack")).toBe(true);

    // factB should surface in peripheral, not in primary facts.
    const peripheralKeys = result.peripheral.map((p) => p.key);
    expect(peripheralKeys).toContain("database");
    expect(result.facts.some((f) => f.key === "database")).toBe(false);

    // Peripheral entry carries the relation provenance (co_access wins over about).
    const pFact = result.peripheral.find((p) => p.key === "database");
    expect(pFact?.relation).toBe("co_access");
    expect(pFact?.entity).toContain("project/");
  });

  it("mid-turn attend returns empty peripheral[]", async () => {
    const entityId = randomUUID();
    await writeFact({
      entityType: "project", entityId,
      key: "runtime", value: "Node 22", source: "test",
    });

    const result = await attend({
      entityHints: [{ entityType: "project", entityId }],
      phase: "mid-turn",
    });

    expect(result.peripheral).toHaveLength(0);
  });

  it("2-hop graph path reaches fact two edges away", async () => {
    const idA = randomUUID(), idB = randomUUID(), idC = randomUUID();

    const factA = await writeFact({
      entityType: "project", entityId: idA,
      key: "root", value: "root fact", source: "test",
    });
    const factB = await writeFact({
      entityType: "project", entityId: idB,
      key: "middle", value: "middle fact", source: "test",
    });
    const factC = await writeFact({
      entityType: "project", entityId: idC,
      key: "distant", value: "distant fact", source: "test",
    });

    // A → B (1 hop), B → C (2nd hop from A).
    await graph.reinforceEdge({ type: "fact", id: factA.id }, { type: "fact", id: factB.id }, "co_access");
    await graph.reinforceEdge({ type: "fact", id: factB.id }, { type: "fact", id: factC.id }, "co_access");

    const result = await attend({
      entityHints: [{ entityType: "project", entityId: idA }],
    });

    // factC (2 hops from A) must appear in peripheral.
    expect(result.peripheral.some((p) => p.key === "distant")).toBe(true);
  });

  it("facts in peripheral[] are not duplicated in primary facts[]", async () => {
    const entityIdA = randomUUID();
    const entityIdB = randomUUID();

    const factP = await writeFact({
      entityType: "project", entityId: entityIdA,
      key: "lang", value: "Go", source: "test",
    });
    const factQ = await writeFact({
      entityType: "project", entityId: entityIdB,
      key: "infra", value: "Kubernetes", source: "test",
    });

    await graph.reinforceEdge(
      { type: "fact", id: factP.id },
      { type: "fact", id: factQ.id },
      "co_access",
    );

    // Both entities in scope — both facts should land in primary tier.
    const result = await attend({
      entityHints: [
        { entityType: "project", entityId: entityIdA },
        { entityType: "project", entityId: entityIdB },
      ],
    });

    const primaryEntries = new Set(result.facts.map((f) => `${f.entity}::${f.key}`));
    for (const p of result.peripheral) {
      expect(primaryEntries.has(`${p.entity}::${p.key}`)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 3 (CORE-33): token-budgeted injection
// ---------------------------------------------------------------------------

describe("attend — CORE-33 token-budgeted injection", () => {
  it("tiny token budget truncates primary facts, returns fewer than stored", async () => {
    const entityId = randomUUID();

    // Write 5 facts with ~80-char values (each ~20 tokens).
    const longVal = "x".repeat(80);
    for (let i = 0; i < 5; i++) {
      await writeFact({
        entityType: "project", entityId,
        key: `fact-${i}`, value: `${longVal}-${i}`, source: "test",
      });
    }

    // Budget of 3 tokens is far too small for any fact (80 chars ≈ 20 tokens each).
    const prev = process.env["IRANTI_TOKEN_BUDGET"];
    try {
      process.env["IRANTI_TOKEN_BUDGET"] = "3";
      const result = await attend({
        entityHints: [{ entityType: "project", entityId }],
      });
      // With a 3-token budget, zero ~20-token facts should fit.
      expect(result.facts).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env["IRANTI_TOKEN_BUDGET"];
      else process.env["IRANTI_TOKEN_BUDGET"] = prev;
    }
  });

  it("primary facts have higher priority than peripheral (budget order)", async () => {
    const entityIdA = randomUUID();
    const entityIdB = randomUUID();

    // Write a short primary fact (3 tokens ≈ 12 chars) and a short peripheral fact
    // (3 tokens). Budget = 4: primary (3 tokens) fits, peripheral (3 tokens) does not.
    const factA = await writeFact({
      entityType: "project", entityId: entityIdA,
      key: "prim", value: "x".repeat(12), source: "test",
    });
    const factB = await writeFact({
      entityType: "project", entityId: entityIdB,
      key: "periph", value: "x".repeat(12), source: "test",
    });

    // Link A → B so factB surfaces as peripheral.
    await graph.reinforceEdge(
      { type: "fact", id: factA.id },
      { type: "fact", id: factB.id },
      "co_access",
    );

    // Budget 4 tokens: enough for the primary fact (ceil(12/4)=3) but not
    // peripheral after primary consumes most of the budget. Rules and checkpoint
    // are empty for this entity so all 4 tokens are available to primary facts.
    const prev = process.env["IRANTI_TOKEN_BUDGET"];
    try {
      process.env["IRANTI_TOKEN_BUDGET"] = "4";
      const result = await attend({
        entityHints: [{ entityType: "project", entityId: entityIdA }],
      });
      // Primary fact survives (higher priority than peripheral).
      expect(result.facts.some((f) => f.key === "prim")).toBe(true);
      // Peripheral fact is dropped (budget exhausted).
      expect(result.peripheral.some((p) => p.key === "periph")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env["IRANTI_TOKEN_BUDGET"];
      else process.env["IRANTI_TOKEN_BUDGET"] = prev;
    }
  });

  it("default budget (2000 tokens) does not truncate typical payloads", async () => {
    const entityId = randomUUID();

    // Write 5 facts with short values — well within the default 2000-token budget.
    for (let i = 0; i < 5; i++) {
      await writeFact({
        entityType: "project", entityId,
        key: `k${i}`, value: `short value ${i}`, source: "test",
      });
    }

    const result = await attend({
      entityHints: [{ entityType: "project", entityId }],
    });

    expect(result.facts).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 (CORE-17): stale-context corrections
// ---------------------------------------------------------------------------

describe("attend — CORE-17 stale-context corrections", () => {
  it("correction fires when host context holds superseded value", async () => {
    const entityId = randomUUID();

    // Write the fact once (creates version 1: staleVal)...
    await writeFact({
      entityType: "project", entityId,
      key: "stack:language", value: "TypeScript is primary", source: "test",
    });
    // ...then overwrite it (archives staleVal, makes currentVal live).
    await writeFact({
      entityType: "project", entityId,
      key: "stack:language", value: "Rust is primary now", source: "test",
    });

    // Host passes context that still mentions the old value but not the new one.
    const result = await attend({
      entityHints: [{ entityType: "project", entityId }],
      currentContext: "the team decided TypeScript is primary for all services",
    });

    expect(result.corrections.length).toBeGreaterThan(0);
    const c = result.corrections.find((x) => x.key === "stack:language")!;
    expect(c).toBeDefined();
    expect(c.staleValue).toBe("TypeScript is primary");
    expect(c.currentValue).toBe("Rust is primary now");
  });

  it("no correction when fact has never been updated (no archive entry)", async () => {
    const entityId = randomUUID();

    await writeFact({
      entityType: "project", entityId,
      key: "stack:infra", value: "Kubernetes clusters", source: "test",
    });

    // Context does NOT contain the current value, but there is no archived value
    // to match against — so no correction should fire.
    const result = await attend({
      entityHints: [{ entityType: "project", entityId }],
      currentContext: "we use Docker compose for local dev",
    });

    const c = result.corrections.find((x) => x.key === "stack:infra");
    expect(c).toBeUndefined();
  });

  it("no corrections returned when currentContext is omitted", async () => {
    const entityId = randomUUID();

    await writeFact({
      entityType: "project", entityId,
      key: "stack:language", value: "Go is primary language", source: "test",
    });
    await writeFact({
      entityType: "project", entityId,
      key: "stack:language", value: "Elixir is primary language", source: "test",
    });

    // No context passed — drift is not triggered here, and no context means no
    // comparison possible.
    process.env["IRANTI_DRIFT_N"] = "999";
    try {
      const result = await attend({
        entityHints: [{ entityType: "project", entityId }],
      });
      expect(result.corrections).toHaveLength(0);
    } finally {
      delete process.env["IRANTI_DRIFT_N"];
    }
  });

  it("no correction when current value is already present in context", async () => {
    const entityId = randomUUID();

    await writeFact({
      entityType: "project", entityId,
      key: "stack:db", value: "PostgreSQL is the database", source: "test",
    });
    await writeFact({
      entityType: "project", entityId,
      key: "stack:db", value: "CockroachDB is the database", source: "test",
    });

    // Context already holds the current value — nothing stale to report.
    const result = await attend({
      entityHints: [{ entityType: "project", entityId }],
      currentContext: "CockroachDB is the database chosen for production",
    });

    const c = result.corrections.find((x) => x.key === "stack:db");
    expect(c).toBeUndefined();
  });
});
