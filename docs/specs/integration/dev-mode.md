# Dev mode

**Status:** deferred  
**Group:** Integration · **Phase:** deferred  
**[Back to map](../../MAP.md)** · **[PRD §13](../../rough-notes/iranti-core-prd.md#13-open-items)**

---

> Dev mode is explicitly out of scope for the done-enough build. The CLI covers the minimum operational surface for the initial build. Dev mode is a more complete interactive experience for testing and debugging iranti itself.

## What it is

Direct iranti access without a host, for testing and debugging.

## Why it matters

Building and validating iranti behaviour requires the ability to interact with it outside of a live agent session. Dev mode is the tool for iranti's own developers and for advanced integrators who want to explore iranti's internals.

## How it differs from the CLI

The CLI is an operational tool — for querying memory, managing facts, and running diagnostics in a project context. Dev mode is a development and testing environment — for interacting with iranti directly, sending arbitrary signals to the Attendant, triggering specific code paths, and inspecting internal state.

## What we know so far

- Dev mode allows direct interaction with the Attendant and Librarian without a registered host session
- It is for testing and debugging, not for production use
- The CLI must be complete before dev mode is worth building — dev mode extends it, it does not replace it

## Prerequisites before writing this spec

- iranti-core done enough
- CLI complete (Phase 6)
- At least one full production release providing real usage data showing what developers actually need to test

---

_Come back to this after iranti-core is in real use._
