import { config as loadEnv } from "dotenv";
import { defineConfig } from "vitest/config";

// Load .env in the main process so DATABASE_URL is inherited by forked workers.
loadEnv();

export default defineConfig({
  test: {
    globals: true,
    environment: "node",

    // Each test file runs in its own child process (fork), giving full isolation.
    // This means each file gets its own DB connection pool instance, which is
    // closed cleanly at the end of the file via afterAll.
    pool: "forks",

    // Belt-and-suspenders: also load .env inside each worker in case the
    // fork does not inherit the parent's env (CI, unusual OS configs).
    setupFiles: ["./src/tests/setup.ts"],

    // DB queries can be slow — give them breathing room.
    testTimeout: 30_000,
    hookTimeout: 30_000,

    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**"],
      exclude: ["src/**/*.d.ts", "src/tests/**"],
    },
  },
});
