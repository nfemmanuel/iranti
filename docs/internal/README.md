# Internal Notes Index

This folder is for supporting material, not the primary product contract.

Use the canonical docs first:
- [`docs/guides/`](../guides/) for operator and developer workflows
- [`docs/features/*/spec.md`](../features/) for feature behavior and edge cases
- [`docs/decisions/`](../decisions/) for architectural decisions
- [`docs/operations/`](../operations/) for deployment and operational posture
- [`README.md`](../../README.md) for the public overview and onboarding surface

Internal files are useful when you need implementation history, validation evidence, or backlog context. They are not authoritative unless a canonical guide/spec/decision explicitly points to them.

## Active Reference Notes

These are the internal files most likely to stay useful during normal development:

- [`TESTING.md`](./TESTING.md) - how to run the current test surfaces
- [`compatibility_backlog.md`](./compatibility_backlog.md) - follow-up compatibility work and release gating
- [`consistency_model.md`](./consistency_model.md) - current consistency model explanation
- [`decay.md`](./decay.md) - current memory-decay design note

## Historical Summaries And Validation Artifacts

These files preserve useful history and evidence, but they are not the canonical product contract:

- [`releases/README.md`](./releases/README.md) - release-specific hardening and execution artifacts
- [`IMPLEMENTATION_SUMMARY.md`](./IMPLEMENTATION_SUMMARY.md) - historical implementation summary
- [`FIXES_APPLIED.md`](./FIXES_APPLIED.md) - historical fixes ledger
- [`GOAL_VALIDATION_SUMMARY.md`](./GOAL_VALIDATION_SUMMARY.md) - early goal-validation summary
- [`validation_results.md`](./validation_results.md) - auditable validation log
- [`MULTI_FRAMEWORK_VALIDATION.md`](./MULTI_FRAMEWORK_VALIDATION.md) - framework-specific validation notes
- [`PERFORMANCE.md`](./PERFORMANCE.md) - performance notes and historical guidance
- [`conflict_benchmark.md`](./conflict_benchmark.md) - benchmark-specific internal record
- [`release-readiness-2026-03-22.md`](./release-readiness-2026-03-22.md) - dated release-readiness artifact

## Planning Backlogs

These files are planning notes, not commitments or product truth:

- [`cli_debugging_backlog.md`](./cli_debugging_backlog.md)
- [`cli_ux_backlog.md`](./cli_ux_backlog.md)
- [`codex_sprint_backlog.md`](./codex_sprint_backlog.md)

## Raw Experiment Output

These files are preserved as evidence, not as docs to cite for current behavior:

- [`experiment_a_output.txt`](./experiment_a_output.txt)
- [`experiment_b_output.txt`](./experiment_b_output.txt)
- [`experiment_c_output.txt`](./experiment_c_output.txt)

## Rule Of Thumb

If two docs disagree:
1. feature spec beats internal summary
2. guide beats internal summary
3. decision record beats historical implementation note
4. dated audit/summary files are historical unless a canonical doc explicitly adopts them
