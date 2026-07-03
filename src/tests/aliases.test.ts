// Integration tests — aliases.ts (Layer 0c, entity resolution)

import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../db/connection.js";
import {
  archiveAlias,
  learnAlias,
  listAliasesForEntity,
  normalizeAlias,
  resolveAlias,
} from "../library/aliases.js";

afterAll(async () => {
  await pool.end({ timeout: 5 });
});

describe("normalizeAlias", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeAlias("  The   Figma File  ")).toBe("the figma file");
  });
});

describe("learnAlias", () => {
  it("creates a new alias that resolves via resolveAlias", async () => {
    const entityId = randomUUID();

    await learnAlias({
      entityType: "project",
      entityId,
      rawAlias: "the figma file",
      factKey: "shared_url:abc123def456",
      source: "extractor_heuristic",
    });

    const resolved = await resolveAlias(
      "project",
      entityId,
      "Where's the figma file?",
    );
    expect(resolved?.factKey).toBe("shared-url:abc123def456");
  });

  it("re-learning the same alias text upserts rather than duplicating", async () => {
    const entityId = randomUUID();

    await learnAlias({
      entityType: "project",
      entityId,
      rawAlias: "the widget",
      factKey: "decision:old-target",
      source: "extractor_heuristic",
    });
    await learnAlias({
      entityType: "project",
      entityId,
      rawAlias: "the widget",
      factKey: "decision:new-target",
      source: "extractor_heuristic",
    });

    const all = await listAliasesForEntity("project", entityId);
    expect(all).toHaveLength(1);
    expect(all[0]!.factKey).toBe("decision:new-target");
  });

  it("normalizes factKey the same way writeFact does", async () => {
    const entityId = randomUUID();
    await learnAlias({
      entityType: "project",
      entityId,
      rawAlias: "the doc",
      factKey: "Decision: Some Thing",
      source: "extractor_heuristic",
    });
    const [row] = await listAliasesForEntity("project", entityId);
    expect(row!.factKey).not.toContain(" ");
    expect(row!.factKey).not.toContain(":S");
  });

  it("throws on an alias that normalizes to empty", async () => {
    await expect(
      learnAlias({
        entityType: "project",
        entityId: randomUUID(),
        rawAlias: "   ",
        factKey: "decision:x",
        source: "extractor_heuristic",
      }),
    ).rejects.toThrow();
  });
});

describe("resolveAlias", () => {
  it("returns undefined when no alias matches", async () => {
    const entityId = randomUUID();
    await learnAlias({
      entityType: "project",
      entityId,
      rawAlias: "the figma file",
      factKey: "shared_url:aaa",
      source: "extractor_heuristic",
    });

    const resolved = await resolveAlias("project", entityId, "what database do we use?");
    expect(resolved).toBeUndefined();
  });

  it("returns undefined for an unknown entity", async () => {
    const resolved = await resolveAlias(
      "project",
      randomUUID(),
      "where's the figma file?",
    );
    expect(resolved).toBeUndefined();
  });

  it("is case- and whitespace-insensitive", async () => {
    const entityId = randomUUID();
    await learnAlias({
      entityType: "project",
      entityId,
      rawAlias: "the reconciliation doc",
      factKey: "shared_url:bbb",
      source: "extractor_heuristic",
    });

    const resolved = await resolveAlias(
      "project",
      entityId,
      "  WHERE'S    THE   RECONCILIATION   DOC  ?",
    );
    expect(resolved?.factKey).toBe("shared-url:bbb");
  });

  it("prefers the longest matching alias when multiple match the same message", async () => {
    const entityId = randomUUID();
    await learnAlias({
      entityType: "project",
      entityId,
      rawAlias: "the doc",
      factKey: "shared_url:short-target",
      source: "extractor_heuristic",
    });
    await learnAlias({
      entityType: "project",
      entityId,
      rawAlias: "the reconciliation doc",
      factKey: "shared_url:long-target",
      source: "extractor_heuristic",
    });

    const resolved = await resolveAlias(
      "project",
      entityId,
      "where's the reconciliation doc?",
    );
    expect(resolved?.factKey).toBe("shared-url:long-target");
  });

  it("does not resolve an archived alias", async () => {
    const entityId = randomUUID();
    const row = await learnAlias({
      entityType: "project",
      entityId,
      rawAlias: "the sync wiki page",
      factKey: "shared_url:ccc",
      source: "extractor_heuristic",
    });

    expect(await archiveAlias(row.id)).toBe(true);

    const resolved = await resolveAlias(
      "project",
      entityId,
      "where's the sync wiki page?",
    );
    expect(resolved).toBeUndefined();
  });
});

describe("archiveAlias", () => {
  it("is idempotent — archiving an already-archived alias returns false", async () => {
    const entityId = randomUUID();
    const row = await learnAlias({
      entityType: "project",
      entityId,
      rawAlias: "the widget",
      factKey: "decision:x",
      source: "extractor_heuristic",
    });

    expect(await archiveAlias(row.id)).toBe(true);
    expect(await archiveAlias(row.id)).toBe(false);
  });

  it("returns false for an alias outside the caller's project scope (never a hard delete, never cross-project)", async () => {
    const entityId = randomUUID();
    const projectA = `/fake/projects/${randomUUID()}`;
    const projectB = `/fake/projects/${randomUUID()}`;

    const row = await learnAlias({
      entityType: "project",
      entityId,
      rawAlias: "the figma file",
      factKey: "shared_url:scoped",
      source: "extractor_heuristic",
      project: projectA,
    });

    expect(await archiveAlias(row.id, [projectB])).toBe(false);
    expect(await archiveAlias(row.id, [projectA])).toBe(true);
  });

  it("returns false for a nonexistent alias id", async () => {
    expect(await archiveAlias(randomUUID())).toBe(false);
  });
});

describe("project scoping (Layer 0 D6/D7)", () => {
  it("an alias learned in project A does not resolve in project B, even with an identical entity", async () => {
    const entityId = "shared-entity-name";
    const projectA = `/fake/projects/${randomUUID()}`;
    const projectB = `/fake/projects/${randomUUID()}`;

    await learnAlias({
      entityType: "project",
      entityId,
      rawAlias: "the figma file",
      factKey: "shared_url:project-a-secret",
      source: "extractor_heuristic",
      project: projectA,
    });

    const resolvedInB = await resolveAlias(
      "project",
      entityId,
      "where's the figma file?",
      "default",
      projectB,
    );
    expect(resolvedInB).toBeUndefined();

    const resolvedInA = await resolveAlias(
      "project",
      entityId,
      "where's the figma file?",
      "default",
      projectA,
    );
    expect(resolvedInA?.factKey).toBe("shared-url:project-a-secret");
  });

  it("resolves across a combined project pair via the effective project set", async () => {
    const { combineProjects, getEffectiveProjectIds } = await import("../library/projects.js");
    const entityId = "combine-alias-check";
    const projectA = `/fake/projects/${randomUUID()}`;
    const projectB = `/fake/projects/${randomUUID()}`;

    await learnAlias({
      entityType: "project",
      entityId,
      rawAlias: "the dashboard run",
      factKey: "shared_url:combined-target",
      source: "extractor_heuristic",
      project: projectA,
    });

    await combineProjects(projectA, projectB);
    const effectiveForB = await getEffectiveProjectIds(projectB);

    const resolved = await resolveAlias(
      "project",
      entityId,
      "where's the dashboard run?",
      "default",
      effectiveForB,
    );
    expect(resolved?.factKey).toBe("shared-url:combined-target");
  });
});
