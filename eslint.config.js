import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Honor the `_`-prefix convention for intentionally-unused bindings
      // (e.g. interface params a no-op impl must accept but ignores).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // A standalone plain-JS fixture spawned as a real `node` child process by
    // src/tests/lockfile.test.ts (SW-1's two-process adversarial test) —
    // deliberately outside the typed project (see its header comment: it
    // must have zero relative TS imports so plain `node` can run it with no
    // loader), so it isn't part of tsconfig's `include` and typescript-eslint's
    // projectService correctly has no project for it.
    ignores: [
      "dist/",
      "coverage/",
      "*.config.js",
      "*.config.ts",
      "src/tests/fixtures-lockfile-holder.mjs",
    ],
  },
);
