# PRD: Layer 0 — Zero-Infra Foundation & Folder-Scoped Projects

**Status:** accepted
**Phase:** Layer 0 (YC foundation track) · **Date:** 2026-07-02 · **Author:** NF + Claude
**Related:** OD-6 (embedded store), OD-2/OD-3 (local-default, cloud-later), `embedded_store_pglite_feasibility`, `repo_state_branches_verified`, `must_build_for_update_and_pitch`. Sibling: **Layer 0b — Minimal Measurement Harness** (separate PRD). Downstream: the cutover / npm publish (a later step, not this PRD).

---

## 1. Summary

Make the rebuilt iranti **run and install with zero infrastructure**, and give it the **folder-scoped project model** it needs to be set up once and just work across all of a developer's projects. Today the rebuild *cannot start* without a running Postgres server, a hand-copied `.env`, and a manual migrate — and it has no notion of "which project am I in." Layer 0 removes the server (embedded PGlite by default), adds a one-command setup, auto-detects each folder as its own project, and keeps memories separated per project unless the user explicitly combines or excludes them. This is the literal "before anything else is meaningful" foundation for the demo, the benchmark, and the update.

## 2. Problem & motivation

Two blockers sit under everything:

1. **It doesn't run out of the box.** `src/db/connection.ts` throws if `DATABASE_URL` is unset; the documented setup is copy `.env` → `docker compose up postgres` → `db:migrate` → configure the host with a DB URL. That is a demo-killing, adoption-killing wall, and it's ByteRover's "zero infrastructure" opening handed to a competitor. We have **never confirmed the rebuild boots and serves a real attend/write cycle end-to-end** because standing up that Postgres is friction even for us.
2. **It has no project scoping.** Memories are scoped only by whatever entity the host names (`entityHints`), with `tenantId` always `"default"`. There's no mapping from a working directory to a project, so a single install can't cleanly serve many projects without cross-contamination.

## 3. Goals & non-goals

**Goals**
- iranti boots over stdio with **no Postgres server and no `DATABASE_URL`**, auto-creating and migrating an embedded store on first run.
- **Prove it runs**: a smoke test does a real `attend → write → attend` cycle end-to-end against the embedded store.
- **One-time, root-level setup**: configure once at a `Projects` root; every subfolder is auto-detected as its own project.
- **Per-project isolation by default**, with explicit **combine** (share memory across projects) and **exclude** (opt a folder out).
- Keep the **server-Postgres path intact** for the future cloud/team tier (OD-3 architecture).

**Non-goals (explicitly out)**
- The measurement harness (→ Layer 0b PRD).
- The cutover / rename `iranti-core`→`iranti` / npm publish / drop `private` (→ ship step, later).
- pgvector on the embedded store (not bundled in PGlite 0.5.3; the community `pglite-vector` pkg is a later option — local retrieval stays lexical + graph for now).
- Cloud accounts, sync, multi-tenant identity (Phase 5).
- A control-plane / studio UI (separate track).

## 4. Scope

**In**
- Embedded **PGlite** as the default store, behind an engine switch at the connection seam.
- Auto-bootstrap + auto-migrate of the embedded store on first run (no manual `db:migrate`).
- A **project-detection** module: working directory → stable project id.
- A **project scope** on stored memory + retrieval filtering by current project.
- **combine / exclude** as explicit, stored, reversible operations (tools + CLI).
- A one-command **setup/init** (`bin`) that writes host config + sets the Projects root + store location.
- An end-to-end **smoke test** as the "it runs" gate.

**Out (deferred, with owner)**
- Measurement harness → Layer 0b. · Cutover/publish → ship step. · pgvector-embedded → later. · Cloud/sync → Phase 5. · Studio UI → control-plane track.

## 5. Design decisions & rationale

- **D1 — Embedded PGlite, not SQLite.** PGlite is *real Postgres compiled to WASM*, so the existing Drizzle schema, `jsonb`, recursive CTEs, and migrations run unchanged. SQLite would be a rewrite (different dialect, no `jsonb`/advisory-locks/pgvector). *Rejected:* SQLite, better-sqlite3.
- **D2 — Engine switch at `connection.ts`.** Default = embedded PGlite persisted to a data dir; `IRANTI_DB_ENGINE=postgres` + `DATABASE_URL` selects the server pool. One seam, both tiers; keeps the cloud/team path open (OD-3) without touching callers. The existing `pg` Pool path is preserved, not deleted.
- **D3 — Single-connection concurrency.** PGlite is single-connection/single-writer per process, which *matches* iranti's one-host = one-server model and makes `pg_advisory_xact_lock` a no-op locally (writes serialize naturally). Advisory locks re-engage on the server tier. *Documented, not a defect.*
- **D4 — One store, per-project scope — NOT one DB file per folder.** A single embedded store with a `project` scope dimension. Why: (a) "explicitly combine" requires cross-project links, which is trivial in one store and awkward across many files; (b) one place to inspect/back up. *Rejected:* a separate PGlite file per folder (breaks combine, multiplies bootstrap cost).
- **D5 — Project identity = the folder, derived deterministically.** Project id = the **git repo root** of the working directory if present, else the **immediate child of the configured Projects root**, normalized to a stable id (path-based, `normalizeKey`-style). Deterministic — fits the thesis. New subfolders auto-register on first call; no per-project setup.
- **D6 — `project` is a new first-class scope, not overloaded `tenantId`.** `tenantId` is reserved for the future cloud/org tenancy (OD-3); overloading it for per-folder projects would collide with that model. So add a dedicated `project` dimension. *Rejected:* reuse `tenantId` as the project key.
- **D7 — combine / exclude are explicit, stored, reversible data.** `combine(A,B)` writes a share link so retrieval spans both; `exclude(folder)` marks a folder untracked. Both inspectable, reversible, never a hard delete (G1). Default is *isolated* — sharing is opt-in, which is the safe default for a memory tool.
- **D8 — Zero-config default; config/init optional.** With no config, iranti uses a default store location and derives the project from the cwd's git root — it *just works*. The one-command init is the "set up once for the whole Projects folder" convenience that writes the host config + pins the Projects root + store path.

## 6. Schema / API changes

- **Store:** `src/db/connection.ts` gains the engine switch (PGlite default / server opt-in); add `@electric-sql/pglite` + `drizzle-orm/pglite`. Add an auto-migrate-on-first-run path (apply `drizzle/*.sql` to a fresh PGlite store).
- **Schema:** add a `project` scope to memory tables (a `project` column on `facts`, and wherever retrieval scopes) + a `project_links` table (combine) + a project registry/`excluded` flag (exclude). New migration(s). *(Open sub-decision in §9: exact column vs. join-table shape.)*
- **Project detection:** new module `src/library/projects.ts` (cwd → project id; git-root resolution; Projects-root config).
- **MCP:** `attend`/`write` resolve the current project from the server's working directory and scope retrieval/writes to it (unless combined). New tools: `iranti_project_combine`, `iranti_project_exclude`, `iranti_project_status`.
- **CLI / setup:** add a `bin` (`iranti`) with `init` (write host config, set Projects root + store dir) and the combine/exclude/status commands.
- **package.json:** add `bin`, add PGlite dep. *(Dropping `private` + the `iranti-core`→`iranti` rename belong to the cutover, not here.)*

## 7. Acceptance criteria

- [ ] From a clean checkout with **no Postgres and no `DATABASE_URL`**, iranti boots over stdio and auto-creates + migrates an embedded PGlite store on first run.
- [ ] **The "it runs" gate:** an automated smoke test in a fresh temp dir does `attend` (writes a fact) → a later `attend` → the fact is returned. End-to-end against PGlite.
- [ ] Two sibling folders under a Projects root are **separate projects**: a fact written while in folder A does **not** surface for folder B by default.
- [ ] `combine(A,B)` makes A's facts retrievable from B; `exclude(C)` stops C from being tracked. Both reversible.
- [ ] `IRANTI_DB_ENGINE=postgres` + `DATABASE_URL` still uses the server pool; the existing DB-backed test suite passes unchanged against a real Postgres.
- [ ] A **one-command setup** configures a host (writes MCP config + Projects root) with no DB server step.
- [ ] `pnpm typecheck` + `pnpm lint` clean; new PGlite + project-scoping paths have tests; full suite green.

## 8. Deltas from the master PRD

- **Storage:** master PRD assumes a Postgres server. Layer 0 makes the *local default* embedded (PGlite), server-optional — consistent with OD-2/OD-3 (local-first default, cloud/team later). No change to the determinism principle (same engine).
- **Retrieval:** local embedded tier is lexical + graph only (no pgvector until the community extension lands) — a temporary reduction vs. the (already-deferred, off-by-default) CORE-16 vector tier. No user-facing regression (vector was never on by default).

## 9. Risks & open questions

- **Scope-leak = a trust bug.** A fact leaking across projects would directly undermine "your memory is yours, per project." Must be tested adversarially (isolation tests are non-negotiable).
- **Project-detection edge cases:** nested git repos, monorepos with sub-packages, folders with no git, symlinks, the Projects-root itself. Need a clear precedence rule (git-root vs. Projects-root child) and a documented override.
- **Schema shape (sub-decision):** `project` as a plain column on `facts` vs. a `projects` table + FK vs. reusing entity scoping. Lean: dedicated `project` column + small `project_links`/registry tables. Settle at build start.
- **Single-connection under a busy host:** confirm PGlite single-writer is fine for one host's request rate (expected: yes).
- **Migration on existing rebuild data:** the rebuild has ~no real users, so adding the `project` scope can default existing rows to a single project. Low risk; still a migration to write carefully.
- **`pg_advisory_xact_lock` under PGlite:** verified to exist/no-op in the spike — re-verify on the correct branch.

## 10. Verification

- **Unit:** project-detection determinism (same cwd → same id; git-root vs. Projects-child precedence); engine-switch selection; combine/exclude logic.
- **Integration (against PGlite):** boot + auto-migrate; the attend→write→attend smoke cycle; A/B project isolation; combine makes cross-project retrieval work; exclude removes a folder.
- **Regression (against server Postgres):** existing suite green with `IRANTI_DB_ENGINE=postgres`.
- **Manual:** `iranti init` in a real Projects folder; open two subfolders in a host; confirm isolation + the zero-config boot.

## Changelog
- 2026-07-02 — proposed
- 2026-07-03 — accepted (NF's overnight-mandate GO; D5 git-root identity, D6 dedicated project scope, D7 isolated-by-default all confirmed)
