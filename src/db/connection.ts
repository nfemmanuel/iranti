// Database connection singleton.
//
// This module creates and exports a single Drizzle database client that the
// rest of the codebase imports. Using a singleton means only one connection
// pool is created per process — re-importing this module from different files
// returns the same instance.
//
// The connection is lazy in the postgres-js sense (postgres-js itself defers
// the first real socket connect until the first query runs). The embedded
// PGlite path below is opened eagerly at module load because PGlite has no
// separate "wait for first query" mode — opening it is what makes it exist —
// but that open is cheap (in-process WASM, no network) so this does not
// change the practical zero-infra story.
//
// --- Engine switch (Layer 0, D2) ----------------------------------------
//
// Two engines, one seam:
//
//   IRANTI_DB_ENGINE=postgres                 -> server-Postgres path (postgres-js)
//   IRANTI_DB_ENGINE unset + DATABASE_URL set -> same, for backward compat
//   otherwise (the zero-infra default)        -> embedded PGlite, file-persisted
//
// Both paths export the same `db` (a Drizzle instance built with the same
// schema) so every caller (library/, mcp/, tests) is engine-agnostic.
//
// --- pool / closeDb story -------------------------------------------------
//
// The codebase has ~20 call sites (mostly test `afterAll` hooks, plus
// mcp/server.ts's shutdown handler) that do `await pool.end({ timeout: 5 })`.
// postgres-js's pool.end() and PGlite's client.close() have different
// signatures (PGlite's close() takes no arguments and has no timeout
// option). Rather than touch every call site, `pool` is exported on BOTH
// engine paths as an object shaped like postgres-js's pool: it exposes an
// `end({ timeout })` method. On the postgres engine it *is* the real
// postgres-js pool (byte-identical behavior, unchanged). On the PGlite
// engine it's a thin wrapper whose `end()` calls `PGlite#close()` (the
// timeout option is accepted but not meaningful for an in-process WASM
// instance, so it's ignored there). This keeps every existing caller
// working unchanged on both engines. `closeDb()` is also exported as the
// engine-agnostic name for new code to prefer going forward.

import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { sql } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import { homedir } from "node:os";
import path from "node:path";
import { pendingBackgroundCount, settleBackground } from "../library/background.js";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import * as schema from "./schema.js";

// A pool-shaped handle so every existing `pool.end({ timeout })` call site
// works unchanged regardless of which engine is active.
export interface DbPool {
  end(options?: { timeout?: number }): Promise<void>;
}

let db: ReturnType<typeof drizzlePostgres<typeof schema>> | ReturnType<typeof drizzlePglite<typeof schema>>;
let pool: DbPool;

const engineEnv = process.env["IRANTI_DB_ENGINE"];
const url = process.env["DATABASE_URL"];

// postgres engine: explicit opt-in, or legacy behavior (DATABASE_URL set,
// IRANTI_DB_ENGINE unset) so existing setups keep working unchanged.
// `!engineEnv` (not `=== undefined`): an EMPTY-string IRANTI_DB_ENGINE (a
// common env-templating artifact) is treated the same as unset, so a
// configured DATABASE_URL is never silently discarded in favor of PGlite.
const usePostgres = engineEnv === "postgres" || (!engineEnv && !!url);

if (usePostgres) {
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set.\n" +
        "  1. Copy .env.example to .env\n" +
        "  2. Run `pnpm db:up` to start the local database\n" +
        "  3. Run `pnpm db:migrate` to apply the schema",
    );
  }

  // postgres-js connection pool.
  // max: 10 is the default. Adjust for production based on DB plan limits.
  const pgPool = postgres(url, { max: 10 });

  // The Drizzle client. Pass the schema so Drizzle can infer relational types.
  db = drizzlePostgres(pgPool, { schema });
  pool = pgPool;
} else {
  // Embedded PGlite — the zero-infra default (Layer 0, D1/D2/D8).
  //
  // Persisted at IRANTI_DATA_DIR if set, else ~/.iranti/db. PGlite creates
  // the data directory itself if it doesn't exist, so no manual mkdir is
  // needed here — but resolve to an absolute path first since PGlite (and
  // Windows) are happiest with one.
  const dataDir = path.resolve(
    process.env["IRANTI_DATA_DIR"] ?? path.join(homedir(), ".iranti", "db"),
  );

  // NOTE (known limitation, reviewed + accepted as follow-up): there is no
  // inter-process lock on the data dir. Two processes pointed at the same
  // IRANTI_DATA_DIR would race the open + migrate. The deployment model is
  // one host = one server process (PRD D3), so this is out of scope for
  // Layer 0a; a lockfile is tracked as a follow-up in the overnight report.
  const client = new PGlite(dataDir);
  db = drizzlePglite(client, { schema });
  // Idempotent close: PGlite's close() THROWS on a second call (unlike
  // postgres-js's pool.end(), which is safely re-entrant). Signal handlers
  // can double-fire (SIGINT then SIGTERM), so guard here rather than in
  // every caller — this makes the pool shim's "double-close is safe on both
  // engines" contract actually true.
  let closed = false;
  pool = {
    async end() {
      if (closed) return;
      closed = true;
      // RULE-2 root fix: settle detached fire-and-forget chains (attend's
      // post-response chain, writeFact's post-commit side effects, the
      // extraction-cache writes) BEFORE closing the single connection.
      // Closing mid-query leaves that query's promise pending FOREVER
      // (PGlite neither resolves nor rejects it) — a real host shutting
      // down right after a turn hung exactly here. Bounded: after 5s we
      // close anyway (a bounded wait beats both an unbounded hang and a
      // blind close). This shim is the ONLY settle point on the PGlite
      // path — closeDb() deliberately does not settle again (review
      // finding: double-settling made a genuinely-stuck chain cost ~10s
      // against the documented 5s bound).
      if (!(await settleBackground(5000))) {
        console.error(
          `[iranti] teardown: ${pendingBackgroundCount()} background chain(s) did not settle within 5s; closing anyway`,
        );
      }
      await client.close();
    },
  };

  // Auto-migrate on first boot (and every boot thereafter — idempotent).
  //
  // A fresh data dir has no tables; this applies every migration in
  // drizzle/ in order and records them in the same `drizzle.__drizzle_migrations`
  // tracking table the postgres-js migrator uses (same schema, same hash/
  // timestamp bookkeeping — see drizzle-orm/pg-core/dialect.js's `migrate()`,
  // which this mirrors), so the two engines converge on the same schema
  // wherever PGlite can run the SQL at all. On a data dir that's already
  // current, this is a fast no-op.
  //
  // This runs at module load (top-level await — fine under ESM/Node 22),
  // so by the time any caller's first query fires, the schema exists. The
  // server-Postgres path is intentionally NOT auto-migrated: `pnpm db:migrate`
  // stays the explicit ritual there, per the PRD.
  //
  // --- Known gap: migration 0010 (CORE-16 pgvector) is adapted on PGlite ---
  //
  // Migration 0010_gray_dark_phoenix.sql does three things to `facts`:
  //   1. CREATE EXTENSION IF NOT EXISTS vector
  //   2. ALTER TABLE facts ADD COLUMN embedding vector(768)
  //   3. CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)
  //
  // PGlite 0.5.3 does not bundle the `vector` extension (confirmed: it ships
  // contrib extensions like pg_trgm/hstore/etc. but not vector; the
  // community `pglite-vector` package would add it and is intentionally not
  // a dependency here — see PRD layer-0-foundation.md §3 non-goals). So (1)
  // fails outright, and by extension (2)'s `vector(768)` type and (3)'s
  // `vector_cosine_ops` operator class don't exist either.
  //
  // But the `embedding` column can't simply be dropped from the PGlite
  // schema: `facts` is one shared Drizzle `pgTable` used by both engines
  // (src/db/schema.ts), so every query built against it — on either engine
  // — selects an `embedding` column. Omitting the column on PGlite would
  // turn every `SELECT` into a runtime 42703 ("column does not exist").
  //
  // The resolution: `embedding` is a pre-existing, config-gated, currently
  // -dead column — null until IRANTI_EMBEDDINGS=true, which nothing in the
  // codebase sets or reads (grep confirms schema.ts is the only reference).
  // Nothing ever writes or reads a real vector through it today. So on
  // PGlite we substitute statement (2) with the same ALTER TABLE but typed
  // `text` instead of `vector(768)` — same column name, same NULL default,
  // satisfies the shared schema's column list — and skip (1) and (3)
  // entirely (no extension to create, no vector index to build on a text
  // column). This is the documented delta from the PRD (§8: "local embedded
  // tier is lexical + graph only... no user-facing regression, vector was
  // never on by default"). If IRANTI_EMBEDDINGS is ever wired up for real,
  // this substitution — and the embedded tier's vector support generally —
  // needs revisiting (tracked as a follow-up, not solved here).
  //
  // We do NOT rewrite the migration file itself (it's shared with the
  // Postgres path, which must keep applying it unchanged) — the
  // substitution below is keyed by migration tag, applied only in this
  // PGlite runner, in memory.
  const PGLITE_MIGRATION_OVERRIDES: Record<string, string[]> = {
    "0010_gray_dark_phoenix": [
      `ALTER TABLE "facts" ADD COLUMN "embedding" text`,
    ],
  };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = path.resolve(__dirname, "../../drizzle");

  const journal = JSON.parse(
    readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf-8"),
  ) as { entries: Array<{ tag: string }> };
  const migrations = readMigrationFiles({ migrationsFolder });

  const migrationsSchema = "drizzle";
  const migrationsTable = "__drizzle_migrations";

  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(migrationsSchema)}`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
  // db.execute()'s return shape differs by engine (postgres-js resolves an
  // array-like RowList; PGlite resolves a Results object with a `.rows`
  // array) — same reasoning as rowsOf() in src/graph/index.ts. Normalize here.
  // Record<string, unknown> satisfies db.execute<T>()'s generic constraint;
  // the created_at field is narrowed via Number(...) below regardless of
  // its exact runtime type (string or number depending on engine/driver).
  interface MigrationTrackingRow extends Record<string, unknown> {
    created_at: string | number;
  }
  const lastRowsResult = await db.execute<MigrationTrackingRow>(sql`
    SELECT created_at FROM ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)}
    ORDER BY created_at DESC LIMIT 1
  `);
  const lastRows: MigrationTrackingRow[] = Array.isArray(lastRowsResult)
    ? lastRowsResult
    : (lastRowsResult as { rows: MigrationTrackingRow[] }).rows;
  const lastRow = lastRows[0];
  const lastMillis = lastRow ? Number(lastRow.created_at) : undefined;

  // Apply ALL pending migrations inside ONE transaction, exactly like
  // drizzle's real migrate() does (drizzle-orm/pg-core/dialect.js wraps the
  // whole pending set in session.transaction). Postgres DDL is
  // transactional, so a crash between any two statements — or between a
  // migration's SQL and its bookkeeping INSERT — rolls back atomically on
  // next boot instead of leaving a half-applied migration that re-fails
  // forever ("column already exists") and bricks the zero-infra data dir.
  const pending = migrations
    .map((migration, i) => ({ migration, tag: journal.entries[i]?.tag }))
    .filter(({ migration }) => lastMillis === undefined || lastMillis < migration.folderMillis);

  if (pending.length > 0) {
    await client.exec("BEGIN");
    try {
      for (const { migration, tag } of pending) {
        const override = tag !== undefined ? PGLITE_MIGRATION_OVERRIDES[tag] : undefined;
        if (override) {
          console.error(
            `iranti: applying PGlite-adapted statements for migration ${tag} (pgvector not bundled — see connection.ts comment)`,
          );
        }
        const statements = override ?? migration.sql;
        for (const stmt of statements) {
          if (stmt.trim().length === 0) continue;
          // Use the raw PGlite client's exec() (simple query protocol), not
          // db.execute() (extended/prepared protocol via drizzle's session).
          // Several migrations contain multiple SQL commands within one
          // statement-breakpoint chunk (e.g. two CREATE FUNCTION bodies in
          // 0011_ax1_key_normalization.sql) — PGlite's prepared-statement path
          // rejects "multiple commands into a prepared statement", but exec()
          // handles multi-command text the same way `psql` would. exec()
          // participates in the surrounding explicit transaction.
          await client.exec(stmt);
        }
        await db.execute(sql`
          INSERT INTO ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)} ("hash", "created_at")
          VALUES (${migration.hash}, ${migration.folderMillis})
        `);
      }
      await client.exec("COMMIT");
    } catch (err) {
      // Roll back the whole pending set so the store stays at its previous
      // consistent state; rethrow so boot fails loudly rather than half-migrated.
      await client.exec("ROLLBACK").catch(() => {});
      throw err;
    }
  }
}

export { db, pool };

// Engine-agnostic alias for new code. Existing `pool.end({ timeout })` call
// sites are left as-is (see module comment above) — this is just the
// preferred name going forward.
export async function closeDb(): Promise<void> {
  // Engine-aware single settle (review finding: settling here AND in the
  // PGlite end shim doubled the worst-case stuck-chain wait to ~10s):
  // - PGlite: the pool.end shim settles — nothing to do here.
  // - postgres: the raw postgres-js pool has no shim, so drain here.
  //   postgres-js survives in-flight teardown, but draining removes the
  //   benign-yet-noisy CONNECTION_ENDED stderr spam from chains losing
  //   the race (RULE-2). Direct pool.end() callers on the postgres path
  //   skip this drain — acceptable: no hang risk on a pooled engine.
  if (usePostgres) {
    if (!(await settleBackground(5000))) {
      console.error(
        `[iranti] teardown: ${pendingBackgroundCount()} background chain(s) did not settle within 5s; closing anyway`,
      );
    }
  }
  await pool.end({ timeout: 5 });
}
