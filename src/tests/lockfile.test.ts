// SW-1 Part A — lockfile floor unit + adversarial tests.
//
// Two tiers:
//   1. Unit tests against an in-memory fake LockfileFsOps (fast, deterministic,
//      exercises acquire/release/stale-takeover/live-refusal logic without
//      touching a real filesystem or spawning anything).
//   2. A REAL two-process adversarial test: spawns an actual child
//      `node` process that holds the lock on a scratch dir, and asserts the
//      parent's acquireLock() (real fs, real process.kill probe) throws the
//      specified LockHeldError; then kills the child -9 and asserts stale
//      takeover succeeds; then a clean release + immediate re-acquire.
//
// This file does not import ../db/connection.js, so it has none of the
// module-load-order env-mutation constraints it-runs.test.ts documents.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireLock,
  acquireLockWith,
  releaseLock,
  releaseLockWith,
  LockHeldError,
  LOCKFILE_NAME,
  type LockfileFsOps,
  type LockPayload,
} from "../db/lockfile.js";

// JSON.parse returns `any`; every lockfile payload read in this file is
// narrowed through this helper so callers get LockPayload's real shape
// instead of tripping @typescript-eslint/no-unsafe-* on ad hoc `any` use.
function parsePayloadForTest(raw: string): LockPayload {
  return JSON.parse(raw) as LockPayload;
}

// ---------------------------------------------------------------------------
// Fake fs — in-memory, deterministic, gives full control over "who's alive".
// ---------------------------------------------------------------------------

function makeFakeOps(overrides: Partial<LockfileFsOps> = {}): {
  ops: LockfileFsOps;
  files: Map<string, string>;
} {
  const files = new Map<string, string>();

  // These fake ops are in-memory (a plain Map), so none of them has a real
  // `await` to perform — but the LockfileFsOps interface is Promise-typed
  // (it must be, to fit the real fs-backed implementation), so each stays
  // `async` to satisfy that contract. `require-await` is disabled per-method
  // rather than restructured, since wrapping trivial sync logic in
  // `Promise.resolve()` just to appease the rule would be noise.
  const ops: LockfileFsOps = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async writeFileExclusive(filePath, contents) {
      if (files.has(filePath)) {
        const err = new Error("EEXIST: file already exists") as NodeJS.ErrnoException;
        err.code = "EEXIST";
        throw err;
      }
      files.set(filePath, contents);
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async writeFile(filePath, contents) {
      files.set(filePath, contents);
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async readFile(filePath) {
      const content = files.get(filePath);
      if (content === undefined) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return content;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async rename(oldPath, newPath) {
      const content = files.get(oldPath);
      if (content === undefined) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      files.delete(oldPath);
      files.set(newPath, content);
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async unlink(filePath) {
      if (!files.has(filePath)) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      files.delete(filePath);
    },
    async mkdir() {
      // No-op — the fake has no real directory tree to create.
    },
    isProcessAlive() {
      return false;
    },
    now() {
      return new Date("2026-07-04T00:00:00.000Z");
    },
    hostname() {
      return "test-host";
    },
    pid() {
      return 12345;
    },
    ...overrides,
  };

  return { ops, files };
}

describe("lockfile — unit (fake fs, injected liveness)", () => {
  it("acquires cleanly when no lockfile exists", async () => {
    const { ops, files } = makeFakeOps();
    await acquireLockWith("/scratch/proj", ops);
    const raw = files.get(path.join("/scratch/proj", LOCKFILE_NAME));
    expect(raw).toBeDefined();
    const payload = parsePayloadForTest(raw!);
    expect(payload.pid).toBe(12345);
    expect(payload.hostname).toBe("test-host");
    expect(payload.startedAt).toBe("2026-07-04T00:00:00.000Z");
  });

  it("refuses with LockHeldError when the holder pid is alive", async () => {
    const { ops, files } = makeFakeOps({ isProcessAlive: () => true });
    files.set(
      path.join("/scratch/proj", LOCKFILE_NAME),
      JSON.stringify({ pid: 999, startedAt: "2026-01-01T00:00:00.000Z", hostname: "other-host" }),
    );

    await expect(acquireLockWith("/scratch/proj", ops)).rejects.toThrow(LockHeldError);
    try {
      await acquireLockWith("/scratch/proj", ops);
      expect.unreachable("expected LockHeldError");
    } catch (err) {
      expect(err).toBeInstanceOf(LockHeldError);
      const lockErr = err as LockHeldError;
      expect(lockErr.holderPid).toBe(999);
      expect(lockErr.dataDir).toBe("/scratch/proj");
      // Message names holder pid + data dir + the manual override + the
      // IRANTI_DATA_DIR hint (PRD D1 / plan's "structured error" spec).
      expect(lockErr.message).toContain("999");
      expect(lockErr.message).toContain("/scratch/proj");
      expect(lockErr.message).toContain("delete the lockfile");
      expect(lockErr.message).toContain("IRANTI_DATA_DIR");
    }
  });

  it("takes over a stale lock (dead holder pid) via temp-file + rename", async () => {
    const { ops, files } = makeFakeOps({ isProcessAlive: () => false, pid: () => 42 });
    const target = path.join("/scratch/proj", LOCKFILE_NAME);
    files.set(
      target,
      JSON.stringify({ pid: 999, startedAt: "2026-01-01T00:00:00.000Z", hostname: "dead-host" }),
    );

    await acquireLockWith("/scratch/proj", ops);

    // No leftover temp file; the target now names the new holder.
    const remaining = [...files.keys()];
    expect(remaining).toEqual([target]);
    const payload = parsePayloadForTest(files.get(target)!);
    expect(payload.pid).toBe(42);
  });

  it("same-pid reacquire succeeds without a liveness probe (in-process restart idiom)", async () => {
    // A single pid cannot race itself. This is the exact pattern several
    // suites use (vi.resetModules() + re-import connection.ts, simulating a
    // "restart" without an intervening closeDb()/releaseLock — e.g.
    // src/tests/project-state.test.ts's cross-project + empty-project
    // tests): acquireLock must succeed here, not throw LockHeldError,
    // because the "holder" IS this process.
    const isProcessAliveCalls: number[] = [];
    const { ops, files } = makeFakeOps({
      pid: () => 99,
      isProcessAlive: (pid) => {
        isProcessAliveCalls.push(pid);
        return true; // Would refuse if the same-pid branch didn't short-circuit first.
      },
    });
    const target = path.join("/scratch/proj", LOCKFILE_NAME);
    files.set(
      target,
      JSON.stringify({ pid: 99, startedAt: "2026-01-01T00:00:00.000Z", hostname: "test-host" }),
    );

    await acquireLockWith("/scratch/proj", ops);

    const payload = parsePayloadForTest(files.get(target)!);
    expect(payload.pid).toBe(99);
    // Liveness wasn't even consulted — same-pid is decided before that check.
    expect(isProcessAliveCalls).toEqual([]);
  });

  it("treats a corrupt/unparseable lockfile as stale (best-effort takeover)", async () => {
    const { ops, files } = makeFakeOps({ pid: () => 7 });
    const target = path.join("/scratch/proj", LOCKFILE_NAME);
    files.set(target, "{not json");

    await acquireLockWith("/scratch/proj", ops);
    const payload = parsePayloadForTest(files.get(target)!);
    expect(payload.pid).toBe(7);
  });

  it("release is idempotent (missing lockfile is a silent no-op)", async () => {
    const { ops } = makeFakeOps();
    await expect(releaseLockWith("/scratch/proj", ops)).resolves.toBeUndefined();
  });

  it("release removes the lockfile so a subsequent acquire sees a clean slate", async () => {
    const { ops, files } = makeFakeOps();
    await acquireLockWith("/scratch/proj", ops);
    expect(files.size).toBe(1);
    await releaseLockWith("/scratch/proj", ops);
    expect(files.size).toBe(0);
  });

  it("EPERM on the liveness probe is treated as alive (conservative refusal)", async () => {
    // realFsOps' isProcessAlive already maps EPERM -> alive (see its
    // comment); this pins the same contract at the acquireLockWith level:
    // an isProcessAlive that reports "alive" for a foreign-but-existing pid
    // (which is what EPERM means in practice) must still refuse, not take
    // over.
    const { ops, files } = makeFakeOps({ isProcessAlive: () => true });
    const target = path.join("/scratch/proj", LOCKFILE_NAME);
    files.set(target, JSON.stringify({ pid: 1, startedAt: "x", hostname: "h" }));

    await expect(acquireLockWith("/scratch/proj", ops)).rejects.toThrow(LockHeldError);
  });
});

// ---------------------------------------------------------------------------
// Real two-process adversarial test.
// ---------------------------------------------------------------------------
//
// Spawns a real child `node` process that holds a REAL lock (via realFsOps)
// on a scratch dir and waits. The parent (this test, also using realFsOps)
// then exercises the actual cross-process contract: live refusal, kill -9 +
// stale takeover, and clean release + immediate re-acquire.

const holderScriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures-lockfile-holder.mjs",
);

function spawnHolder(dataDir: string): Promise<{ child: ReturnType<typeof spawn>; pid: number }> {
  return new Promise((resolve, reject) => {
    // Plain `node` — no shell, no loader. The fixture has zero relative TS
    // imports (see its header comment for why), so process.execPath can run
    // it directly and child.pid is the REAL process pid that holds the
    // lock — no shell/loader re-spawn to lose track of across the process
    // boundary this test exists to exercise.
    const child = spawn(process.execPath, [holderScriptPath, dataDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("holder child did not report ready within 10s"));
      }
    }, 10_000);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (!settled && chunk.toString().includes("LOCK_ACQUIRED")) {
        settled = true;
        clearTimeout(timeout);
        resolve({ child, pid: child.pid! });
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`holder child stderr before ready: ${chunk.toString()}`));
      }
    });
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`holder child exited early with code ${code}`));
      }
    });
  });
}

describe("lockfile — real two-process adversarial (child_process)", () => {
  const scratchDirs: string[] = [];

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    "parent throws LockHeldError while a real child process holds the lock, " +
      "takes over after the child is killed -9, and clean-close release allows immediate re-acquire",
    async () => {
      const dataDir = mkdtempSync(path.join(tmpdir(), `iranti-lockfile-adv-${randomUUID()}-`));
      scratchDirs.push(dataDir);

      const { child, pid: holderPid } = await spawnHolder(dataDir);

      try {
        // ---- Live refusal: parent's real acquireLock must throw, naming the
        // real child's pid. ----
        let caught: unknown;
        try {
          await acquireLock(dataDir);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(LockHeldError);
        const lockErr = caught as LockHeldError;
        expect(lockErr.holderPid).toBe(holderPid);
        expect(lockErr.dataDir).toBe(dataDir);
        expect(lockErr.message).toContain(String(holderPid));

        // Lockfile is untouched (first process unaffected — PRD acceptance).
        const lockFilePath = path.join(dataDir, LOCKFILE_NAME);
        expect(existsSync(lockFilePath)).toBe(true);
        const beforeKill = parsePayloadForTest(readFileSync(lockFilePath, "utf-8"));
        expect(beforeKill.pid).toBe(holderPid);

        // ---- Kill -9 the holder; next open must detect stale + take over. ----
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => child.on("exit", () => resolve()));

        // Give the OS a brief moment to fully reap the pid table entry on
        // platforms where it's not instantaneous.
        await new Promise((r) => setTimeout(r, 200));

        await acquireLock(dataDir); // Should NOT throw — stale takeover.
        const afterTakeover = parsePayloadForTest(readFileSync(lockFilePath, "utf-8"));
        expect(afterTakeover.pid).toBe(process.pid);

        // ---- Clean release then immediate re-acquire succeeds. ----
        await releaseLock(dataDir);
        expect(existsSync(lockFilePath)).toBe(false);
        await acquireLock(dataDir);
        const afterReacquire = parsePayloadForTest(readFileSync(lockFilePath, "utf-8"));
        expect(afterReacquire.pid).toBe(process.pid);

        await releaseLock(dataDir);
      } finally {
        if (!child.killed) child.kill("SIGKILL");
      }
    },
    20_000,
  );
});

// ---------------------------------------------------------------------------
// Wave-1 code review MAJOR: post-acquire boot failure must release the lock
// ---------------------------------------------------------------------------
//
// connection.ts acquires the lock, then opens PGlite + auto-migrates. If any
// of that throws, the catch wrapper must release the lock before the failure
// propagates — otherwise a supervisor that catches the throw without exiting
// holds a phantom "live" lock with no working DB behind it. Trigger: a data
// dir pre-seeded with a corrupt PG_VERSION, which makes PGlite's open fail
// AFTER acquireLock succeeded (the dir itself is valid and writable).
describe("lock release on post-acquire boot failure (review MAJOR)", () => {
  it(
    "a corrupt data dir fails the boot AND leaves no lockfile behind",
    async () => {
      const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const path = await import("node:path");
      const { vi } = await import("vitest");

      const dir = mkdtempSync(path.join(tmpdir(), "iranti-lockfail-"));
      try {
        // Corrupt store: PG_VERSION present but garbage -> PGlite open throws
        // after the lock is taken.
        writeFileSync(path.join(dir, "PG_VERSION"), "not-a-version\n");

        const prevEngine = process.env["IRANTI_DB_ENGINE"];
        const prevDir = process.env["IRANTI_DATA_DIR"];
        const prevDbUrl = process.env["DATABASE_URL"];
        process.env["IRANTI_DB_ENGINE"] = "pglite";
        process.env["IRANTI_DATA_DIR"] = dir;
        delete process.env["DATABASE_URL"];
        vi.resetModules();

        await expect(import("../db/connection.js")).rejects.toThrow();

        // The MAJOR's assertion: the failure path released the lock.
        expect(existsSync(path.join(dir, "iranti.lock"))).toBe(false);

        // Restore env + module graph for whatever runs after this file.
        if (prevEngine === undefined) delete process.env["IRANTI_DB_ENGINE"];
        else process.env["IRANTI_DB_ENGINE"] = prevEngine;
        if (prevDir === undefined) delete process.env["IRANTI_DATA_DIR"];
        else process.env["IRANTI_DATA_DIR"] = prevDir;
        if (prevDbUrl !== undefined) process.env["DATABASE_URL"] = prevDbUrl;
        vi.resetModules();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
