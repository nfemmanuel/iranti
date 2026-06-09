// Test worker setup.
//
// This file runs inside every vitest worker before the test file loads.
// It ensures DATABASE_URL is present in the worker's process.env before
// connection.ts is imported (which throws if DATABASE_URL is missing).
//
// dotenv.config() is idempotent — calling it a second time when the var
// is already set (inherited from the main process) is harmless.

import { config } from "dotenv";

config();
