// Drizzle Kit configuration.
//
// Drizzle Kit is the companion CLI tool for Drizzle ORM. It reads this file
// to know where the schema lives, where to write migration files, and how to
// connect to the database.
//
// Commands (add these to package.json scripts):
//   pnpm db:generate   — generate a new migration file from schema changes
//   pnpm db:migrate    — apply pending migrations to the database
//   pnpm db:studio     — open Drizzle Studio (visual DB browser in the browser)

// Load .env before anything else. Drizzle Kit runs this config file via its
// own bundler and does not always pick up .env automatically on Windows.
// dotenv.config() is a no-op if DATABASE_URL is already set in the environment,
// so this is safe in CI/production where env vars come from the environment directly.
import { config as loadEnv } from "dotenv";
loadEnv();

import { defineConfig } from "drizzle-kit";

if (!process.env["DATABASE_URL"]) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
}

export default defineConfig({
  // Where the schema is defined. Drizzle Kit reads this to detect changes.
  schema: "./src/db/schema.ts",

  // Where generated migration SQL files are written.
  out: "./drizzle",

  dialect: "postgresql",

  dbCredentials: {
    url: process.env["DATABASE_URL"],
  },

  // Log every SQL statement Drizzle generates. Useful for learning.
  verbose: true,
});
