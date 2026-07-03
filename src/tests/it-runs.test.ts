// The "it runs" gate — Layer 0 acceptance criterion (§7, PRD layer-0-foundation.md).
//
// Proves iranti boots and serves a real attend -> write -> attend cycle with
// ZERO infrastructure: no Postgres server, no DATABASE_URL, nothing but a
// scratch directory on disk. This is the smoke test the PRD calls out by
// name ("the it-runs gate").
//
// Module-load-order care: src/db/connection.ts reads IRANTI_DB_ENGINE /
// IRANTI_DATA_DIR / DATABASE_URL at import time and opens (and, on the
// PGlite path, auto-migrates) the store as a side effect of that import.
// So env vars MUST be set before anything that transitively imports
// connection.ts is loaded — including this file's own top-level imports.
// That's why this test has no static imports of iranti internals: every
// such module is loaded via a dynamic import() inside the test, after env
// is set.
//
// This suite deliberately does NOT import ../db/connection.js directly (not
// even for teardown) so it exercises exactly what a fresh host process
// would: cold boot, migrate, attend, write, attend.
//
// LOAD-BEARING TEST-RUNNER ASSUMPTION: this file mutates process.env
// (deletes DATABASE_URL, sets IRANTI_DB_ENGINE/IRANTI_DATA_DIR). That is
// only safe because vitest runs with pool:"forks" — each test FILE gets its
// own process, so env mutations here cannot leak into other suites (and the
// dev machine's real DATABASE_URL, loaded by the config's dotenv step,
// cannot leak back in after we delete it). If the pool is ever switched to
// "threads" (shared process, shared env), this gate and the Postgres-path
// suites would silently corrupt each other's env — re-isolate env per test
// file before making that change. (Same applies to persistence.test.ts.)

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A fresh temp dir per run so this test never collides with a developer's
// real ~/.iranti/db or with other test workers.
const dataDir = mkdtempSync(path.join(tmpdir(), "iranti-it-runs-"));

beforeAll(() => {
  // Force the embedded PGlite path regardless of what the ambient
  // environment has (this repo's .env sets DATABASE_URL for the
  // Postgres-backed suites; IRANTI_DB_ENGINE=pglite overrides that — see
  // the usePostgres selection logic in src/db/connection.ts).
  process.env["IRANTI_DB_ENGINE"] = "pglite";
  process.env["IRANTI_DATA_DIR"] = dataDir;
  // Explicitly confirm the zero-infra premise: no DATABASE_URL required.
  delete process.env["DATABASE_URL"];
});

afterAll(async () => {
  // attend()'s post-response side effects (edge recording, attend-log,
  // metric counters) are fire-and-forget by design (see attend.ts) — they
  // are still settling in the background when this test's assertions
  // finish. A short grace period lets that chain complete before the pool
  // closes; without it, the chain's queries fail with a benign but noisy
  // "PGlite is closed" error logged after the test has already passed.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const { pool } = await import("../db/connection.js");
  await pool.end({ timeout: 5 });
  rmSync(dataDir, { recursive: true, force: true });
});

describe("it-runs gate (zero-infra, PGlite, end-to-end)", () => {
  it("boots with no DATABASE_URL and serves attend -> write -> attend", async () => {
    expect(process.env["DATABASE_URL"]).toBeUndefined();

    // Dynamic imports so connection.ts sees the env set above, not whatever
    // was in place when this file was first parsed.
    const { attend } = await import("../mcp/tools/attend.js");
    const { write } = await import("../mcp/tools/write.js");

    const entityId = `it-runs-${randomUUID()}`;
    const entityHints = [{ entityType: "project", entityId }];

    // 1. First attend: nothing written yet, should not error, should return
    //    a well-formed (empty-ish) response. Also exercises the write side
    //    via message artifact extraction (a URL in the message).
    const first = await attend({
      entityHints,
      message: "Setting up the repo, see https://example.com/it-runs-gate for context.",
      agentName: "it-runs-test",
    });
    expect(first.facts).toBeDefined();
    // The URL in the message should have been extracted and stored as a fact
    // on the primary entity — proving the WRITE side of attend works against
    // a freshly auto-migrated PGlite store.
    expect(
      first.facts.some((f) => f.value.includes("example.com/it-runs-gate")),
    ).toBe(true);

    // 2. Explicit write(): the tool a host calls when it learns something
    //    semantic attend's deterministic extractor can't capture.
    const factKey = "onboarding-note";
    const factValue = `zero-infra boot verified ${randomUUID()}`;
    const writeResult = await write({
      entityType: "project",
      entityId,
      key: factKey,
      value: factValue,
      agentName: "it-runs-test",
    });
    expect(writeResult.factId).toBeTruthy();
    expect(writeResult.isCheckpoint).toBe(false);

    // 3. Second attend: the written fact must come back in facts[].
    const second = await attend({
      entityHints,
      agentName: "it-runs-test",
    });
    const found = second.facts.find(
      (f) => f.key === factKey && f.value === factValue,
    );
    expect(found).toBeDefined();
    expect(found?.entity).toBe(`project/${entityId}`);
  });
});
