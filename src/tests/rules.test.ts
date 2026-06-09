// Integration tests — rules.ts

import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../db/connection.js";
import {
  deactivateRule,
  getRuleById,
  getRulesForAttend,
  getRulesForEntity,
  writeRule,
} from "../library/rules.js";

afterAll(async () => {
  await pool.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------
// writeRule
// ---------------------------------------------------------------------------

describe("writeRule", () => {
  it("creates a new rule that is active by default", async () => {
    const entityId = randomUUID();

    const rule = await writeRule({
      entityType: "user",
      entityId,
      text: "always respond in English",
      source: "test",
      priority: 10,
    });

    expect(rule.id).toBeDefined();
    expect(rule.text).toBe("always respond in English");
    expect(rule.isActive).toBe(true);
    expect(rule.priority).toBe(10);
    expect(rule.createdAt).toBeInstanceOf(Date);
  });

  it("is additive — two calls create two independent rules for the same entity", async () => {
    const entityId = randomUUID();

    const r1 = await writeRule({
      entityType: "user",
      entityId,
      text: "rule one",
      source: "test",
      priority: 0,
    });

    const r2 = await writeRule({
      entityType: "user",
      entityId,
      text: "rule two",
      source: "test",
      priority: 0,
    });

    // Two distinct rows — not an upsert
    expect(r1.id).not.toBe(r2.id);
  });
});

// ---------------------------------------------------------------------------
// getRulesForEntity
// ---------------------------------------------------------------------------

describe("getRulesForEntity", () => {
  it("returns active rules for an entity ordered by priority DESC", async () => {
    const entityId = randomUUID();

    await writeRule({ entityType: "project", entityId, text: "low", source: "test", priority: 1 });
    await writeRule({ entityType: "project", entityId, text: "high", source: "test", priority: 100 });
    await writeRule({ entityType: "project", entityId, text: "mid", source: "test", priority: 50 });

    const rules = await getRulesForEntity("project", entityId);

    expect(rules.map((r) => r.priority)).toEqual([100, 50, 1]);
  });

  it("excludes deactivated rules", async () => {
    const entityId = randomUUID();

    const active = await writeRule({
      entityType: "user",
      entityId,
      text: "keep me",
      source: "test",
      priority: 0,
    });
    const inactive = await writeRule({
      entityType: "user",
      entityId,
      text: "deactivate me",
      source: "test",
      priority: 0,
    });

    await deactivateRule(inactive.id);

    const rules = await getRulesForEntity("user", entityId);
    const ids = rules.map((r) => r.id);

    expect(ids).toContain(active.id);
    expect(ids).not.toContain(inactive.id);
  });
});

// ---------------------------------------------------------------------------
// getRulesForAttend
// ---------------------------------------------------------------------------

describe("getRulesForAttend", () => {
  it("always includes system/global rules even when hints is empty", async () => {
    const globalRule = await writeRule({
      entityType: "system",
      entityId: "global",
      text: `global-test-${randomUUID()}`,
      source: "test",
      priority: 0,
    });

    // Empty hints — only system/global should come back
    const rules = await getRulesForAttend([]);

    expect(rules.some((r) => r.id === globalRule.id)).toBe(true);
  });

  it("includes rules scoped to entities in the hints list", async () => {
    const entityId = randomUUID();

    const userRule = await writeRule({
      entityType: "user",
      entityId,
      text: "user-specific rule",
      source: "test",
      priority: 0,
    });

    const rules = await getRulesForAttend([{ entityType: "user", entityId }]);

    expect(rules.some((r) => r.id === userRule.id)).toBe(true);
  });

  it("does not duplicate system/global rules when system/global is included in hints", async () => {
    const marker = `dedup-${randomUUID()}`;

    const globalRule = await writeRule({
      entityType: "system",
      entityId: "global",
      text: marker,
      source: "test",
      priority: 0,
    });

    // Passing system/global explicitly should NOT produce duplicate rows
    const rules = await getRulesForAttend([
      { entityType: "system", entityId: "global" },
    ]);

    const matching = rules.filter((r) => r.id === globalRule.id);
    expect(matching).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// deactivateRule
// ---------------------------------------------------------------------------

describe("deactivateRule", () => {
  it("sets isActive=false without deleting the record", async () => {
    const entityId = randomUUID();

    const rule = await writeRule({
      entityType: "user",
      entityId,
      text: "temporary rule",
      source: "test",
      priority: 0,
    });

    expect(rule.isActive).toBe(true);

    await deactivateRule(rule.id);

    const updated = await getRuleById(rule.id);
    expect(updated).toBeDefined(); // record still exists
    expect(updated?.isActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getRuleById
// ---------------------------------------------------------------------------

describe("getRuleById", () => {
  it("returns the rule by ID with no side effects", async () => {
    const entityId = randomUUID();

    const rule = await writeRule({
      entityType: "project",
      entityId,
      text: "check implementation.md",
      source: "test",
      priority: 70,
    });

    const found = await getRuleById(rule.id);

    expect(found).toBeDefined();
    expect(found?.text).toBe("check implementation.md");
    expect(found?.priority).toBe(70);
    expect(found?.isActive).toBe(true);
  });
});
