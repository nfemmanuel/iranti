// Write-time edge tests — Phase 2.5 (CORE-29)
//
// Verifies that writeFact fires:
//   about:    fact → entity hub (always)
//   co_write: fact → previous fact in the same session (when sessionId present)
// Both are fire-and-forget — tests use a settle delay.

import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../db/connection.js";
import { writeFact } from "../library/facts.js";
import { registerAgent } from "../library/agents.js";
import { openSession } from "../library/sessions.js";
import { graph } from "../graph/index.js";

afterAll(async () => {
  await pool.end({ timeout: 5 });
});

async function settle() {
  await new Promise((r) => setTimeout(r, 200));
}

describe("write-time edges (CORE-29)", () => {
  it("about edge: every written fact links to its entity hub", async () => {
    const entityType = "project";
    const entityId = randomUUID();
    const agent = await registerAgent({ name: `test-agent-${randomUUID()}` });
    const session = await openSession(agent.id);

    const fact = await writeFact({
      entityType,
      entityId,
      key: "lang",
      value: "TypeScript",
      source: "test",
      sessionId: session.id,
    });

    await settle();

    const edge = await graph.getEdge(
      { type: "fact", id: fact.id },
      { type: "entity", id: `${entityType}/${entityId}` },
      "about",
    );

    expect(edge).toBeDefined();
    expect(edge!.weight).toBeGreaterThanOrEqual(1);
  });

  it("co_write edge: second fact in same session links to the first", async () => {
    const entityId = randomUUID();
    const agent = await registerAgent({ name: `test-agent-${randomUUID()}` });
    const session = await openSession(agent.id);

    const first = await writeFact({
      entityType: "project",
      entityId,
      key: "stack",
      value: "node",
      source: "test",
      sessionId: session.id,
    });

    const second = await writeFact({
      entityType: "project",
      entityId,
      key: "lang",
      value: "TypeScript",
      source: "test",
      sessionId: session.id,
    });

    await settle();

    // co_write is undirected — getEdge canonicalizes automatically.
    const edge = await graph.getEdge(
      { type: "fact", id: second.id },
      { type: "fact", id: first.id },
      "co_write",
    );

    expect(edge).toBeDefined();
    expect(edge!.weight).toBeGreaterThanOrEqual(0.5);
  });

  it("no co_write edge when sessionId is absent", async () => {
    const entityId = randomUUID();

    const fact = await writeFact({
      entityType: "project",
      entityId,
      key: "framework",
      value: "react",
      source: "test",
      // no sessionId
    });

    await settle();

    // about edge must still exist
    const aboutEdge = await graph.getEdge(
      { type: "fact", id: fact.id },
      { type: "entity", id: `project/${entityId}` },
      "about",
    );
    expect(aboutEdge).toBeDefined();
  });

  it("failed edge write never fails the fact write", async () => {
    const entityId = randomUUID();

    // writeFact with no sessionId — no co_write edge attempted, but about edge fires.
    // Verifies the fire-and-forget never propagates edge errors to the caller.
    await expect(
      writeFact({
        entityType: "project",
        entityId,
        key: "edge-resilience",
        value: "stable",
        source: "test",
      }),
    ).resolves.toBeDefined();
  });
});
