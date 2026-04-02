# Issue Facts

## Goal

Make open and resolved defects first-class Iranti facts instead of loose prose.

## Canonical Shape

- entity: the project or other owner entity, e.g. `project/iranti`
- key: `issue_<normalized_issue_id>`
- value:
  - `issueId`
  - `title`
  - `status` (`open` or `resolved`)
  - `severity`
  - `summary`
  - `details`
  - `discoveredAt`
  - `resolvedAt`
  - `resolution`
  - `tags`

## Lifecycle

- Opening an issue writes the stable issue key.
- Resolving the same issue writes the same stable key with `status: resolved`.
- Because the key stays stable, the prior open state moves into Archive automatically and history stays queryable.

## Properties

Issue facts carry:

- `durableClass: issue_status`
- `issueId`
- `issueStatus`
- `issueSeverity`
- `issueTitle`
- semantic metadata from `buildSemanticFactTags()`

## Public Surfaces

- `Iranti.writeIssue(...)` in the in-process SDK
- `IrantiClient.writeIssue(...)` in the TypeScript HTTP client
- `IrantiClient.write_issue(...)` in the Python HTTP client
- `iranti_write_issue` in the MCP server for Claude, Codex, and other MCP hosts
- `iranti issues [--entity <entity>] [--status open|resolved]` as a read-only operator surface for inspecting canonical issue facts

## Operator Audit Expectations

- `iranti issues` should show source and confidence for each canonical issue fact so operators can inspect provenance without dropping to raw queries.
- `iranti issues` should distinguish canonical issue facts from malformed `issue_*` rows instead of silently hiding namespace pollution.
- Canonical issue facts should populate `discoveredAt` when the discovery date is known or can be truthfully backfilled from the first canonical write.

The write helpers compile to the normal `/kb/write` surface. No separate issue API is required.

## Validation

- `tests/typescript_client/smoke_test.ts` — TypeScript HTTP client issue lifecycle
- `tests/mcp/smoke_test.ts` — MCP `iranti_write_issue` open/resolved lifecycle and canonical metadata
- `tests/api-surfaces/run_semantic_fact_tags_unit_tests.ts` — deterministic semantic shape for `issue_status` durableClass (in-memory, no DB required)
- `tests/api-surfaces/run_write_properties_route_tests.ts` — structured `issueStatus`/`issueType` properties survive through the REST write route
- `tests/cli/run_issue_list_tests.ts` — `iranti issues` listing and filtering, semantic property regression
- `scripts/test-contracts.ts`
- `npm run build`
