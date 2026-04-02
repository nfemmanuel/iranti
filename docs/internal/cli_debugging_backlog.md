# CLI Debugging Backlog

## Current Assessment

Iranti's CLI is already solid for guided human operators in `setup`, `doctor`, and `upgrade`, but it is still uneven for deeper debugging and automation.

Current strengths:
- clear PASS/WARN/FAIL output
- strong remediation in the best commands
- safer Windows handling for upgrades
- direct command help and guided onboarding

Current gaps:
- command timing is not surfaced yet in debug mode
- deeper env-resolution tracing is still thinner outside the main operator flows
- some lower-frequency commands still rely on generic fallback codes instead of command-specific codes

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
- rewrite common operator failures from remaining command families into stable error codes with remediation hints
- emit a machine-readable JSON failure envelope for `--json` automation paths
- instrument subprocess execution and doctor target resolution with debug and trace output
- convert common binding and instance failures to structured CLI errors

## Next Backlog

### Epic 1 - Structured Failure Model
- continue replacing generic fallback codes in lower-frequency command paths where the operator benefit is clear
- extend the published error-code list when new automation-facing commands gain `--json`

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
- document additional error-code meanings in the operator manual when new codes are added

## Recommendation

Treat the current pass as the foundation, not the finish.
The CLI is already good enough for interactive use.
The next leap is making failures legible enough for:
- serious operators
- automation
- future installer and control-plane tooling
