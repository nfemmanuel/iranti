# CLI Debugging Backlog

## Current Assessment

Iranti's CLI is already solid for guided human operators in `setup`, `doctor`, and `upgrade`, but it is still uneven for deeper debugging and automation.

Current strengths:
- clear PASS/WARN/FAIL output
- strong remediation in the best commands
- safer Windows handling for upgrades
- direct command help and guided onboarding

Current gaps:
- most failures are still plain `Error` strings without stable codes
- there was no general `--debug` or `--verbose` mode
- subprocess and env resolution were hard to inspect
- remediation quality varies by command family

## Immediate Hardening Pass

### Done
- add global `--debug` support for extra diagnostics
- add global `--verbose` support for subprocess tracing
- add a structured `CliError` type with:
  - error code
  - user-facing hints
  - optional debug details
- improve top-level error printing to show:
  - error code
  - possible fixes
  - stack trace in debug mode
- instrument subprocess execution and doctor target resolution with debug and trace output
- convert common binding and instance failures to structured CLI errors

### In Progress
- expand structured error coverage across the remaining command families
- standardize remediation quality outside `doctor`, `setup`, and `upgrade`

## Next Backlog

### Epic 1 - Structured Failure Model
- convert all high-frequency operator failures to `CliError`
- define stable error codes for:
  - instance not found
  - binding missing
  - database placeholder
  - provider key missing
  - bad setup config
  - subprocess and handoff failure
- add JSON-safe machine-readable error output for automation paths

### Epic 2 - Debuggability
- add command timing in debug mode
- add explicit env-resolution tracing for:
  - project binding
  - instance env
  - runtime root
- add `doctor --verbose` detail for network, vector, and backend probes
- add optional request tracing for CLI-to-API calls

### Epic 3 - Operator Experience
- normalize remediation blocks for `run`, `project`, `auth`, `configure`, and integration commands
- add a short "why this failed" section for common setup/runtime errors
- add better stale-install guidance whenever repo/global mismatch is detected

### Epic 4 - Automation Safety
- add stable non-zero exit-code categories where reasonable
- add tests for expected error codes on common failure cases
- document error-code meanings in the operator manual

## Recommendation

Treat the current pass as the foundation, not the finish.
The CLI is already good enough for interactive use.
The next leap is making failures legible enough for:
- serious operators
- automation
- future installer and control-plane tooling
