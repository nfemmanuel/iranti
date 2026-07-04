// SW-1 Part A — the single-writer lockfile floor.
//
// PGlite has no inter-process lock: two processes opening the same data dir
// race the open + auto-migrate, a data-corruption class in the layer whose
// whole product is "trust me with your memory" (see PRD sw-1-single-writer.md
// §2). This module gives connection.ts an exclusive claim on a data dir
// BEFORE `new PGlite(dataDir)` runs, closing that race with an honest,
// actionable refusal instead of a silent shared open or a blind crash.
//
// Design (PRD §5):
//   D1 — refuse loudly, never queue. A live holder means the blocked process
//        throws a structured error naming the holder pid + the data dir +
//        the manual override, rather than waiting/retrying (an invisible
//        stall is indistinguishable from a hang — the RULE-2 lesson applied
//        to startup).
//   D2 — staleness = pid non-liveness (process.kill(pid, 0) probe), NOT
//        clock-based (laptop sleep breaks wall-clock staleness). Takeover
//        re-checks and claims atomically via temp-file + rename to close the
//        TOCTOU window between "read: dead" and "write: mine".
//
// Pure logic vs fs: every function here takes its fs/pid-prober as
// parameters (LockfileFsOps) so unit tests can inject fakes for staleness,
// TOCTOU, and error-shape assertions without touching a real filesystem.
// connection.ts calls the default-fs entry points (acquireLock/releaseLock)
// which wire in real node:fs + real process.kill.

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";

export const LOCKFILE_NAME = "iranti.lock";

export interface LockPayload {
  pid: number;
  startedAt: string; // ISO 8601
  hostname: string;
}

// The operations lockfile.ts needs from the filesystem + process table.
// Real callers use the `realFsOps` below; tests inject fakes.
export interface LockfileFsOps {
  // Atomic create-exclusive: must reject (throwing an Error with
  // code "EEXIST") if the path already exists, and must not observe/replace
  // an existing file — the same contract as node:fs's `wx` flag.
  writeFileExclusive(filePath: string, contents: string): Promise<void>;
  // Ordinary write, used only for the temp file in the takeover path (the
  // temp path is unique per attempt, so no exclusivity is needed there).
  writeFile(filePath: string, contents: string): Promise<void>;
  readFile(filePath: string): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  mkdir(dirPath: string): Promise<void>;
  // Liveness probe. Must behave like process.kill(pid, 0): resolve/return
  // normally if the process is alive (or exists but isn't ours to signal —
  // EPERM still means "alive"); throw ESRCH if the pid doesn't exist.
  isProcessAlive(pid: number): boolean;
  now(): Date;
  hostname(): string;
  pid(): number;
}

export const realFsOps: LockfileFsOps = {
  async writeFileExclusive(filePath, contents) {
    // 'wx' = O_CREAT | O_EXCL: atomically fails with EEXIST if the file is
    // already there. This is the create-exclusive primitive the PRD (D1)
    // requires and it is cross-platform (Windows' CreateFile with
    // CREATE_NEW backs this the same way ext4's O_EXCL does) — no
    // POSIX-only flock assumption (PRD "Windows-safe" goal).
    await fs.writeFile(filePath, contents, { flag: "wx" });
  },
  async writeFile(filePath, contents) {
    await fs.writeFile(filePath, contents);
  },
  async readFile(filePath) {
    return fs.readFile(filePath, "utf-8");
  },
  async rename(oldPath, newPath) {
    await fs.rename(oldPath, newPath);
  },
  async unlink(filePath) {
    await fs.unlink(filePath);
  },
  async mkdir(dirPath) {
    await fs.mkdir(dirPath, { recursive: true });
  },
  isProcessAlive(pid) {
    try {
      // Signal 0: no signal sent, just an existence/permission probe — the
      // standard Node idiom for pid liveness (PRD D2). ESRCH => no such
      // process => stale. EPERM => process exists but we lack permission to
      // signal it => still alive (a live holder we merely can't kill).
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      // EPERM (or anything else unexpected) => treat as alive: the
      // conservative direction is to refuse, not to silently take over a
      // process we couldn't actually confirm is dead.
      return true;
    }
  },
  now() {
    return new Date();
  },
  hostname() {
    return osHostname();
  },
  pid() {
    return process.pid;
  },
};

// Structured, actionable refusal — never a blind crash (PRD D1).
export class LockHeldError extends Error {
  readonly holderPid: number;
  readonly dataDir: string;

  constructor(holderPid: number, dataDir: string) {
    super(
      `iranti is already serving this project from pid ${holderPid} (data dir: ${dataDir}).\n` +
        `Close the other session, or if that process is gone but the lock ` +
        `wasn't released, delete the lockfile at ${path.join(dataDir, LOCKFILE_NAME)}.\n` +
        `To run a second, independent instance instead, set IRANTI_DATA_DIR to a different directory.`,
    );
    this.name = "LockHeldError";
    this.holderPid = holderPid;
    this.dataDir = dataDir;
  }
}

function lockPath(dataDir: string): string {
  return path.join(dataDir, LOCKFILE_NAME);
}

function parsePayload(raw: string): LockPayload | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>)["pid"] === "number" &&
      typeof (parsed as Record<string, unknown>)["startedAt"] === "string" &&
      typeof (parsed as Record<string, unknown>)["hostname"] === "string"
    ) {
      return parsed as LockPayload;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// Acquire the lock for `dataDir`, given a set of fs/pid operations.
//
// Returns once the lockfile is ours. Throws LockHeldError if a live holder
// refuses to yield (PRD D1). A corrupt/unparseable existing lockfile is
// treated the same as a stale one (best-effort takeover) rather than a hard
// failure — an unreadable lockfile is evidence the previous writer crashed
// mid-write, not evidence a live writer holds the lock.
export async function acquireLockWith(
  dataDir: string,
  ops: LockfileFsOps,
): Promise<void> {
  await ops.mkdir(dataDir);

  const payload: LockPayload = {
    pid: ops.pid(),
    startedAt: ops.now().toISOString(),
    hostname: ops.hostname(),
  };
  const serialized = JSON.stringify(payload);
  const target = lockPath(dataDir);

  try {
    await ops.writeFileExclusive(target, serialized);
    return; // No existing lockfile — clean acquire.
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  // A lockfile already exists. Read it and decide: ours already (same-pid
  // reacquire), stale (takeover), or live-foreign (refuse).
  const existing = await ops.readFile(target);
  const existingPayload = parsePayload(existing);

  const holderPid = existingPayload?.pid;

  // Same-pid reacquire is not a cross-process race — a single pid cannot
  // race itself, so there is no live holder to refuse. This matters for
  // in-process module-reset idioms used throughout this repo's test suite
  // (vi.resetModules() + re-import connection.ts, simulating a "restart"
  // without an intervening closeDb()) — those are same-process, same-pid,
  // and must succeed exactly as they did before the lockfile existed. A
  // REAL second process, even one that happened to share a recycled pid,
  // cannot present as this branch: that would require this exact process
  // to have already died and been replaced, which contradicts "we are
  // running this code right now".
  if (holderPid === ops.pid()) {
    await ops.writeFile(target, serialized);
    return;
  }

  const holderIsAlive = holderPid !== undefined && ops.isProcessAlive(holderPid);

  if (holderIsAlive && holderPid !== undefined) {
    throw new LockHeldError(holderPid, dataDir);
  }

  // Stale (dead pid, or an unparseable/corrupt lockfile) — take over via
  // temp-file + rename (PRD D2: closes the TOCTOU between the liveness probe
  // above and claiming the lock — a rename is atomic, unlike overwriting the
  // target path directly, so a second racing process either wins outright
  // or loses outright, never observes a half-written file).
  const tempPath = `${target}.${ops.pid()}.${randomUUID()}.tmp`;
  await ops.writeFile(tempPath, serialized);
  await ops.rename(tempPath, target);
}

// Release the lock for `dataDir`. Best-effort: if the lockfile is already
// gone (e.g. a previous release, or manual deletion per the LockHeldError
// hint), this is a silent no-op rather than a throw — matching the existing
// PGlite pool.end() shim's idempotent-close philosophy (connection.ts's
// `closed` guard) rather than re-solving double-release with a new pattern.
export async function releaseLockWith(
  dataDir: string,
  ops: LockfileFsOps,
): Promise<void> {
  try {
    await ops.unlink(lockPath(dataDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// Real-fs entry points — what connection.ts calls.
export async function acquireLock(dataDir: string): Promise<void> {
  return acquireLockWith(dataDir, realFsOps);
}

export async function releaseLock(dataDir: string): Promise<void> {
  return releaseLockWith(dataDir, realFsOps);
}
