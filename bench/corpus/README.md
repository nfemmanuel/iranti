# bench/corpus — golden-corpus growth policy

This directory holds the Layer 0b measurement harness's persona corpora
(`*.json`, one per persona). Each file is a fixed, versioned transcript plus
its gold labels (facts, probes, rules, rule probes, fabrication probes) — see
`src/harness/types.ts` for the shape and `docs/prds/phases/layer-0b-harness.md`
for why transcript and gold labels live together.

## Growth policy (AX-10)

The fabrication-probe set (and the corpus generally) is **permanent and
additive**, not a fixed fixture:

- **Every live fabrication incident and every newly identified extraction
  pattern class adds probes in the same commit as (or before) its fix.**
  Red-first: a new probe should print a violation before the fix lands, so
  the fix is provably the thing that turned it green.
- **Probes are NEVER removed, only added.** Removing a probe to make a
  number look better is exactly the failure mode this discipline exists to
  prevent — a regression on a removed probe would hide silently.
- **Corpus edits to existing entries are insertion-only.** Existing
  `messages`, `goldFacts`, `probes`, `rules`, `ruleProbes`, and
  `fabricationProbes` entries stay byte-identical once committed; growth
  means appending new entries, not rewriting old ones. (Fixing a
  demonstrably wrong gold — e.g. a bad hash, see the lint below — is the one
  exception, and it must be called out explicitly in the commit message.)
- **Anti-overfit discipline: author fresh sentences without looking at the
  pattern list.** Periodically (a "quarterly-style" cadence, not a hard
  schedule), write new adversarial sentences from first principles — what
  would a real conversation say that sounds category-adjacent but asserts
  nothing durable? — rather than deriving new probes mechanically from the
  existing pattern table. This guards against teaching the extractor to the
  test instead of hardening it against the real failure class.
- **Future escalation (not built yet):** a rotating holdout set, scored but
  not published per-probe, so the visible corpus can't be fully memorized
  against. Noted here as the next anti-overfit step if growth-by-discipline
  alone proves insufficient.

## Gold-hash lint (AX-10)

`bench/corpus/*.json` golds whose key matches `<prefix>:<12-hex>` (prefix
`referenced_file` or `shared_url`) are supposed to carry
`sha256(value).slice(0, 12)` as the key suffix — the same computation
`src/mcp/extractor.ts`'s `contentHash` uses. Three corpus golds have
silently carried a hand-typed WRONG hash in this project's history (two
labeled placeholders caught by code review, one unlabeled twin found during
a recall-plateau investigation) — each one silently misreported recall.

`node scripts/lint-corpus.mjs` (also `pnpm lint:corpus`) recomputes every
such hash from the gold's own `value` field and fails, naming the file, the
gold key found, and the expected key, on any mismatch. `pnpm bench` runs this
lint as a hard preflight (`"bench": "node scripts/lint-corpus.mjs && vitest
run src/harness/harness.test.ts"`) — the bench structurally cannot run
against a lying corpus.

Lint coverage is intentionally limited to hash-keyed golds
(`referenced_file:`/`shared_url:`). Slug-keyed golds (`decision:`, etc.) are
mechanically derived by extractors from arbitrary text and can't be
independently recomputed without re-running extraction — out of scope,
disclosed in `docs/prds/phases/ax-10-instrument-hardening.md` §9.

Run the lint's own self-test with `node scripts/lint-corpus.mjs --self-test`
— it runs the lint against an inline deliberately-bad fixture and exits 0
only if the lint correctly detected the failure.
