# PRD: AX-2 — Content-Hash Extraction Cache

**Status:** shipped
**Phase:** AX-2 (Extraction/Retrieval Hardening track) · **Date:** 2026-06-27 · **Author:** NF + Claude
**Related:** master PRD §7 (facts) + §11 (behavioral-data-only logging), [decision register](../../decisions/open-decisions.md) AX-2 + stated determinism principle + OD-1, [AX-1 — Key Normalization](ax-1-key-normalization.md), `src/extract/index.ts`, `src/mcp/tools/attend.ts`

---

## 1. Summary
Extraction is the one expensive, non-deterministic step in the pipeline: turning message text into facts is an LLM call (~24s/msg measured locally; OD-1), and LLMs are not bitwise-deterministic even at `temperature: 0`. AX-2 puts a **durable content-hash cache** in front of the LLM extractor. Before calling the model, we hash the exact input together with everything that could change the model's output (extractor mode, model id, prompt version, normalizer version). On a hit we return the **cached `ExtractedFact[]` verbatim** instead of calling the LLM; on a miss we fall through to normal extraction and record the result fire-and-forget. This delivers the achievable form of the project's "deterministic system, non-deterministic LLM" principle: **byte-identical facts on every repeat of a seen input**, plus the cost/latency win of never re-running the model on text we have already processed. It explicitly does **not** make the *first* extraction of a given input deterministic — only its repeats.

## 2. Problem & motivation
The register's stated principle is "the system is deterministic; the LLM need not be." AX-1 made the **store** layer deterministic (canonical keys). But the extraction step itself is not reproducible: the same message run twice through `LocalLlmExtractor.extract()` can yield different facts because the LLM is nondeterministic, and each run pays the full ~24s local inference cost. Concretely, verified in the code:
- `attend.ts:152` calls `extractor.extract(message)` on every non-mid-turn attend with a message, and again on `currentContext` for `post-response` (`attend.ts:595–605`). Re-ingest / replay therefore re-invokes the model on text already seen.
- `LocalLlmExtractor.extract()` (`extract/index.ts:178–237`) is the costly/nondeterministic path: a `fetch` to the LLM endpoint, JSON parse, then a merge with the heuristic pass.
- There is no caching anywhere on this path; identical input is re-extracted from scratch every time.

Without AX-2, "cache-hit reproducibility = 100% on repeated inputs" (the register's verify metric for AX-2) is unmet, and replay/re-ingest is both slow and non-reproducible.

## 3. Goals & non-goals
**Goals**
- **Repeat determinism:** the same input, re-extracted, returns a **byte-identical** `ExtractedFact[]` — guaranteed by serving the stored result, not re-running the model.
- **Cost/latency:** a cache hit makes **zero LLM calls** for already-seen text.
- **Durable across sessions/process restarts:** replay works across runs, so the cache is a DB table, not in-memory.
- **Correctness on change:** when the model, prompt, extractor mode, or normalizer changes, the cache **misses** (never returns stale results computed under a different regime).
- **Never makes extraction worse:** a miss falls through to normal extraction; a cache read or write failure is non-blocking and degrades to plain extraction.

**Non-goals**
- Making the **first** extraction of a never-seen input deterministic (impossible with a nondeterministic model — see §9). AX-2 is repeat-determinism only.
- Caching the **heuristic-only** extractor's output — it is already pure and deterministic (`HeuristicExtractor` is regex-only); caching it would add a DB round-trip for no determinism gain (see §5).
- Cross-tenant sharing of cache entries (entries are tenant-scoped from day one, per the project's tenancy seam).
- Schema-constrained decoding / parse-failure elimination (that is AX-3) — AX-2 caches whatever the current extractor returns, valid or empty.
- Value/semantic normalization of cached facts beyond what AX-1 already applies.

## 4. Scope
**In**
- A cache layer wrapping the **`LocalLlmExtractor` path** (the expensive/nondeterministic one). It caches the **full merged `ExtractedFact[]`** that `extract()` returns (post heuristic+LLM merge) — see §5 for why the whole output and not just the LLM sub-call.
- A deterministic **cache key**: `sha256(normalizedInput)` plus a composite **regime signature** (extractor mode + model id + prompt version + normalizer version) — see §5.
- A new durable table `extraction_cache` (§6) + migration `0012`.
- Read-before-extract and write-after-extract wiring at the extractor boundary, both non-blocking.
- A small `EXTRACTION_PROMPT_VERSION` constant bumped whenever `LLM_SYSTEM_PROMPT` (or the decoding params that affect output) changes — the human-controlled cache-bust lever.

**Out (deferred)**
- Caching the cloud-escalation tier (AX-8) — the same cache design applies but the cloud model id becomes part of the regime signature; wire it when AX-8 lands.
- A cache for embeddings (CORE-16) — different lifecycle; not this PRD.
- Admin tooling to inspect/evict cache entries (CLI) — deferred until a real need; eviction is covered structurally by the regime signature (stale-regime entries simply stop being read).
- TTL-based expiry — AX-2 ships **permanent** entries keyed by regime (see §5 invalidation); revisit only if table growth becomes a measured problem.

## 5. Design decisions & rationale
- **What is hashed (the cache key) — the single most important decision.**
  **Decision:** the cache key is the pair `(input_hash, regime_signature)` where
  `input_hash = sha256(normalizeForCache(rawText))` and
  `regime_signature = "{extractorMode}|{modelId}|{promptVersion}|{normalizerVersion}"`.
  `normalizeForCache` is a *minimal, lossless-for-determinism* canonicalization (trim, normalize line endings) applied to the same `rawText` the extractor would receive — note the extractor already slices to 2000 chars (`extract/index.ts:193`), so we hash the **pre-slice raw input** and let the regime signature pin the model behavior. **Why:** the cached result is only valid for the exact text **and** the exact extraction regime that produced it. If the model, prompt, mode, or key-normalizer changes, the previously cached facts are wrong-for-the-current-system — so all four must be in the key. **Alternative rejected:** hashing the message text alone. That is the obvious cheap option and it is unsafe: changing `LLM_SYSTEM_PROMPT` or the model env var would silently serve facts extracted under the old prompt/model, the exact stale-cache failure AX-1's review flagged for keys. Including the regime signature makes a prompt/model change a guaranteed miss rather than a silent wrong answer.
- **Cache storage — durable DB table, not in-memory.**
  **Decision:** a new `extraction_cache` Postgres table. **Why:** the register's AX-2 charter is "replay/re-ingest determinism (byte-identical on repeat)" — replay spans sessions and process restarts, which an in-memory map cannot survive. Postgres is already the substrate and the reason the system is deterministic. **Alternative rejected:** an in-process `Map`/LRU — faster on hit but loses everything on restart, so it fails the replay goal and gives no cross-session reproducibility.
- **What is cached — the full merged `ExtractedFact[]`, not just the LLM sub-call.**
  **Decision:** cache the array `extract()` returns (post heuristic+LLM merge). **Why:** (1) it is the value the caller actually consumes (`extractAndStore` iterates `extracted`), so caching it guarantees byte-identical *consumed* output; (2) the heuristic pass is deterministic, so including it in the cached blob changes nothing on repeat and avoids a second merge step on hit; (3) caching only the LLM sub-result would still re-run the merge and re-serialize, reintroducing an ordering surface for no benefit. The cache wraps `LocalLlmExtractor.extract()` as a whole. **Alternative rejected:** caching only the raw LLM JSON before merge — more moving parts, and the merge (`extract/index.ts:227–236`) would still run each time, so the guarantee would be weaker.
- **Where the cache sits — only on the `local` (LLM) extractor, not the heuristic-only one.**
  **Decision:** the cache is active only when `IRANTI_EXTRACTOR=local`. In `heuristic` mode `extract()` is already pure/deterministic, so there is nothing to make reproducible and a DB round-trip would be pure overhead. **Why:** AX-2's value is bounded to the nondeterministic/expensive path. **Alternative rejected:** caching unconditionally — adds latency to the already-fast heuristic path with zero determinism gain.
- **Invalidation / versioning — regime signature, permanent entries (no TTL).**
  **Decision:** entries never expire on time; a prompt change is shipped by **bumping `EXTRACTION_PROMPT_VERSION`**, a model change by the differing `modelId`, a normalizer change by `normalizerVersion`. Any of these changes the `regime_signature`, so subsequent reads miss and recompute; old entries remain (harmless, never read) until a future eviction tool removes them. **Why:** determinism for a fixed regime should be permanent — a TTL would re-introduce nondeterminism (cache expires → model re-runs → different facts). **Alternative rejected:** TTL expiry — directly undermines the repeat-determinism goal.
- **Interaction with AX-1 — no double-processing.**
  Verified: the LLM path already applies `normalizeKey` to each key *before* the merge (`extract/index.ts:209`), so the `ExtractedFact[]` we cache already holds normalized keys. On a hit we return that blob verbatim — keys are **not** re-normalized, so there is no double-processing and no risk of drift. `normalizerVersion` is in the regime signature precisely so that if `normalizeKey` semantics ever change, the cache busts rather than serving keys normalized under the old rules. **Alternative rejected:** re-running `normalizeKey` on cached results — redundant and a latent drift surface.
- **Failure modes — cache must never make extraction worse.**
  Read miss or read error → fall through to normal `extract()` (the cache is an optimization, never a dependency). Write is **fire-and-forget** (`void … .catch(log)`), matching the existing write path (`attend.ts` edge recording and the async post-attend chain are already fire-and-forget). A write failure leaves the system in exactly the no-cache state. **Why:** correctness of extraction must not hinge on cache availability. **Alternative rejected:** blocking writes / throwing on cache error — would couple extraction availability to the cache.

## 6. Schema / API changes
**New table — `extraction_cache` (migration `0012`).** Defined in `src/db/schema.ts` following the existing tenancy/jsonb conventions:

| Column | Type | Notes |
|---|---|---|
| `input_hash` | `text` | SHA-256 hex of `normalizeForCache(rawText)`. Part of composite PK. |
| `regime_signature` | `text` | `"{extractorMode}\|{modelId}\|{promptVersion}\|{normalizerVersion}"`. Part of composite PK. |
| `tenant_id` | `text` `NOT NULL DEFAULT 'default'` | Tenancy seam, consistent with every other table; part of composite PK. |
| `result` | `jsonb` `NOT NULL` | The cached `ExtractedFact[]` (post-merge), serialized verbatim. |
| `extractor_mode` | `text` `NOT NULL` | Denormalized from the signature for queryability (e.g. `'local'`). |
| `model_id` | `text` `NOT NULL` | e.g. `'qwen2.5:3b'`. Denormalized for queryability/audit. |
| `prompt_version` | `text` `NOT NULL` | Value of `EXTRACTION_PROMPT_VERSION` at write time. |
| `normalizer_version` | `text` `NOT NULL` | Value of `normalizeKey`'s version at write time. |
| `hit_count` | `integer` `NOT NULL DEFAULT 0` | Incremented (best-effort) on each cache hit; observability only, never read by the extract path. |
| `created_at` | `timestamptz` `NOT NULL DEFAULT now()` | When first cached. |
| `last_hit_at` | `timestamptz` | Updated best-effort on hit; nullable. |

- **Primary key:** composite `(tenant_id, input_hash, regime_signature)`. This *is* the cache key; the PK doubles as the lookup index, so no separate index is required for the read path. An `ON CONFLICT DO NOTHING` (or `DO UPDATE` bumping `hit_count`) keeps writes idempotent under concurrent identical misses.
- **No content stored beyond extracted slots.** `result` holds only `ExtractedFact[]` (key/value/source/confidence) — the same data already persisted as facts. We do **not** store the raw message text, only its hash, which keeps the table aligned with master §11 (behavioral/derived data, not verbatim conversation content). *(Open question in §9: confirm hashing raw text without storing it satisfies §11 — current read is that it does.)*

**API / code changes (no other schema):**
- New constant `EXTRACTION_PROMPT_VERSION` (e.g. `"1"`) co-located with `LLM_SYSTEM_PROMPT` in `src/extract/index.ts`, with a comment requiring a bump whenever the prompt or output-affecting decode params change.
- New `normalizeKey` version constant exported from `src/library/keys.ts` (AX-1's module), surfaced into the regime signature so a normalizer change busts the cache.
- A cache helper module (e.g. `src/library/extraction-cache.ts`): `readCache(hash, signature, tenantId)` and `writeCache(...)` (fire-and-forget), plus `hashInput(rawText)` and `buildRegimeSignature()`.
- `LocalLlmExtractor.extract()` (or a thin caching wrapper around it) gains: compute hash+signature → `readCache` → on hit return parsed `result`; on miss call the existing path, then `void writeCache(...)`.
- `extractAndStore` (`attend.ts`) is **unchanged** — it still calls `extractor.extract(message)`; the cache is transparent at the extractor boundary. (Confirm the cache layer also covers the `currentContext` autowrite call, which goes through the same `extractor.extract`.)
- **LLM response parsing — `parseLlmJson` (shipped, commit 35e4e0a6).** The LLM extractor's JSON response is parsed via `parseLlmJson` from `src/library/llm-json.ts`. This shared helper strips markdown fences and handles malformed LLM JSON in one place; it is also used by the vision backend (`src/media/vision.ts`). Cache writes receive the already-parsed, merged `ExtractedFact[]` — `parseLlmJson` runs inside the `_extractFresh` path before the result is handed to the cache layer.
- **Cache writes are gated on `llmSucceeded` (shipped, commit 991ce3bf).** The cache write is conditional: `writeCache` is only called when the LLM pass actually ran and produced a result (`llmSucceeded = true`). Heuristic-only degraded results are NOT cached — this prevents the heuristic-fallback (which runs when the LLM endpoint is down or returns garbage) from polluting the cache with partial results under the LLM regime's signature.

## 7. Acceptance criteria
- [ ] **Repeat determinism:** in `local` mode, extracting the same input twice → the **second** call makes **zero LLM calls** (mocked endpoint asserts call count goes from 1 to 0) and returns a `ExtractedFact[]` that is **byte-identical** (`JSON.stringify` equal) to the first.
- [ ] **Cache-hit reproducibility = 100%** on a fixed repeated-input set (the register's AX-2 verify metric): N identical inputs replayed → every repeat is a hit and byte-identical.
- [ ] **Prompt-version bust:** with a cached entry present, bumping `EXTRACTION_PROMPT_VERSION` → next extraction **misses** (LLM is called again) and writes a new entry under the new signature.
- [ ] **Model bust:** changing the model id (`IRANTI_LLM_MODEL`) → cache miss, LLM called, new entry written.
- [ ] **Normalizer bust:** changing the `normalizeKey` version → cache miss.
- [ ] **Heuristic mode unaffected:** in `heuristic` mode the cache is never consulted or written (assert no `extraction_cache` reads/writes).
- [ ] **Miss falls through cleanly:** a never-seen input runs normal extraction and returns the same facts it would without the cache (behavior identical to pre-AX-2 on a miss).
- [ ] **Failure is non-blocking:** with the cache read forced to throw, extraction still returns correct facts (degrades to plain extraction); with the cache write forced to throw, the extract call still returns and does not reject.
- [ ] **AX-1 consistency:** cached results already hold AX-1-normalized keys; a test asserts keys returned from a hit equal `normalizeKey(key)` and are **not** re-processed.
- [ ] **Tenancy:** an entry written under `tenant_id='default'` is not served to a different tenant's signature lookup.
- [ ] **Migration `0012` applies cleanly**; full vitest suite + `pnpm typecheck` + `pnpm lint` green.

## 8. Deltas from the master PRD
None in spirit. AX-2 strengthens the determinism principle the register states (deterministic system, nondeterministic LLM) by making extraction **reproducible on repeat**, and supports master §7 fact addressing. It introduces no verbatim-content storage (only a hash + extracted slots), so it stays within master §11. It does not alter the §12 sequence.

## 9. Risks & open questions
- **Determinism honesty (must be stated, not a defect):** the cache guarantees byte-identical **repeat** results; it does **not** make the **first** extraction of a given input deterministic — the model is still nondeterministic on first sight. "Reproducible extraction" therefore means "reproducible once seen," which is the achievable form of the principle. AX-6 (repro gate) measures the residual first-pass variance separately.
- **Stale-regime growth.** Permanent entries + regime bumps mean old-regime rows accumulate. Acceptable on the dev store; if it grows, add an eviction tool (deferred, §4) — never a TTL (TTL would re-introduce nondeterminism).
- **Hash of pre-slice vs post-slice input.** The extractor slices to 2000 chars before the LLM call (`extract/index.ts:193`). We hash the **raw** input; two inputs that differ only beyond 2000 chars would hash differently but extract identically (a benign extra miss, never a wrong hit). Documented; revisit only if it causes measurable miss-rate bloat. **Open:** should we hash the post-slice text instead to maximize hit rate? Leaning no (raw is safer/clearer), flagged for review.
- **Empty results are cached too.** A miss that legitimately extracts `[]` is cached as `[]` and served on repeat — correct and desirable (it makes "no facts here" reproducible and free). Confirm this is intended (current read: yes).
- **§11 content-storage check — OPEN, needs NF decision.** `extraction_cache` stores `sha256(rawMessageText)` in `input_hash`. The hash is irreversible (no content recoverable), but it IS derived from verbatim message text — distinct from the extracted slot data that facts.ts persists. **OPEN:** Does storing a SHA-256 hash of message text in `extraction_cache` satisfy master §11's behavioral-data-only constraint? Hash is one-way; flagged and NOT yet decided — needs NF. Do NOT mark resolved until NF explicitly rules.
- **Prompt-version discipline is human-enforced.** The cache only busts on a prompt change if someone bumps `EXTRACTION_PROMPT_VERSION`. Mitigation: co-locate the constant directly above `LLM_SYSTEM_PROMPT` with a loud comment; consider a unit test that fails if the prompt string's hash changes without a version bump (nice-to-have, flagged).
- **Concurrent identical misses.** Two attends with the same input racing before either writes → both call the LLM, both attempt to write the same PK. `ON CONFLICT DO NOTHING/UPDATE` makes the write safe; the duplicated LLM call is a rare, harmless cost (not a correctness issue).

## 10. Verification
- **Unit:** `hashInput` determinism + sensitivity (text change → different hash); `buildRegimeSignature` includes all four dimensions; cache read/write helpers round-trip a `ExtractedFact[]`; degrade-on-error behavior.
- **Integration (mocked LLM endpoint, asserting call count):** miss→write→hit sequence makes exactly one LLM call across two extractions; prompt/model/normalizer-version busts each force a fresh call; heuristic mode never touches the table; tenancy isolation; forced read/write failures still return correct facts.
- **Repro gate (feeds AX-6):** replay the fixed golden corpus twice in `local` mode → second pass is 100% cache hits, byte-identical facts; report cache-hit rate and confirmed zero-LLM-calls on the repeat pass.
- **Migration smoke:** `0012` applies cleanly on the existing store; composite-PK uniqueness verified.
- `pnpm typecheck`, `pnpm lint`, full vitest green.

## Changelog
- 2026-06-27 — proposed
- 2026-06-28 — accepted (NF verbal: "Looks good, now implement them")
- 2026-06-28 — shipped: EXTRACTION_PROMPT_VERSION constant + NORMALIZER_VERSION export (keys.ts); src/library/extraction-cache.ts (hashInput, buildRegimeSignature, readCache, writeCache fire-and-forget); LocalLlmExtractor wrapped with cache read-before/write-after (_extractFresh extracted); extraction_cache table added to schema.ts; migration 0012_ax2_extraction_cache.sql; journal entry. 15 new unit tests (extraction-cache.test.ts). 67/67 green.
- 2026-06-28 — doc additions: (1) parseLlmJson (src/library/llm-json.ts, commit 35e4e0a6) noted in §6 API changes — shared with vision backend, runs inside _extractFresh before cache write; (2) llmSucceeded gate noted in §6 — cache writes conditional on LLM pass actually running (heuristic-only degraded results not cached, commit 991ce3bf); (3) §9 §11 content-storage question re-framed as firmly OPEN pending NF decision — do not resolve until NF rules.
