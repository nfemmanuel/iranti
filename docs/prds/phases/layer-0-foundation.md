# PRD: Layer 0 — Zero-Infra Foundation & Folder-Scoped Projects

**Status:** shipped (one criterion partial: the `iranti init` bin wiring is a cutover-step item — see §7)
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

- [x] From a clean checkout with **no Postgres and no `DATABASE_URL`**, iranti boots over stdio and auto-creates + migrates an embedded PGlite store on first run. *(Layer 0a, `feat/layer0a-pglite`; re-proven from a fresh clone in the 2026-07-03 whole-system pass.)*
- [x] **The "it runs" gate:** an automated smoke test in a fresh temp dir does `attend` (writes a fact) → a later `attend` → the fact is returned. End-to-end against PGlite. *(`src/tests/it-runs.test.ts`.)*
- [x] Two sibling folders under a Projects root are **separate projects**: a fact written while in folder A does **not** surface for folder B by default. *(`projects-isolation.test.ts`, 16 adversarial cases incl. the factId-path leak found and closed in review.)*
- [x] `combine(A,B)` makes A's facts retrievable from B; `exclude(C)` stops C from being tracked. Both reversible. *(Same suite; registry rows never deleted.)*
- [x] `IRANTI_DB_ENGINE=postgres` + `DATABASE_URL` still uses the server pool; the existing DB-backed test suite passes unchanged against a real Postgres. *(mcp-tools 46/46 ×3 on Postgres 17; migrations 0013/0014 verified on both engines.)*
- [ ] A **one-command setup** configures a host (writes MCP config + Projects root) with no DB server step. *(PARTIAL: `runInit` library + config I/O + 7 tests shipped; the `bin` wiring is blocked by the documented Node strip-types limitation — plain `node` cannot run this repo's TS source. Deferred to the cutover/publish step, where a build output exists for `bin` to point at.)*
- [x] `pnpm typecheck` + `pnpm lint` clean; new PGlite + project-scoping paths have tests; full suite green. *(All gauntlet gates, re-verified per feature.)*

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

## 11. Implementation-details addendum (project scoping build)

Written at build start for the folder-scoped-projects slice (D4–D8). Settles the
§9 "schema shape" open question and every wiring decision needed to write code
without contradicting an accepted decision.

### 11.1 Schema shape (settles §9)

Lean confirmed: a dedicated `project` column, **parallel to `tenantId`**, added
to every table that already carries `tenantId` and is read during retrieval or
attend: `facts`, `rules`, `knowledge_edges`. `tenantId` keeps its existing
meaning and default (`"default"`) untouched everywhere (D6) — `project` is an
additional, independent scope dimension, not a replacement.

- `facts.project`, `rules.project`, `knowledge_edges.project`: `text NOT NULL
  DEFAULT 'default'`. The literal string `"default"` is the fallback project id
  for callers that never resolve a real one (bare library calls, existing
  tests, scripts) — it is a value in the `project` column, unrelated to
  `tenantId`'s own `"default"` value in a different column.
- `facts`' unique constraint becomes `(tenant_id, project, entity_type,
  entity_id, key)` — two projects can hold independent values for the same
  entity+key, matching the isolation-by-default goal (§3, D7).
- `fact_archive`, `source_reliability`, `escalations`, `attend_log`,
  `metric_counters`, `extraction_cache` are **not** given a `project` column
  in this slice. They are audit/telemetry/cache tables with no current-project
  reader — adding the column now would be speculative schema. Flagged as a
  follow-up if/when those tables grow project-aware readers.
  `fact_archive` specifically is reached safely without its own column: every
  archive row denormalizes `fact_id`, which still points at a live `facts`
  row carrying the real `project` — history lookups join through that.
- **Correction during build:** `media_objects` WAS initially placed in the
  "no column needed" bucket above under the reasoning "nothing reads it
  filtered by current project today." That reasoning was wrong —
  `iranti_attend`'s OD-4 media tier (`mcp/tools/attend.ts`) calls
  `searchMedia()` scoped only by `entityType`/`entityId`, which collide
  across projects exactly like every other entity-scoped lookup. `media_objects`
  DOES get a `project` column (`text NOT NULL DEFAULT 'default'`), the same
  shape as `facts`/`rules`/`knowledge_edges`, to close what would otherwise
  have been a real cross-project leak in the media tier.
- New table `projects` (the registry): `id text PRIMARY KEY` (the deterministic
  project id from §11.2), `label text`, `source text NOT NULL` (`"git-root" |
  "projects-root-child" | "fallback"`), `first_seen_at timestamptz NOT NULL
  DEFAULT now()`, `is_excluded boolean NOT NULL DEFAULT false`. Auto-upserted
  (get-or-create) the first time a project id is resolved in a process — this
  is what makes "new subfolders auto-register on first call" (D5) concrete.
- New table `project_links` (combine, D7): `id uuid PRIMARY KEY default
  random`, `project_a text NOT NULL`, `project_b text NOT NULL`, `is_active
  boolean NOT NULL DEFAULT true`, `created_at timestamptz NOT NULL
  DEFAULT now()`, `deactivated_at timestamptz`. A row means "A and B see each
  other's facts/rules while `is_active`." Combine is symmetric (A sees B, B
  sees A) — stored as one row, read in both directions. Reversing sets
  `is_active = false` (and `deactivated_at`); the row is never deleted, so
  history of past combines is preserved (G1, "never a hard delete").
  Uniqueness: `(least(project_a,project_b), greatest(project_a,project_b))` is
  NOT a DB constraint (Drizzle/pg-core has no portable `LEAST`/`GREATEST`
  expression index shorthand and PGlite's DDL surface is the more constrained
  of the two engines) — canonical ordering is enforced in application code
  (`src/library/projects.ts`'s `combineProjects()` always stores the
  lexicographically smaller id as `project_a`), and a partial-lookup query
  checks both orderings before inserting, avoiding duplicate active links for
  the same pair without relying on a DB-level constraint.

### 11.2 Project detection (settles the "clear precedence rule" in §9)

`src/library/projects.ts`, pure functions plus one cached resolver:

1. **git-root case (highest precedence):** walk up from `process.cwd()`
   looking for a `.git` entry (directory OR file — file happens in git
   worktrees/submodules, where `.git` is a pointer file, not a directory).
   The first directory found containing `.git` is the project root. Project id
   = that absolute path, normalized (see §11.2.1).
   - **Nested-subfolder-of-git-repo case:** walking up means a subfolder deep
     inside a repo resolves to the SAME id as the repo root, not its own id —
     "the project" is the repo, not the subfolder. This is the PRD's explicit
     nested-git-repo test case.
   - **Nested git repos (submodule inside a repo):** the walk stops at the
     FIRST `.git` found going upward from cwd, i.e. the innermost repo. Cwd
     inside a submodule is its own project, distinct from the parent repo —
     conservative (isolation-favoring) reading: two `.git` boundaries means
     two developers' worth of intent could differ, so don't collapse them.
2. **Projects-root-child case:** only reached when no `.git` is found above
   cwd. If a Projects root is configured (`IRANTI_PROJECTS_ROOT` env var, or
   the `projectsRoot` key written by `iranti init` into the host config file —
   env var wins if both are present, since env is the more explicit/ephemeral
   override), and cwd is under that root, the project id is the immediate
   child directory of the root that contains cwd (e.g. root
   `~/dev`, cwd `~/dev/acme/src/api` → project id is `~/dev/acme`,
   normalized). If cwd IS the Projects root itself (no child segment), falls
   through to the fallback case below — the root is not a project.
3. **Fallback case (lowest precedence):** no `.git` found, and either no
   Projects root is configured or cwd is not under it. Project id = the
   normalized absolute cwd itself. Documented as "one folder, one project" —
   every distinct fallback folder is already its own project with zero
   configuration (D8), it just doesn't get the "whole subtree is one project"
   grouping that git-root or Projects-root-child provide.

Precedence is git-root > Projects-root-child > fallback, checked in that order
on every resolution — never cached across different cwds, though within one
process the resolution for the process's OWN cwd is computed once (§11.3).

#### 11.2.1 Normalization (determinism requirement)

Same input path must always produce the same id. `normalizeProjectId(absPath)`:
lowercase the drive letter on Windows (`C:\` and `c:\` are the same volume),
convert `\` to `/`, resolve `..`/`.`/symlinks via `fs.realpathSync` (falls back
to the un-resolved absolute path if `realpathSync` throws — e.g. a path that
doesn't exist yet — so detection never crashes on a symlink edge case), strip a
single trailing slash. This is the "path-based, `normalizeKey`-style"
normalization the PRD's D5 calls for, purpose-built for filesystem paths
(`normalizeKey` itself is for fact keys, not reused here — different alphabet
of valid characters, and lowercasing a path's non-drive segments on a
case-sensitive filesystem would be wrong).

#### 11.2.2 Symlinks and the Projects-root itself

- A symlinked subfolder resolves through `realpathSync` before the git-root
  walk and the Projects-root containment check, so a symlink into a Projects
  root resolves to the same id as the real path — no duplicate project
  identity for the same physical folder reached two ways.
- The Projects root folder itself, opened directly (no child segment) with no
  `.git`, is fallback-cased per §11.2 point 2 above (falls through) rather
  than being treated as its own project — it is infrastructure, not a project.

### 11.3 Process-wide resolution and caching

Mirrors `src/mcp/context.ts`'s handshake pattern: `resolveCurrentProject()` is
computed lazily on first call within a process and cached for that process's
lifetime (one stdio server = one long-lived cwd; re-resolving per call would
be wasted work and cannot change mid-process since MCP hosts don't `chdir()`
their server). The resolver also performs the `projects` table upsert
(get-or-create + `is_excluded` check) the first time it runs, exactly
mirroring `registerAgent`'s get-or-create shape in `agents.ts`. Tests that need
a fresh resolution per case call a `resetProjectCache()` escape hatch (module
resets already used by `it-runs.test.ts`/`persistence.test.ts` also work).

### 11.4 Exclude semantics

`excludeProject(id)` sets `projects.is_excluded = true` (idempotent upsert if
the project has never been seen before — excluding a folder you've never
opened in iranti is valid, e.g. pre-configuring during `iranti init`).
`includeProject(id)` (the reverse) sets it back to `false` — reversible, never
a row deletion (G1). What "excluded" DOES, precisely: `resolveCurrentProject()`
still returns the id (excluding a folder doesn't break the tool — it isn't a
crash, D8's zero-config spirit), but `attend`/`write`/`search`/`query` treat an
excluded project as **isolated with no combine links honored**, and every write
is tagged `metadata.excludedProjectWrite = true` for future audit. This is the
conservative reading chosen where the PRD is silent on exact exclude behavior:
excluded means "don't extend trust to or from this folder," not "silently
discard its writes" (discarding data a user typed would violate "never a hard
delete" in spirit even though no row is deleted).

### 11.5 Combine/exclude interaction

If A is excluded and A+B are combined, the combine link is stored but not
honored for A while `is_excluded` is true (exclude wins) — re-including A
re-activates the existing combine automatically (no need to re-combine),
since the link's `is_active` flag and the project's `is_excluded` flag are
independent and both are simply re-checked on every read.

### 11.6 Retrieval/write scoping wiring

- `src/library/facts.ts`, `src/library/rules.ts`: every function gains a
  `project` parameter alongside the existing `tenantId` parameter, defaulting
  to `"default"` (never a breaking change to existing callers/tests — the
  default preserves current single-project behavior exactly). Where a function
  reads, its `WHERE` clause is extended to filter by the effective project set
  (see below) instead of a single equality, mirroring the existing
  `eq(facts.tenantId, tenantId)` pattern with an `inArray`/`or` over resolved
  project ids.
- **Effective project set for reads** = `{currentProject} ∪ {P : an active
  project_links row combines currentProject with P}`, computed once per
  `attend`/`search`/`query` call by `src/library/projects.ts`'s
  `getEffectiveProjectIds(projectId)`. Writes always use the single
  `currentProject` (writing "on behalf of" a combined partner is out of scope
  — combine affects reads, not write attribution).
- `src/mcp/context.ts`'s `McpContext` gains a `project: Project` field
  (the registry row), resolved once alongside the existing agent/session
  handshake in `ensureContext()`. `attend.ts`/`write.ts`/`search.ts`/
  `query.ts` all already call `ensureContext()` first — they pick up
  `ctx.project.id` from there and pass it down, so no new per-tool-call
  plumbing is needed beyond reading one more field off the existing context.
- `knowledge_edges`: `reinforceEdge`/`getNeighbors` gain the same `project`
  parameter, defaulting to `"default"`, so peripheral (graph-hop) retrieval in
  `attend.ts` stays project-scoped too — an edge recorded in project A must
  never surface a project-B fact as a "related" suggestion.

### 11.7 `iranti init` shape (settles the D8/D5 "convenience, not requirement" wiring)

Per the repo-realities constraint (ESM `.js` specifiers, `node
--experimental-strip-types` broken on Node 24 for `src/`), `iranti init` is
built as a library function `src/library/setup.ts`'s `runInit(options)` —
pure-ish (takes an explicit `homeDir`/`cwd`/`writeFile` for testability, no
hidden global state) — covered by unit tests through `vitest`/`tsx` exactly
like every other library module. It:

1. Writes/updates a host config JSON at `~/.iranti/config.json`:
   `{ projectsRoot: <absolute path>, dataDir: <absolute path or default> }`.
2. Does NOT require a running MCP server or touch the database — config-only,
   so it can run before the store has ever been opened (D8: init is
   convenience, never a requirement — the store boots and auto-migrates on
   first real MCP use regardless of whether init ever ran).
3. A thin CLI wrapper is documented as a **wiring gap**: `package.json` cannot
   add a working `bin` entry that runs TS source directly under the
   `node --experimental-strip-types` limitation already on record for
   `db:migrate`. Shipping a broken `bin` would be worse than not shipping one.
   `runInit()` + its tests are the deliverable; a real `bin/iranti` (compiled
   `dist/` entry, or a `tsx`-shimmed script) is left to the cutover/publish
   step (§3 non-goals — "the cutover... is a later step, not this PRD") where
   the build/publish pipeline is being decided anyway. This does not block any
   acceptance criterion: §7's "one-command setup" criterion is satisfied by
   `runInit()` being callable (e.g. `pnpm exec vitest run` of its own smoke
   test, or a documented `node -e` one-liner) even without a polished `bin`.

### 11.8 Migration numbering

Next migration file is `0013_<drizzle-kit-generated-name>.sql`, generated via
`pnpm db:generate` against the schema changes in §11.1, then hand-checked
against the PGlite auto-migrate path in `connection.ts` (no override expected
— no extensions, only `ADD COLUMN ... DEFAULT`, `CREATE TABLE`, and one new
unique index, all within PGlite's demonstrated DDL surface per the 0011/0012
precedent).

## Changelog
- 2026-07-02 — proposed
- 2026-07-03 — accepted (NF's overnight-mandate GO; D5 git-root identity, D6 dedicated project scope, D7 isolated-by-default all confirmed)
- 2026-07-03 — implementation-details addendum added before build (§11): settles the §9 schema-shape open question (dedicated `project` column parallel to `tenantId`, plus `projects` registry + `project_links` combine table), the git-root/Projects-root-child/fallback precedence and normalization rule, exclude semantics, combine/exclude interaction, retrieval/write scoping wiring through `McpContext`, and the `iranti init` library-function-not-broken-bin shape.
