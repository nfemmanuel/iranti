// Integration tests — sessions.ts

import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../db/connection.js";
import { registerAgent } from "../library/agents.js";
import {
  closeSession,
  getOpenSessions,
  getSession,
  openSession,
} from "../library/sessions.js";

afterAll(async () => {
  await pool.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------

describe("openSession", () => {
  it("creates a session linked to the given agent, with no endedAt", async () => {
    const agent = await registerAgent({ name: `agent-${randomUUID()}` });

    const session = await openSession(agent.id);

    expect(session.id).toBeDefined();
    expect(session.agentId).toBe(agent.id);
    expect(session.startedAt).toBeInstanceOf(Date);
    expect(session.endedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("closeSession", () => {
  it("sets endedAt on the session", async () => {
    const agent = await registerAgent({ name: `agent-${randomUUID()}` });
    const session = await openSession(agent.id);

    expect(session.endedAt).toBeNull();

    await closeSession(session.id);

    const closed = await getSession(session.id);
    expect(closed?.endedAt).toBeInstanceOf(Date);
    expect(closed?.endedAt).not.toBeNull();
  });

  it("is a no-op when called on an already-closed session", async () => {
    const agent = await registerAgent({ name: `agent-${randomUUID()}` });
    const session = await openSession(agent.id);

    await closeSession(session.id);
    // Second call should not throw
    await expect(closeSession(session.id)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("getSession", () => {
  it("returns the session by ID", async () => {
    const agent = await registerAgent({ name: `agent-${randomUUID()}` });
    const session = await openSession(agent.id);

    const found = await getSession(session.id);

    expect(found?.id).toBe(session.id);
    expect(found?.agentId).toBe(agent.id);
  });
});

// ---------------------------------------------------------------------------

describe("getOpenSessions", () => {
  it("returns only sessions that have not been closed", async () => {
    const agent = await registerAgent({ name: `agent-${randomUUID()}` });

    const s1 = await openSession(agent.id);
    const s2 = await openSession(agent.id);

    await closeSession(s1.id);

    const open = await getOpenSessions(agent.id);
    const openIds = open.map((s) => s.id);

    // s1 is closed — must not appear
    expect(openIds).not.toContain(s1.id);
    // s2 is still open — must appear
    expect(openIds).toContain(s2.id);
  });
});
