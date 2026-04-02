# Internal Notes Index

This folder is for supporting material, not the primary product contract.

Use canonical docs first:
- [`docs/guides/`](../guides/)
- [`docs/operations/`](../operations/)
- [`docs/features/*/spec.md`](../features/)
- [`docs/decisions/`](../decisions/)
- [`docs/API.md`](../API.md)

Internal docs are useful when you need implementation history, validation evidence, release gating detail, or backlog context.

## Active Reference Notes

These are the internal docs most likely to stay relevant during normal development:

- [`TESTING.md`](./TESTING.md)
- [`manual-release-validation-checklist.md`](./manual-release-validation-checklist.md)
- [`rigorous-validation-plan-2026-03-29.md`](./rigorous-validation-plan-2026-03-29.md)
- [`closed_beta_checklist_2026_04_02.md`](./closed_beta_checklist_2026_04_02.md)
- [`compatibility_backlog.md`](./compatibility_backlog.md)
- [`consistency_model.md`](./consistency_model.md)
- [`decay.md`](./decay.md)
- [`HOST_MEMORY_CALL_AUDIT_2026-03-28.md`](./HOST_MEMORY_CALL_AUDIT_2026-03-28.md)
- [`session-ledger-design-2026-03-28.md`](./session-ledger-design-2026-03-28.md)

## Planning And Working Notes

These files are useful for active follow-up work, but they are not product contract docs:

- [`cli_debugging_backlog.md`](./cli_debugging_backlog.md)
- [`cli_ux_backlog.md`](./cli_ux_backlog.md)
- [`codex_sprint_backlog.md`](./codex_sprint_backlog.md)
- [`closed_beta_conduct_proposal_2026_04_02.md`](./closed_beta_conduct_proposal_2026_04_02.md)
- [`MEMORY_LIFECYCLE_IMPLEMENTATION_PLAN.md`](./MEMORY_LIFECYCLE_IMPLEMENTATION_PLAN.md)
- [`INSTANCE_RUNTIME_DEPENDENCIES_IMPLEMENTATION_PLAN.md`](./INSTANCE_RUNTIME_DEPENDENCIES_IMPLEMENTATION_PLAN.md)

## History And Evidence

Historical audits, fix ledgers, release artifacts, and retired root docs have been pushed behind dedicated history indexes:

- [`history/README.md`](./history/README.md)
- [`releases/README.md`](./releases/README.md)

That includes dated execution logs such as the rigorous validation runbook evidence, which are preserved for auditability but are no longer part of the active working surface.

## Raw Experiment Output

These files are preserved as evidence, not as the current contract:

- [`experiment_a_output.txt`](./experiment_a_output.txt)
- [`experiment_b_output.txt`](./experiment_b_output.txt)
- [`experiment_c_output.txt`](./experiment_c_output.txt)

## Rule Of Thumb

If two docs disagree:
1. guide or operations doc beats internal summary
2. feature spec beats internal summary
3. decision record beats historical implementation note
4. dated audits and release artifacts are historical unless an active doc explicitly adopts them
