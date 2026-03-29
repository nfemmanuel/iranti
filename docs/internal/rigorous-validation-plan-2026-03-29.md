# Rigorous Validation Plan - 2026-03-29

## Purpose

This is the validation backbone for the next hardening phase.

We are not widening host scope yet. Before we expand to Gemini, Amazon Q,
GitHub Copilot, Cline, or any other new host, we need to prove that the
current Iranti system is trustworthy across:

- core `iranti`
- `iranti-control-plane`
- real project bindings
- current first-party and MCP-backed host interfaces

This plan exists to prevent vague "we tested a lot" claims. The goal is a
repeatable matrix with a clear release gate.

## Release Order

Current rule:

1. define the matrix
2. run the matrix
3. fix what fails
4. rerun
5. release

Do not release first and then hope the hardening pass is good enough.

## Scope

### Repos

- `iranti`
- `iranti-control-plane`

### Host / interface surfaces

- plain CLI
- interactive chat
- Claude Code CLI / hook path
- Codex CLI via MCP
- Codex VS Code via MCP
- Control Plane operator surfaces

### Real project surfaces

Use at least:

- one clean/simple project binding
- one real, messier project binding already used during development

The point is to test both happy paths and the kinds of state drift we
actually encounter on the working machine.

## What "rigorous" means

Rigorous here means all four of these are exercised:

1. **Correctness**
   - the behavior works
2. **Truthfulness**
   - the UI/CLI/logs/ledger describe the behavior accurately
3. **Cross-session continuity**
   - later sessions can recover the right memory and engineering lessons
4. **Cross-interface continuity**
   - work done in one host can be recovered in another host

## Test Phases

### Phase 1 - Core Iranti correctness

Validate:

- handshake
- reconvene
- attend
- observe
- query
- search
- related / related_deep / whoKnows
- write
- ingest
- checkpoint
- remember_response
- auto-remember
- session ledger reads
- handshake recovery with ledger learnings

Required outputs:

- automated test results
- list of any environment-sensitive flakes

### Phase 2 - Host lifecycle correctness

Validate:

- Claude `SessionStart`
- Claude `UserPromptSubmit`
- Claude `Stop`
- Codex CLI MCP initialize
- Codex CLI handshake / attend / checkpoint / query / search / remember_response
- Codex VS Code MCP initialize
- Codex VS Code handshake / attend / query / checkpoint
- plain CLI recall/write/checkpoint behavior
- interactive chat startup / attend / fallback behavior

Required outputs:

- one evidence note per host surface
- clear separation of:
  - host failed to initialize
  - host initialized but called the wrong tool pattern
  - Iranti returned wrong data

### Phase 3 - Cross-interface memory continuity

Validate these handoffs:

- Claude writes -> Codex retrieves
- Codex writes -> Claude retrieves
- CLI writes -> Claude retrieves
- Claude checkpoint -> Codex recovery
- Codex checkpoint -> Claude recovery

Required outputs:

- proof that the durable KB is right
- proof that the session ledger explains the handoff truthfully

### Phase 4 - Failure-path truthfulness

Validate:

- provider fallback
- missing `staff_events`
- broken MCP startup
- missing hooks
- wrong project binding
- stopped instance
- stale runtime metadata
- DB connectivity issues
- vector drift or degraded vector backend

Required outputs:

- user-facing surface says the right thing
- ledger says the right thing
- no misleading "auth issue" or "not configured" message when the real issue is elsewhere

### Phase 5 - Control Plane truthfulness and operator confidence

Validate:

- Getting Started
- Health
- Diagnostics
- Logs
- Instances page
- project binding surfaces
- Claude integration surfaces
- upgrade / restart
- stop / uninstall

Required outputs:

- CP does not overstate health
- CP does not hide degraded state
- CP does not label stopped as unreachable
- CP integration checks use live truth, not static file presence alone

## Matrix

Use this as the execution matrix.

### A. Core memory matrix

- [ ] exact lookup returns correct fact
- [ ] search returns correct fact
- [ ] attend injects correct fact when memory is needed
- [ ] attend does not inject when memory is not needed
- [ ] mandatory recall forces retrieval
- [ ] checkpoint writes shared breadcrumbs
- [ ] remember_response writes strict durable summaries
- [ ] handshake recovery includes bounded ledger learnings

### B. Host matrix

- [ ] plain CLI
- [ ] chat
- [ ] Claude Code CLI
- [ ] Codex CLI
- [ ] Codex VS Code

For each host:

- [ ] initializes cleanly
- [ ] performs handshake at startup or first safe turn
- [ ] performs attend before reply generation
- [ ] can write durable memory
- [ ] can checkpoint active progress
- [ ] can recover a fact written from another host
- [ ] emits truthful ledger rows

### C. Cross-host handoff matrix

- [ ] Claude -> Codex
- [ ] Codex -> Claude
- [ ] CLI -> Claude
- [ ] Claude -> CLI
- [ ] Codex CLI -> Codex VS Code
- [ ] Codex VS Code -> Codex CLI

### D. Control Plane matrix

- [ ] setup reflects real state
- [ ] health reflects real state
- [ ] diagnostics reflect real state
- [ ] logs hide routine probe noise by default
- [ ] instance lifecycle controls behave truthfully
- [ ] MCP integration check uses live initialize truth
- [ ] upgrade behavior is real
- [ ] stop behavior is real
- [ ] uninstall behavior is real

## Required evidence per run

Every rigorous run should leave:

- command transcript or summarized results
- any screenshots for UI truthfulness issues
- ledger query evidence where relevant
- direct KB verification where relevant
- a short pass/fail note

If a check is skipped, the reason must be recorded.

## Release gate

We can release after this phase only when:

- core automated gates pass
- host matrix is green or blocked with explicit accepted exceptions
- cross-host handoff is green
- Control Plane truthfulness pass is green
- known limitations are written down honestly

## Out of scope for this phase

Do **not** expand the ledger toward broad collaborative/non-engineering
learning yet.

For now, ledger synthesis stays focused on:

- engineering continuity
- host reliability
- memory retrieval behavior
- persistence and handoff behavior

That broader expansion is future scope after the current system is proven clean.
