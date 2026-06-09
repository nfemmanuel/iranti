// Migration runner.
//
// Applies all pending Drizzle migrations from the drizzle/ directory.
// Run with: pnpm db:migrate
//
// This is intentionally a standalone script, not part of the main library.
// It runs once at deploy time and during local development setup.
//
// How Drizzle migration tracking works:
//   - Applied migrations are recorded in a `drizzle.__drizzle_migrations` table.
//   - On each run, Drizzle compares the drizzle/ directory to that table and
//     applies only the files that haven't been applied yet.
//   - Safe to run multiple times — already-applied migrations are skipped.

import { config as loadEnv } from "dotenv";

// Load .env before anything else so DATABASE_URL is available.
loadEnv();

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import path from "path";
import { fileURLToPath } from "url";

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("❌ DATABASE_URL is not set. Copy .env.example to .env first.");
  process.exit(1);
}

// __dirname equivalent for ESM modules.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Point to the drizzle/ directory at the project root.
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

console.log("🔗 Connecting to:", url.replace(/:([^:@]+)@/, ":***@"));
console.log("📂 Migrations folder:", migrationsFolder);

// max: 1 — migration runs are single-threaded. No need for a pool.
const connection = postgres(url, { max: 1 });
const db = drizzle(connection);

try {
  console.log("⏳ Applying migrations...");
  await migrate(db, { migrationsFolder });
  console.log("✅ Migrations applied successfully.");
} catch (err) {
  console.error("❌ Migration failed:", err);
  process.exit(1);
} finally {
  await connection.end();
}
