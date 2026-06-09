// Database connection singleton.
//
// This module creates and exports a single Drizzle database client that the
// rest of the codebase imports. Using a singleton means only one connection
// pool is created per process — re-importing this module from different files
// returns the same instance.
//
// The connection is lazy: it is not established until the first query runs.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const url = process.env["DATABASE_URL"];

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
const pool = postgres(url, { max: 10 });

// The Drizzle client. Pass the schema so Drizzle can infer relational types.
export const db = drizzle(pool, { schema });

// Export the raw pool in case a migration runner or test teardown needs it.
export { pool };
