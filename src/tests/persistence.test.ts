// Layer 0a stress regression — persistence across restarts (PGlite path).
//
// Simulates a process restart at the module level: boot a fresh embedded
// store, write a fact, close the store, reset the module graph, re-import
// (fresh PGlite instance on the SAME data dir), and assert the fact
// survived. Also proves auto-migrate is idempotent: the second boot runs
// the migration bookkeeping against an already-migrated store and must
// no-op rather than fail or re-apply.
//
// This is the "restart mid-operation / data survives close+reopen"
// guarantee from the Layer 0 PRD (§7), kept as a permanent test.

import { describe, expect, it, vi, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir: string;

afterAll(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

describe("persistence across restarts (embedded PGlite)", () => {
  it("a fact written before 'restart' is readable after a fresh boot on the same data dir", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "iranti-persist-"));
    process.env["IRANTI_DB_ENGINE"] = "pglite";
    process.env["IRANTI_DATA_DIR"] = dataDir;
    delete process.env["DATABASE_URL"];

    // ---- boot 1: fresh dir -> auto-migrate -> write ----
    const facts1 = await import("../library/facts.js");
    await facts1.writeFact({
      entityType: "project",
      entityId: "persist-check",
      key: "night:stress",
      value: "written-by-boot-1",
      source: "runtime",
    });
    const before = await facts1.readFact("project", "persist-check", "night:stress");
    expect(before?.value).toBe("written-by-boot-1");

    const conn1 = await import("../db/connection.js");
    await conn1.closeDb();

    // ---- "restart": reset the module graph so connection re-initializes ----
    vi.resetModules();

    // ---- boot 2: same dir -> auto-migrate must NO-OP -> read survives ----
    const facts2 = await import("../library/facts.js");
    const after = await facts2.readFact("project", "persist-check", "night:stress");
    expect(after?.value).toBe("written-by-boot-1");

    const conn2 = await import("../db/connection.js");
    await conn2.closeDb();
  }, 60_000);
});
