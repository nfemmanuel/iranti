// Integration tests — agents.ts
//
// These tests hit the live database on localhost:5435.
// Each test uses a randomUUID()-based name so it never collides with seed
// data or other tests running in parallel.

import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../db/connection.js";
import {
  getAgentById,
  getAgentByName,
  registerAgent,
} from "../library/agents.js";

// Close this worker's connection pool after all tests in this file complete.
afterAll(async () => {
  await pool.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------

describe("registerAgent", () => {
  it("creates a new agent and returns it", async () => {
    const name = `test-agent-${randomUUID()}`;

    const agent = await registerAgent({ name, description: "integration test" });

    expect(agent.id).toBeDefined();
    expect(agent.name).toBe(name);
    expect(agent.description).toBe("integration test");
    expect(agent.registeredAt).toBeInstanceOf(Date);
  });

  it("is idempotent — returns the same record on a second call with the same name", async () => {
    const name = `test-agent-${randomUUID()}`;

    const a1 = await registerAgent({ name });
    const a2 = await registerAgent({ name });

    expect(a1.id).toBe(a2.id);
  });
});

// ---------------------------------------------------------------------------

describe("getAgentById", () => {
  it("returns the agent when it exists", async () => {
    const name = `test-agent-${randomUUID()}`;
    const created = await registerAgent({ name });

    const found = await getAgentById(created.id);

    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
    expect(found?.name).toBe(name);
  });

  it("returns undefined for an ID that does not exist", async () => {
    const result = await getAgentById("00000000-0000-0000-0000-000000000000");

    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("getAgentByName", () => {
  it("returns the agent when it exists", async () => {
    const name = `test-agent-${randomUUID()}`;
    await registerAgent({ name });

    const found = await getAgentByName(name);

    expect(found).toBeDefined();
    expect(found?.name).toBe(name);
  });

  it("returns undefined for a name that does not exist", async () => {
    const result = await getAgentByName("__no-such-agent-xyzzy__");

    expect(result).toBeUndefined();
  });
});
