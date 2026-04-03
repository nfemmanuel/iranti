# Instance-Scoped Agent Policies

**Status:** Post-beta / Planned

## Overview

Users can define standing behavioral policies for their agents at the instance level. Every repo bound to that instance inherits the same policies automatically. Individual projects can add overrides or suppressions on top, but cannot weaken instance-level enforcement tiers. Policies are injected at handshake time alongside project-specific facts, so agents receive a merged operating brief without needing per-repo configuration.

The motivation is that many agent behaviors — always run CI before committing, never force-push, always clean up worktrees, always write a checkpoint before stopping — are not project-specific preferences but personal workflow standards that a user wants consistent across all their work, regardless of which repo or host they are in.

## Policy Hierarchy

Policies resolve in this order, with lower layers narrowing or overriding higher ones:

```
user/global preferences        ← standing personal facts (user/main/*)
  └── instance/policies        ← this feature: instance-wide agent rules
        └── project/rules      ← repo-specific additions or overrides
```

At handshake time, Iranti merges all three layers into a `policyBrief` appended to the working memory brief. Project rules win over instance policies for the same policy key. User global preferences are advisory context; they do not override instance enforcement tiers.

## Inputs

| Input | Type | Description |
|---|---|---|
| Instance ID | `string` | The Iranti instance that owns the bound repo. Resolved from `IRANTI_PROJECT_ENV` or the active instance context. |
| Policy definition | `PolicyEntry` | A named, typed rule authored by the user. See Policy Entry Shape below. |
| Enforcement tier | `"advisory" \| "enforce"` | Whether violation is a context-injection hint or a hard protocol block. |
| Project override | `PolicyOverride` | A project-scoped fact that narrows, suppresses, or replaces a parent instance policy for that repo only. |
| `IRANTI_MEMORY_ENTITY` | `string?` | Project-scoped entity used to load project-level policy overrides at handshake. |
| Handshake task | `string` | The current task passed to `iranti_handshake`. Used to filter which policies are relevant to the active session. |

### Policy Entry Shape

```ts
{
  policyId: string;           // stable slug, e.g. "always-run-ci"
  title: string;              // human-readable, e.g. "Always run CI on new builds"
  description: string;        // what the agent should do or avoid
  tier: "advisory" | "enforce";
  scope: "instance" | "project";
  appliesTo?: string[];       // optional: limit to specific hosts or task types
  createdAt: string;          // ISO timestamp
  createdBy: "user" | "agent" | "cp";
  suppressedBy?: string;      // project policyId that suppresses this for a repo
}
```

## Outputs

| Output | Type | Description |
|---|---|---|
| `policyBrief` | `PolicyBrief` | Merged policy set returned in the handshake response alongside `workingMemory`. Contains resolved instance policies and any active project overrides. |
| Enforcement block | HTTP 428 | Returned by protocol enforcement routes when an `enforce`-tier policy is violated. Mirrors the existing protocol enforcement shape. |
| Advisory injection | `workingMemory` entry | Advisory-tier policies are surfaced as compact working-memory facts so the agent reads them as context without a hard block. |
| Policy ledger row | `staff_events` | Each policy write, suppression, and enforcement trigger emits a ledger event for operator observability. |
| Merge trace | `policyBrief.mergeTrace` | Optional debug field listing which policies came from instance level, which were overridden at project level, and which were suppressed. |

## Authoring Surfaces

Users can define and manage policies through any of three surfaces:

### 1. CLI
```bash
iranti configure instance --add-policy "always run CI on new builds" --tier advisory
iranti configure instance --list-policies
iranti configure instance --remove-policy always-run-ci
iranti configure project --suppress-policy always-run-ci   # project-level suppression
```

### 2. Control Plane UI
The instance detail page gains an **Agent Policies** tab. Each policy entry shows its title, tier, scope, creation source, and any per-repo suppressions. Users can add, edit, and remove policies from this surface. The per-repo override state is visible from the project detail page.

### 3. Natural Language to Agent
An agent receiving a standing instruction ("from now on, always run CI before committing") may write it to the instance policy store via `iranti_write` targeting `instance/<id>/policies/<policyId>`. The authoring source is recorded as `agent` and the user is shown the write at next handshake. This path requires the agent to have write scope for the instance entity.

## Lifecycle Policy

1. At `iranti_handshake`, load all active policies for the resolved instance entity.
2. Load any project-level policy overrides from `IRANTI_MEMORY_ENTITY`.
3. Merge the two layers: project overrides win on key conflict; suppressions remove the parent entry.
4. Append the merged `policyBrief` to the handshake response alongside `workingMemory`.
5. Advisory-tier policies appear as compact working-memory entries in the brief so agents can read them as operating context without a special format.
6. Enforce-tier policies are also registered with the active protocol enforcement surface so violations trigger a 428 response on relevant routes.
7. When no instance can be resolved, skip policy loading silently — do not block the session.
8. When a project override suppresses an instance policy, include a `suppressedPolicies` list in the merge trace so the operator can audit suppressions.
9. Policy entries written by an agent are marked `createdBy: "agent"` and surface a pending-review flag in the CP UI until the user confirms them.
10. Policy loading is bounded: a single handshake should load no more than 20 active policy entries. Policies beyond this limit should be pruned by `tier` (enforce first) then `createdAt` (newest first).
11. Policies with `appliesTo` filters are omitted from the brief when the active host or task type does not match.
12. Policy facts are stored under `instance/<instanceId>/policies/<policyId>` in the Iranti fact store. They follow the same conflict and override rules as other Iranti facts.
13. When a policy is removed, the fact is archived rather than hard-deleted so the ledger can reconstruct when a rule was active.

## Enforcement Tiers

| Tier | Agent behavior | Protocol enforcement |
|---|---|---|
| `advisory` | Policy is injected into working memory. Agent reads it as operating context. No hard block if not followed. | No 428. Ledger row emitted if the agent explicitly skips a policy it acknowledged. |
| `enforce` | Policy is injected into working memory AND registered as a protocol rule. Violations on covered routes return 428. | 428 returned. Violation code `instance_policy_violation`. Ledger row emitted. |

Enforcement-tier policies should be used sparingly. They are appropriate for rules with safety, compliance, or workflow-integrity implications (e.g. "never force-push to main"). Advisory tier is appropriate for preference and style rules (e.g. "prefer squash merges").

## Edge Cases

- If `IRANTI_PROJECT_ENV` is not set, instance resolution fails silently and no policies are loaded. The session proceeds normally with an empty policy brief.
- A project override that references a nonexistent instance policy ID is ignored at merge time but logged as a dangling override in the merge trace.
- Agents without write scope for the instance entity may suggest a policy but cannot commit it. The suggestion should be surfaced in the CP UI for the user to confirm.
- The same policyId at instance and project scope resolves to the project entry — the project version fully replaces (not merges with) the instance version.
- Policies are not project facts and should not appear in standard `attend()` or `observe()` retrieval for non-policy queries. They load only during handshake/reconvene.
- Suppress-all is not supported at the project level. A project can suppress named policies or add its own, but cannot opt out of all instance policies.
- If an enforce-tier policy is suppressed at the project level, the protocol enforcement registration for that route is also removed for that repo's sessions. The instance-level entry remains active for all other repos.
- Policy ledger rows are distinct from KB fact write rows. They appear under `staff_events` with `eventType: "policy_*"` so they can be filtered separately from memory operations.

## Core vs Host-Specific Boundary

- Policy storage, merge logic, enforcement registration, and ledger emission are core Iranti behaviors and work the same across all hosts.
- Authoring via natural language ("from now on, always...") is host-specific. Each host integration decides whether to intercept this phrasing and route it to `iranti_write` targeting the policy store.
- The CP UI policy tab is a control-plane concern, not a core SDK concern.
- `iranti claude-setup` and `iranti codex-setup` may append a compact instance policy summary to the generated `CLAUDE.md` / `AGENTS.md` so policies are visible even when Iranti is not connected.
