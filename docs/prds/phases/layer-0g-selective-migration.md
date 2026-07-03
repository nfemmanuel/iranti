# PRD: Layer 0g — Selective Memory Migration (old iranti → rebuild)

**Status:** proposed
**Phase:** Layer 0g (cutover track) · **Date:** 2026-07-03 · **Author:** Claude (NF decided: selective, not full; local dogfood before npm)
**Related:** dogfood setup (`iranti-next` in `.mcp.json`), Layer 0 project scoping (D4–D8), master PRD correctable-memory principle.

---

## 1. Summary

Move a *selected* subset of NF's accumulated old-iranti memories (~7k knowledge entries) into the rebuild — not a bulk copy. NF explicitly chose selective over fresh-start and over full migration. The mechanism: **export via the OLD server's own read API, import through the NEW `writeFact`/`writeRule` pipeline**, so every migrated fact is re-normalized, project-scoped, and conflict-checked on entry, and the two schemas never touch.

## 2. Grounding (discovered 2026-07-03, not assumed)

- The live old iranti is a **client/server setup**: `.env.iranti` carries `IRANTI_URL` + `IRANTI_API_KEY` + `IRANTI_INSTANCE` (+ agent/entity ids). The local `iranti mcp` CLI (installed v0.2.51) is a thin client.
- The data lives in **native Windows Postgres** (services `postgresql-x64-17` on 5432 and `-18` on 5433) — not in any of the (all-dormant) `iranti_*_db` docker containers.
- `~/.iranti/instances/` is empty; there is no local DB URL anywhere in project config. Direct-SQL export would require hunting credentials for a schema we no longer maintain — another reason to prefer the API route.

## 3. Goals & non-goals

**Goals**
- A repeatable one-way exporter: old-server API → curated JSON manifest → new-store import via the real write pipeline.
- **Selectivity as a first-class step:** the manifest is a human-reviewable file NF can prune before import (the "selective" in selective migration is a file edit, not a flag).
- Provenance: every imported fact carries `source: "migrated-v0"` (+ original timestamp in metadata) so migrated memory is forever distinguishable from natively-learned memory.
- Idempotent import (re-running skips already-imported facts by content identity).

**Non-goals**
- Migrating everything (NF decision). Telemetry, attend-logs, edges, session stats, escalations: not migrated — derived data regrows.
- Any write to the old store (read-only source, forever).
- Automatic quality judgment about WHICH facts matter — the default filter is mechanical (below); the judgment pass is NF pruning the manifest.

## 4. Default selection filter (proposal — NF can tighten)

Include: facts whose keys match the durable categories (`decision:*`, `preference:*`, `constraint:*`, `rule`-typed entries, `failed-approach:*`, explicitly-written project facts on entities NF names) from the entities NF actively uses (the project + personal memory entities named in `.env.iranti`, plus any he lists). Exclude: auto-extracted artifacts older than 60 days with zero access, checkpoints (stale by definition), anything with `confidence < 50`.

## 5. Design decisions

- **D1 — API-out, pipeline-in.** Export via the old server's read tools (search/observe per entity); import via new `writeFact`/`writeRule`. Zero schema coupling; the new store's invariants (normalizeKey, project scope, conflict/supersession) apply to every row. *Rejected:* direct SQL copy — couples us to a dead schema, bypasses the new write-path guarantees.
- **D2 — Manifest in the middle.** Export produces `migration/manifest-<date>.json` (git-ignored); NF prunes; import consumes. Auditable, resumable, and the selective step is visible.
- **D3 — Project mapping is explicit.** Old facts carry entity ids but no folder-project concept; the manifest assigns each entity group a target project (default: NF's Projects-root mapping; unresolvable ones land in a `migrated-unsorted` project NF can combine/exclude later — never silently into `default`).
- **D4 — Runs through vitest/tsx** (strip-types limitation), as `pnpm migrate:v0 -- export|import`.

## 6. Schema / API changes

None. Additive scripts under `scripts/migration/` + metadata convention (`migratedFrom`, `originalUpdatedAt`).

## 7. Acceptance criteria

- [ ] Export produces a manifest from the live old server (read-only; API key from `.env.iranti`, never committed).
- [ ] Import is idempotent (second run: 0 new writes) and every imported fact carries migration provenance.
- [ ] Imported facts are retrievable via `iranti-next` attend/search under the mapped projects; bench metrics remain 0.0pp (corpus untouched by migration code).
- [ ] Old store byte-untouched (read-only verified).
- [ ] A dry-run mode prints what WOULD import, counts by category/entity.

## 8. Deltas from the master PRD

None — implements the correctable/local-first principles for the cutover.

## 9. Risks & open questions

- Old-server API surface for bulk read: needs verification that search/observe can enumerate per-entity facts completely (pagination?). If the API can't enumerate, fallback is direct SQL read-only against the native Postgres — NF would need to point us at the right database/credentials.
- Key-collision policy on import: old keys pre-date AX-1 normalization edge cases; imports colliding with natively-written facts go through the normal conflict path (escalation if contradictory) — that's a feature, but NF should expect a few escalations to review after import.
- `IRANTI_URL` availability: export requires the old server running (it currently is — it served this session).

## 10. Verification

Dry-run counts vs manifest; post-import spot retrieval through `iranti-next`; idempotency re-run; old-store checksum/row-count unchanged.

## Changelog
- 2026-07-03 — proposed (NF decided selective + local-first dogfood; grounded in live-instance discovery: HTTP client + native Postgres, empty instances dir)
