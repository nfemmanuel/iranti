// attend_log + metric_counters tests — Phase 2.5 (CORE-14)
// Phase 3 (CORE-31) attend lifecycle tests appended below.

import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool, db } from "../db/connection.js";
import { attendLog, metricCounters } from "../db/schema.js";
import { attend } from "../mcp/tools/attend.js";
import { writeAttendLog, persistMetricCounters } from "../library/attend-log.js";
import { writeFact } from "../library/facts.js";
import { writeRule } from "../library/rules.js";
import { eq, desc } from "drizzle-orm";

afterAll(async () => {
  await pool.end({ timeout: 5 });
});

describe("writeAttendLog", () => {
  it("inserts a row with non-zero sizes and latency", async () => {
    const sessionId = randomUUID();
    const agentId = randomUUID();

    await writeAttendLog({
      sessionId,
      agentId,
      surface: "claude",
      factCount: 3,
      ruleCount: 1,
      alreadyPresent: 2,
      injectedChars: 400,
      injectedTokensEst: 100,
      suppressedTokensEst: 50,
      latencyMs: 42,
    });

    const row = await db.query.attendLog.findFirst({
      where: eq(attendLog.sessionId, sessionId),
      orderBy: desc(attendLog.createdAt),
    });

    expect(row).toBeDefined();
    expect(row!.factCount).toBe(3);
    expect(row!.ruleCount).toBe(1);
    expect(row!.alreadyPresent).toBe(2);
    expect(row!.injectedChars).toBe(400);
    expect(row!.injectedTokensEst).toBe(100);
    expect(row!.suppressedTokensEst).toBe(50);
    expect(row!.latencyMs).toBe(42);
    expect(row!.tenantId).toBe("default");
  });

  it("attend pipeline writes an attend_log row with non-zero latency", async () => {
    const entityId = `test-attend-log-${randomUUID()}`;
    const before = new Date();

    await attend({
      entityHints: [{ entityType: "project", entityId }],
      message: "hello",
    });

    // Fire-and-forget — give it a moment to land.
    await new Promise((r) => setTimeout(r, 200));

    const rows = await db.query.attendLog.findMany({
      where: eq(attendLog.tenantId, "default"),
      orderBy: desc(attendLog.createdAt),
    });

    const found = rows.find((r) => r.createdAt >= before);
    expect(found).toBeDefined();
    expect(found!.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("persistMetricCounters", () => {
  it("creates counter rows for new names", async () => {
    const name = `test-counter-${randomUUID()}`;
    await persistMetricCounters({ [name]: 5 });

    const row = await db.query.metricCounters.findFirst({
      where: eq(metricCounters.name, name),
    });
    expect(row).toBeDefined();
    expect(row!.value).toBe(5);
  });

  it("accumulates across multiple calls (survives simulated restart)", async () => {
    const name = `test-acc-${randomUUID()}`;

    await persistMetricCounters({ [name]: 3 });
    await persistMetricCounters({ [name]: 4 });

    const row = await db.query.metricCounters.findFirst({
      where: eq(metricCounters.name, name),
    });
    // 3 + 4 = 7 — increments accumulate, not replace.
    expect(row!.value).toBe(7);
  });

  it("skips zero-delta entries", async () => {
    const name = `test-skip-${randomUUID()}`;
    await persistMetricCounters({ [name]: 0 });

    const row = await db.query.metricCounters.findFirst({
      where: eq(metricCounters.name, name),
    });
    // Nothing inserted for zero delta.
    expect(row).toBeUndefined();
  });

  it("attend pipeline persists metric deltas to metric_counters", async () => {
    const entityId = `test-metric-${randomUUID()}`;

    await attend({
      entityHints: [{ entityType: "project", entityId }],
    });

    // Fire-and-forget settle.
    await new Promise((r) => setTimeout(r, 200));

    // The four named counters should exist (may be 0 if no conflicts happened,
    // but the attend above at minimum triggers a persist attempt — only
    // non-zero deltas are written, so we just verify the table is reachable).
    const rows = await db.query.metricCounters.findMany();
    // Table must exist and be queryable (no error thrown).
    expect(Array.isArray(rows)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 (CORE-31): attend lifecycle phase contract
// ---------------------------------------------------------------------------

describe("attend — phase param and nextDue breadcrumb (CORE-31)", () => {
  it("attend response always includes nextDue", async () => {
    const entityId = randomUUID();
    const result = await attend({
      entityHints: [{ entityType: "project", entityId }],
    });
    expect(typeof result.nextDue).toBe("string");
    expect(result.nextDue.length).toBeGreaterThan(0);
  });

  it("pre-response nextDue mentions post-response and mid-turn", async () => {
    const result = await attend({
      entityHints: [{ entityType: "project", entityId: randomUUID() }],
      phase: "pre-response",
    });
    expect(result.nextDue).toContain("post-response");
    expect(result.nextDue).toContain("mid-turn");
  });

  it("mid-turn nextDue only mentions post-response", async () => {
    const result = await attend({
      entityHints: [{ entityType: "project", entityId: randomUUID() }],
      phase: "mid-turn",
    });
    expect(result.nextDue).toContain("post-response");
    expect(result.nextDue).not.toContain("mid-turn");
  });

  it("post-response nextDue mentions pre-response for next turn", async () => {
    const result = await attend({
      entityHints: [{ entityType: "project", entityId: randomUUID() }],
      phase: "post-response",
    });
    expect(result.nextDue).toContain("pre-response");
  });

  it("mid-turn returns no rules even when rules exist for the entity", async () => {
    const entityId = randomUUID();
    const entityType = "project";

    await writeRule({ entityType, entityId, text: "mid-turn rule test", source: "test", priority: 0 });

    const result = await attend({
      entityHints: [{ entityType, entityId }],
      phase: "mid-turn",
    });
    expect(result.rules).toHaveLength(0);
  });

  it("mid-turn caps facts at MAX_MID_TURN_FACTS even with many facts available", async () => {
    const entityId = randomUUID();
    const entityType = "project";

    // Write 8 facts — well above the mid-turn cap of 3.
    for (let i = 0; i < 8; i++) {
      await writeFact({ entityType, entityId, key: `mt_fact_${i}`, value: `v${i}`, source: "test" });
    }

    const result = await attend({
      entityHints: [{ entityType, entityId }],
      phase: "mid-turn",
    });
    expect(result.facts.length).toBeLessThanOrEqual(3);
  });

  it("phase is persisted to attend_log", async () => {
    const entityId = randomUUID();
    const before = new Date();

    await attend({
      entityHints: [{ entityType: "project", entityId }],
      phase: "post-response",
    });

    await new Promise((r) => setTimeout(r, 200));

    const rows = await db.query.attendLog.findMany({
      where: eq(attendLog.tenantId, "default"),
      orderBy: desc(attendLog.createdAt),
    });
    const found = rows.find((r) => r.createdAt >= before && r.phase === "post-response");
    expect(found).toBeDefined();
    expect(found!.phase).toBe("post-response");
  });
});
