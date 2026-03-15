# CLI UX Backlog

## Overview

Short, high-leverage CLI improvements to reduce onboarding friction without changing Iranti's core architecture.

## Priorities

1. `iranti upgrade` interactive multi-target execution
   - Status: Done
   - Why: users can have a repo checkout, global npm install, and Python client at the same time.

2. `iranti doctor` remediation hints
   - Status: Done
   - Why: diagnostics should tell operators what to do next, not just what is broken.

3. Post-upgrade binary handoff hint
   - Status: Done
   - Why: a running old global CLI cannot magically become the new binary after `npm install -g`.

4. Setup completion summary tightening
   - Status: Done
   - Why: first-run success depends on knowing the exact next command and where config landed.

5. Prompt-tone consistency across setup/configure/auth flows
   - Status: Done
   - Why: the CLI should feel like one product, not several scripts written at different times.

## Notes

- Keep prompts concise. Slightly conversational is good; verbose is not.
- Prefer additive hints and summaries over branching wizard complexity.
- Do not auto-run destructive or ambiguous package-manager actions without explicit user intent.
