# PRD: SW-1 — Single-Writer Safety (Lockfile Floor + Daemon/Proxy Design)

**Status:** proposed
**Phase:** SW-1 (trust/infrastructure) · **Date:** 2026-07-04 · **Author:** NF + Claude
**Related:** Layer 0 PRD D3 (one host = one process), connection.ts:102-107 disclosed no-lock note, overnight report follow-up ("cross-process dir lock"), Phase 2.5 HTTP transport (the reuse substrate), `cross_process_handling_investigation` memory fact. NF ruling 2026-07-04: pick best-fit and strategize the cons — lockfile floor now, daemon/proxy as the designed follow-up.

---

## 1. Summary

Two deliverables. (1) **Build now:** an exclusive lockfile on the PGlite data dir so a second process can never race the first — corruption risk closed with an honest, actionable refusal. (2) **Design now, build next wave:** leader-election + thin-proxy over the existing HTTP transport, so multiple agent windows share ONE writer process — which also loads future models (embedder) once per machine instead of once per window. The lockfile is the safety floor; the daemon is the real architecture, specified here with acceptance criteria so its build is a fill-in, not a redesign.

## 2. Problem & motivation

PGlite is single-connection with no inter-process lock: two windows on one project race open+auto-migrate — a data-corruption class, in the layer whose whole product is "trust me with your memory." Real users open multiple agent windows; "one process per project" is currently an honor-system assumption. The daemon half is motivated by CORE-16: without a shared process, every window pays its own embedder/model/cache.

## 3. Goals & non-goals

**Goals (Part A — lockfile, built this wave)**
- On PGlite open: acquire `iranti.lock` in the data dir via atomic create-exclusive (`wx`), containing `{pid, startedAt, hostname, port?}` JSON.
- Lock held → second process reads it, checks staleness (pid liveness probe; dead pid ⇒ stale ⇒ take over after atomic replace), and if genuinely live: **exits with an honest, specific error** naming the holder pid and the data dir — never a blind crash, never a silent shared open.
- Lock released on clean close (closeDb/pool.end) and survives crash correctly via the staleness path (no lockfile leak deadlock).
- Windows-safe (no POSIX-only flock assumptions; `wx` + pid-probe works cross-platform).

**Goals (Part B — daemon/proxy, DESIGN ONLY this wave)**
- Design recorded in §5 with acceptance criteria (§7-B) so the next wave builds without re-deciding.

**Non-goals**
- Multi-writer PGlite (impossible by engine design), file-range locking, or lock support on the server-Postgres path (Postgres handles its own concurrency).
- Building the daemon this wave (NF: floor first).
- Cross-MACHINE coordination (Phase 5 cloud's job).

## 4. Scope

**In (A):** `src/db/lockfile.ts` (acquire/release/staleness, pure + unit-testable with injected fs/pid-prober), connection.ts integration (acquire before PGlite open, release in the pool.end shim after settle+close), honest error type surfaced through MCP server startup failure, tests: exclusive acquire, stale takeover (dead pid), live refusal message content, clean-close release, crash-then-restart recovery. It-runs gate still 1/1.
**In (B, paper only):** §5 D3–D6 + §7-B.
**Out:** daemon code, idle-shutdown timers, port negotiation implementation.

## 5. Design decisions

- **D1 (A) — Refuse loudly, never queue.** A blocked second process exits with instructions ("iranti is already serving this project from pid N; close the other session or set IRANTI_DATA_DIR"), because silently queueing behind an unknown process is indistinguishable from a hang — the RULE-2 lesson applied to startup. Rejected: wait-and-retry loops (unbounded invisible stall).
- **D2 (A) — Staleness = pid non-liveness, atomically re-checked.** `process.kill(pid, 0)` probe; takeover writes a new lockfile via temp+rename to close the TOCTOU between probe and claim. Clock-based staleness rejected (laptop sleep breaks it).
- **D3 (B) — Leader election IS the lockfile.** The daemon design reuses Part A verbatim: the process that wins the lock becomes leader, binds the Phase-2.5 HTTP transport on an ephemeral localhost port, and RECORDS that port in the lockfile. Later processes read the port and downgrade to proxy mode instead of exiting — Part A's "refuse" branch becomes Part B's "proxy" branch, which is why A is a strict subset of B, not throwaway.
- **D4 (B) — Proxy = stdio→HTTP forwarding of the MCP protocol**, no tool-level reimplementation; auth via the existing static-bearer mechanism with a per-machine token file next to the lock.
- **D5 (B) — Leader lifecycle:** lazy start (first window elects), idle shutdown (no requests for N minutes ⇒ release lock + exit, next window re-elects), crash recovery via D2 staleness.
- **D6 (B) — One leader per DATA DIR, not per machine** — projects stay isolated processes unless/until a shared-daemon-per-machine PRD argues otherwise with measurements.

## 6. Schema / API changes

None to DB schema. New file artifact `iranti.lock` inside the data dir (not user-visible config). Startup failure surfaces as a structured error the host displays.

## 7. Acceptance criteria

**A (this wave):**
- [ ] Two processes, same data dir: second refuses with the specified message naming pid + dir; first unaffected (adversarial test using a child process, NOT two in-process opens).
- [ ] Kill -9 the holder → next open detects stale, takes over, boots clean.
- [ ] Clean close releases; immediate re-open by another process succeeds.
- [ ] it-runs 1/1, persistence suite green, teardown-race green (release ordered after settle+close), full suite no regressions; bench untouched (0.0pp, deterministic).
- [ ] Windows verified (this dev machine) + CI-linux path reasoned in tests (fs semantics identical for wx/rename).

**B (paper, this wave):** design section complete enough that next wave's builder needs zero new decisions: port-file format, token file, proxy transport mapping, idle timeout default, and takeover semantics all specified above/in build addendum.

## 8. Deltas from master PRD

None — hardens the local-first substrate; the daemon shape is the same architecture Phase 5's hosted mode assumes, built incrementally.

## 9. Risks & open questions

- pid-reuse race (dead holder's pid recycled by an unrelated process) makes staleness read "live" → false refusal. Rare, self-heals when that process exits; mitigation (start-time in lockfile compared against pid start time) is platform-fiddly — documented as accepted residual with the manual override (delete lockfile) named in the error message.
- Antivirus/file-sync tools (OneDrive!) touching data dirs can break atomic-rename assumptions — data dirs under synced folders are already a bad idea; add a docs warning, not code.
- Part B's idle-shutdown vs long-running background chains needs the RULE-2 settle discipline at daemon scope — flagged for the build PRD addendum.

## Changelog
- 2026-07-04 — proposed (NF: "do what you need" on process handling — floor now, daemon designed)
- 2026-07-04 — PRD review: ACCEPT, zero blockers (sole `new PGlite(` site confirmed; acquire slots before connection.ts:107, release inside the pool.end shim after settle). One nit adopted: the shim's existing `closed` idempotence guard (connection.ts:114-118) is the double-close infrastructure the lockfile release builds on — do not re-solve it.
