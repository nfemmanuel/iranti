#!/usr/bin/env node
// AX-10 — corpus gold-hash lint.
//
// bench/corpus/*.json golds whose key matches `<prefix>:<12-hex>` (prefix is
// `referenced_file` or `shared_url`, hyphen or underscore form) are supposed
// to carry sha256(value).slice(0, 12) as their key suffix — the SAME
// contentHash computation src/mcp/extractor.ts uses. Three corpus golds have
// now silently carried a hand-typed WRONG hash (two labeled placeholders
// caught by review, one unlabeled twin found during a recall-plateau
// investigation) — each one silently misreported recall. This lint
// recomputes every such hash from the gold's own `value` field (the raw
// string, verbatim — no path normalization, matching extractor.ts exactly)
// and fails loudly naming the file, the gold key found, and the expected key
// on any mismatch.
//
// Plain Node, no build step, no dependencies — runs as a preflight before
// `pnpm bench` (see package.json "bench" script) so the bench structurally
// cannot run against a lying corpus.
//
// Usage:
//   node scripts/lint-corpus.mjs             # lint bench/corpus/*.json
//   node scripts/lint-corpus.mjs --self-test  # run against an inline bad
//                                              # fixture; expects the lint to
//                                              # correctly detect failure
//                                              # (exits 0 if detection worked,
//                                              # 1 if the lint failed to
//                                              # catch the bad fixture)

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.resolve(__dirname, "../bench/corpus");

// Prefixes whose gold key suffix is a content hash of the gold's own `value`
// field. Hyphen or underscore form (both appear in the wild in this repo's
// history) — the lint should not silently skip a variant spelling.
const HASH_PREFIXES = ["referenced_file", "shared_url"];

// Matches `<prefix>:<12-hex>` where prefix is one of HASH_PREFIXES (hyphen or
// underscore internally, e.g. "referenced_file" or "referenced-file").
function buildKeyPattern() {
  const alternation = HASH_PREFIXES.map((p) => p.replace(/[_-]/g, "[_-]")).join("|");
  return new RegExp(`^(${alternation}):([0-9a-f]{12})$`);
}

const KEY_PATTERN = buildKeyPattern();

function contentHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

// Lint a single parsed corpus object's goldFacts array. Returns a list of
// failure records ({ file, key, expectedKey }); empty means the file is clean.
function lintCorpusGolds(corpus, file) {
  const failures = [];
  const goldFacts = Array.isArray(corpus.goldFacts) ? corpus.goldFacts : [];
  for (const gold of goldFacts) {
    if (typeof gold?.key !== "string" || typeof gold?.value !== "string") continue;
    const m = gold.key.match(KEY_PATTERN);
    if (!m) continue; // not a hash-keyed gold — out of lint scope
    const [, prefix, foundHash] = m;
    const expectedHash = contentHash(gold.value);
    if (foundHash !== expectedHash) {
      failures.push({
        file,
        key: gold.key,
        expectedKey: `${prefix}:${expectedHash}`,
      });
    }
  }
  return failures;
}

function lintDirectory(dir) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const allFailures = [];
  for (const file of files) {
    const full = path.join(dir, file);
    const parsed = JSON.parse(readFileSync(full, "utf-8"));
    allFailures.push(...lintCorpusGolds(parsed, file));
  }
  return allFailures;
}

function printFailures(failures) {
  console.error(`lint-corpus: FAILED — ${failures.length} gold hash mismatch(es):`);
  for (const f of failures) {
    console.error(
      `  ${f.file}: gold key "${f.key}" does not match its own value's content hash. Expected key: "${f.expectedKey}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// Self-test: run the lint logic against an inline bad fixture (a gold whose
// hash is deliberately wrong) and confirm the lint DETECTS the failure.
// Exit 0 means detection worked (the self-test itself passed); exit 1 means
// the lint failed to catch a corpus it should have flagged — a self-test
// regression, not a corpus regression.
// ---------------------------------------------------------------------------
function runSelfTest() {
  const badFixture = {
    persona: "self-test-fixture",
    goldFacts: [
      {
        entityType: "project",
        entityId: "fixture",
        key: "referenced_file:000000000000",
        value: "src/some/real/path.ts",
        note: "deliberately wrong hash for lint self-test",
      },
    ],
  };
  const failures = lintCorpusGolds(badFixture, "<self-test fixture>");
  if (failures.length === 1 && failures[0].key === "referenced_file:000000000000") {
    console.log("lint-corpus --self-test: PASS (bad hash correctly detected)");
    console.log(`  detected: ${failures[0].file}: "${failures[0].key}" -> expected "${failures[0].expectedKey}"`);
    process.exit(0);
  } else {
    console.error("lint-corpus --self-test: FAIL (lint did not detect the deliberately bad fixture hash)");
    process.exit(1);
  }
}

function main() {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }

  const failures = lintDirectory(CORPUS_DIR);
  if (failures.length > 0) {
    printFailures(failures);
    process.exit(1);
  }
  console.log(`lint-corpus: OK (all hash-keyed golds in ${CORPUS_DIR} verified)`);
}

main();
