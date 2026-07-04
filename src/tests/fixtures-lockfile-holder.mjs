// Fixture script for src/tests/lockfile.test.ts's real two-process
// adversarial test.
//
// Deliberately plain JS with ZERO relative imports of repo TS sources: plain
// `node` cannot resolve this repo's TS-source `.js`-suffixed relative
// specifiers (a known repo limitation — see it-runs.test.ts and
// harness.test.ts header comments, and db:migrate's `--experimental-strip-types`
// workaround, which only works because migrate.ts itself has no relative TS
// imports either). Rather than pull in a loader (tsx re-spawns internally,
// which defeats pid tracking across the exact process boundary this
// adversarial test needs to observe — confirmed while building this test),
// this fixture reimplements ONLY the acquire half of the real create-exclusive
// contract, using the exact same primitive (fs 'wx' flag) and the exact same
// JSON payload shape (LockPayload) as src/db/lockfile.ts's realFsOps/
// acquireLockWith. This is still a REAL second OS process racing a REAL
// filesystem for a REAL exclusive-create — the thing under test — just
// without importing the TS module directly.
//
// Usage: node fixtures-lockfile-holder.mjs <dataDir>
//
// Acquires the lock (retrying past races is not needed — the parent test
// spawns this BEFORE calling acquireLock itself), prints "LOCK_ACQUIRED" to
// stdout so the parent knows it's safe to proceed, then blocks until killed.
// SIGTERM exits cleanly 0 (house rule: process.exit(0) in spawned scripts);
// the adversarial test itself uses SIGKILL to simulate a real crash, which
// is exactly the scenario the stale-takeover path exists for.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const dataDir = process.argv[2];
if (!dataDir) {
  console.error("usage: node fixtures-lockfile-holder.mjs <dataDir>");
  process.exit(1);
}

await mkdir(dataDir, { recursive: true });

const payload = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  hostname: (await import("node:os")).hostname(),
};

// Same primitive as src/db/lockfile.ts's realFsOps.writeFileExclusive: 'wx'
// = O_CREAT | O_EXCL, atomic create-exclusive, cross-platform.
await writeFile(path.join(dataDir, "iranti.lock"), JSON.stringify(payload), { flag: "wx" });

console.log("LOCK_ACQUIRED");

process.on("SIGTERM", () => process.exit(0));

// Block forever (the parent test kills -9 this process directly). A bare
// `await new Promise(() => {})` registers no pending timer/handle, so
// recent Node (confirmed: v24) treats it as a dangling "unsettled top-level
// await" and FORCE-EXITS the process outright rather than actually
// blocking — silently defeating this whole fixture (the child would exit
// immediately, so the parent test's real-lock-holder scenario never
// existed). `setInterval` is a real libuv handle that keeps the event loop
// alive indefinitely, which is what "block until killed" actually requires.
setInterval(() => {}, 1 << 30);
