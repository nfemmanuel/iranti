// RULE-2 regression — teardown vs fire-and-forget chains.
//
// Before the fix: attend() fires a detached post-response chain (edge
// recording → extraction → attend-log → metrics); calling closeDb()
// immediately afterwards tore down PGlite's single connection while a
// chain query was in flight, leaving that promise pending FOREVER — the
// process hung, not merely a noisy error (reproduced during the Layer 0d
// host-simulation build; every test that touched this papered over it with
// 300ms sleeps).
//
// After the fix: every detached chain registers in background.ts's
// registry, and closeDb()/pool.end() settle the registry (bounded 5s)
// before touching the connection. This test is the sleepless version of
// the pattern every other suite still cushions: attend → IMMEDIATE close.
// If the fix regresses, this test times out rather than passing noisily.
//
// Env-mutation + module-load-order rules: same as it-runs.test.ts (safe
// only under pool:"forks"; dynamic imports only).

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "iranti-teardown-race-"));

beforeAll(() => {
  process.env["IRANTI_DB_ENGINE"] = "pglite";
  process.env["IRANTI_DATA_DIR"] = dataDir;
  delete process.env["DATABASE_URL"];
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("teardown vs fire-and-forget chains (RULE-2)", () => {
  it("closeDb() immediately after attend() settles the detached chain and never hangs", async () => {
    const { attend } = await import("../mcp/tools/attend.js");
    const { closeDb } = await import("../db/connection.js");
    const { pendingBackgroundCount } = await import("../library/background.js");

    const entityId = `teardown-${randomUUID()}`;

    // A message that exercises the write side of the detached chain (URL
    // artifact extraction → writeFact → its own tracked side effects).
    await attend({
      entityHints: [{ entityType: "project", entityId }],
      message:
        "Decision: we're using https://example.com/teardown-race for the runbook.",
      agentName: "teardown-race-test",
      phase: "pre-response",
    });

    // NO sleep — this is the whole point. closeDb must drain the registry
    // itself and resolve; pre-fix this wedged the process forever (the
    // vitest 30s per-test timeout is the failure detector).
    await closeDb();

    // The registry drained rather than being abandoned.
    expect(pendingBackgroundCount()).toBe(0);

    // Double-close stays safe (idempotent shim contract).
    await closeDb();
  });
});
