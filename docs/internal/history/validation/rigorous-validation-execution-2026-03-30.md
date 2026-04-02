# Rigorous Validation Execution - 2026-03-30

## Scope

This note records live execution results against the rigorous validation plan in:

- `docs/internal/rigorous-validation-plan-2026-03-29.md`

The goal is to leave pass/fail evidence, not just intent.

## Phase 1 - Core memory block

### Commands run

```powershell
npx ts-node tests/staff-events/run_session_ledger_tests.ts
npx ts-node tests/session-recovery/run_session_recovery_tests.ts
$env:DATABASE_URL='postgresql://postgres:053435@127.0.0.1:5435/iranti_dev_db'; npx ts-node tests/memory-retrieval-regressions.ts
$env:DATABASE_URL='postgresql://postgres:053435@127.0.0.1:5435/iranti_dev_db'; npx ts-node tests/memory-lifecycle/run_memory_lifecycle_tests.ts
```

### Result

- `run_session_ledger_tests.ts`: pass
- `run_session_recovery_tests.ts`: pass
- `memory-lifecycle/run_memory_lifecycle_tests.ts`: pass
- `memory-retrieval-regressions.ts`: pass after updating one stale expectation

### Findings

1. The current canonical behavior for personal height recall resolves to `user/main`, not the older legacy `person/user` surface.
2. `tests/memory-retrieval-regressions.ts` was stale:
   - it expected `resolvedEntity = person/user`
   - it expected an injected fact key of `person/user/height`
3. Live behavior confirms the newer intended path:
   - query returns `resolvedEntity = user/main`
   - attend injects `user/main/height`

### Environment-sensitive notes

1. The installed global CLI surface currently exposes `attend`, but not `checkpoint`.
2. The installed CLI `attend` path required `--message` in practice during this run.
3. `npx prisma generate --schema prisma/schema.prisma` was needed before rerunning the failing regression, which suggests generated-client drift is something to watch during this validation pass.

### Status

- Core block status: provisional green
- Reason for "provisional": broader Phase 1 is not complete yet, but this first core-memory subset is now passing on the active validation DB

## Host lifecycle evidence - first slice

### Commands run

```powershell
iranti handshake --instance-env C:\Users\NF\.iranti-runtime\instances\iranti_dev\.env --json
iranti attend --message "Aight let's get to work" --instance-env C:\Users\NF\.iranti-runtime\instances\iranti_dev\.env --context "<validation context>" --json
npm run test:claude-hook
npm run test:mcp-smoke
```

### Result

- plain CLI handshake: pass
- plain CLI attend: pass
- plain CLI shared checkpoint via repo-local SDK: pass
- Claude hook test suite: pass after tightening checkpoint-prompt retrieval behavior
- MCP smoke test: pass

### Findings

1. The installed CLI surface still has operator drift:
   - `attend` worked reliably with `--message`
   - the installed surface did not expose a `checkpoint` command even though checkpointing is part of the intended host contract
2. Claude hook had a real contamination issue:
   - project checkpoint prompts like `The current step is ...` were injecting unrelated retrieved memory
   - fix applied in [`scripts/claude-code-memory-hook.ts`](../../scripts/claude-code-memory-hook.ts) so explicit project-operational capture prompts skip retrieval injection
3. MCP smoke remains green and still proves the stdio MCP path can initialize and serve tools under the current runtime

### Status

- First host-lifecycle slice: green
- Remaining host work still pending:
  - actual Codex CLI lifecycle evidence
  - actual Codex VS Code lifecycle evidence
  - chat lifecycle evidence

## Host lifecycle evidence - Codex CLI and Codex VS Code

### Commands run

```powershell
npx ts-node scripts/codex-setup.ts --project-env .env.iranti
npx ts-node tmp_codex_host_probe.ts codex_cli
npx ts-node tmp_codex_host_probe.ts codex_vscode
npm run build
node tmp_codex_repo_probe.cjs codex_cli
node tmp_codex_repo_probe.cjs codex_vscode
npm run test:mcp-smoke
```

### Result

- workspace Codex configs were refreshed and verified:
  - `.mcp.json`
  - `.vscode/mcp.json`
- actual configured Codex CLI MCP path: pass
- actual configured Codex VS Code MCP path: pass
- current repo build Codex CLI MCP path: pass
- current repo build Codex VS Code MCP path: pass
- MCP smoke: pass after the MCP truthfulness patch

### Findings

1. Both real Codex surfaces initialize cleanly and expose the expected MCP tool set.
2. Codex write and checkpoint attribution is now truthful:
   - `source = Codex`
   - `createdBy = codex_code`
   - shared checkpoint breadcrumb rows also use `createdBy = codex_code`
3. The remaining `staff_events` truth gap was isolated precisely:
   - the workspace configs spawn the globally installed `iranti` binary
   - that installed CLI still records direct-read events like `query_executed` with `agent_id = sdk`
4. The repo fix is valid:
   - after building current code and spawning `dist/scripts/iranti-mcp.js` directly,
   - `query_executed` rows now use `agent_id = codex_code`
   - `source = mcp`
   - `metadata.host = codex_cli` / `codex_vscode`
5. Practical implication:
   - the product fix is in the repo
   - the installed global CLI still needs to be updated before the live workspace configs fully reflect it

### Status

- Codex host evidence: green for current repo build
- Codex installed-workspace evidence: green with one known installed-CLI attribution lag on direct-read ledger rows

## Host lifecycle evidence - chat

### Commands run

```powershell
$env:LLM_PROVIDER='mock'; @("How tall am I?","/exit") | node dist/scripts/iranti-cli.js chat --agent matrix_chat
node tmp_chat_harness.cjs
```

### Result

- chat startup: pass
- chat handshake via API: pass
- chat pre-reply `attend()`: pass
- mandatory personal-height recall: pass
- clean interactive harness exit: pass
- piped stdin `/exit` path: noisy, but not representative of the normal interactive path

### Findings

1. Chat startup does a real API-side handshake:
   - `handshake_completed`
   - `agent_id = matrix_chat_harness`
   - `source = api`
   - `metadata.host = api_server`
2. Normal message turns do a real API-side pre-reply attend:
   - `mandatory_recall_forced`
   - `memory_injected`
   - `attend_completed`
   - `observe_completed`
3. The first piped stdin run exited with `readline was closed`, but the child-process harness reproduced the same lifecycle cleanly and exited with code `0`.
   - treat the first result as a harness / TTY artifact, not a normal chat `/exit` regression
4. Chat observability still has a gap:
   - the API-side memory lifecycle is visible in `staff_events`
   - but successful local chat reply generation does not currently leave a distinct `source = chat` / `host = plain_chat` success row in the ledger during this validation path
5. Chat process DB-backed event emission needed a fix:
   - [`src/chat/index.ts`](../../src/chat/index.ts) now initializes and disconnects the local DB client when `DATABASE_URL` is available, so local staff-event emission is at least wired correctly for chat-owned events

### Status

- Chat lifecycle row: green with an observability limitation noted

## Installed CLI rollout recheck

### Commands run

```powershell
npm install -g .
node tmp_codex_global_recheck.cjs codex_cli
node tmp_codex_global_recheck.cjs codex_vscode
```

### Result

- installed global CLI rollout: pass

### Findings

1. After reinstalling the current repo globally, the actual workspace Codex paths now reflect the fix too.
2. Verified on the live workspace-configured MCP paths:
   - `query_executed`
   - `agent_id = codex_code`
   - `source = mcp`
   - `metadata.host = codex_cli` / `codex_vscode`
3. The earlier installed-CLI attribution lag is now cleared on this machine.

### Status

- Installed global CLI now matches the current repo fix for Codex direct-read ledger attribution

## Cross-host truthfulness fix
- Implemented a Claude MCP identity fix by writing an explicit iranti server into .claude/settings.local.json with IRANTI_MCP_HOST=claude_code and removing iranti from enabledMcpjsonServers.
- Implemented a generic MCP protocol safeguard: query/search/related/related_deep/who_knows now surface protocolWarning and emit audit host_failure rows when used before iranti_attend.
- Focused validations passed: npm run build, tests/mcp/smoke_test.ts, tests/runtime-lifecycle/run_setup_upgrade_tests.ts.
- A live Claude retest is still required to confirm the codex_code identity leak is gone in a fresh Claude session.

## Claude host-override hardening
- Hardened `scripts/iranti-mcp.ts` so the handshake `host` argument becomes the session's authoritative MCP host for agent resolution and ledger context.
- For `host = claude_code`, MCP now prefers `IRANTI_CLAUDE_AGENT_ID`, then `IRANTI_AGENT_ID`, before any leaked `IRANTI_MCP_DEFAULT_AGENT`.
- Added `Iranti.setSessionLedgerContext(...)` so the MCP layer can update source/host/agent truth after startup instead of freezing stale env defaults forever.
- Added a focused MCP smoke regression that reproduces the real leak shape: Codex-flavored startup env with a Claude handshake host override.
- Focused validation passed after a sequential rebuild:
  - `npm run build`
  - `npx ts-node tests/mcp/smoke_test.ts`
- Next live check:
  - fresh Claude session in this repo
  - `iranti_handshake(... host: "claude_code")` should no longer return `agentId: codex_code`

## Exact entity targeting hardening
- Attendant now treats exact `entityType/entityId` mentions in the user's latest message as more authoritative than host-supplied entity hints.
- This fixes the live Claude failure mode where a bad hint like `project/iranti/codex_claude_handoff_2026_03_30` could pull attention toward nearby validation-note entities instead of the exact `project/codex_claude_handoff_2026_03_30` target.
- Added a regression in `tests/memory-retrieval-regressions.ts` for the bad-hint shape.
- Focused validation passed with a targeted ts-node check that wrote a unique project fact, supplied the wrong `project/iranti/...` hint, and still recovered the exact `project/.../status` fact from the user message.
- Note: the broader `tests/memory-retrieval-regressions.ts` run is currently tripping over an unrelated DB-side agent-registry upsert issue before reaching the new assertion, so the targeted validation is the trustworthy signal for this slice.
## DB connection hygiene - Claude hook
- Root cause narrowed to short-lived first-party processes not releasing DB resources cleanly enough under repeated hook usage.
- Implemented explicit DB teardown in `scripts/claude-code-memory-hook.ts` so success and error paths now both flush staff events and call `disconnectDb()` before exit.
- Added `allowExitOnIdle: true` in `src/library/client.ts` so short-lived CLI/hook/test processes do not stay alive solely because the pg pool keeps idle sockets referenced.
- Focused validation passed:
  - `npm run build`
  - `npm run test:claude-hook`
  - repeated local Stop-hook loop (`8` invocations) completed without reproducing `53300 too many clients already`
- Important remaining environment finding:
  - the local machine still had about `59` live `iranti-mcp` node processes and about `96` idle postgres clients after the fix
- so the original `53300` was likely a combination of hook cleanup gaps plus broader host/session process accumulation
- Next cleanup target after this slice:
  - understand why so many `iranti-mcp` processes remain alive and whether that is expected host behavior, stale sessions, or another lifecycle gap

## MCP stdio shutdown hardening
- Root cause for the persistent MCP parent/child pairs was narrower than attendant-state cleanup: the stdio MCP server only listened for stdin `data` and `error`, so when the host side closed the pipe the child could stay idle instead of exiting, and the launcher parent would wait forever.
- Hardened `scripts/iranti-mcp.ts` so the MCP process now shuts down cleanly on:
  - stdin `end`
  - stdin `close`
  - stdout `EPIPE`
  - `SIGINT` / `SIGTERM`
- The shutdown path now also:
  - flushes staff events
  - disconnects the DB client
  - clears in-process attendant instances before exit
- Added a regression in `tests/mcp/smoke_test.ts` that exercises the real CLI wrapper path (`iranti ... mcp`) and asserts the wrapper exits when stdin closes.
- Validation:
  - `npm run build`
  - controlled wrapper probe against an isolated local DB (`5436`) exited `0` five times in a row
  - MCP smoke test passed when the wrapper-exit regression was pointed at the isolated DB using `IRANTI_MCP_WRAPPER_TEST_DATABASE_URL`
- Failure-truthfulness note:
  - the wrapper-only regression had to run outside the bound project env because `.env.iranti` auto-discovers the instance env from repo ancestors and would otherwise snap the child back to the overloaded shared runtime DB
  - the live bound-runtime probe no longer left an extra stuck `iranti-mcp` pair behind during validation (`before=40 after=40`)

## Safe stale-MCP cleanup rule
- Windows process-tree characterization showed three buckets:
  - `attached_claude`: launcher/server chains whose great-grandparent is `claude.exe`
  - `attached_codex`: launcher/server chains whose great-grandparent is `codex.exe`
  - stale launcher/server pairs where the `iranti.js mcp` launcher has no live host ancestor left
- A safe one-time cleanup pass removed only the stale bucket:
  - first stale launcher pairs with missing launcher parent
  - then stale child/server processes whose parent launcher still existed but had no grandparent host
- Results after targeted cleanup:
  - remaining launchers: `2`
  - remaining `iranti-mcp` children: `6`
  - remaining live-looking chains: `2` Claude-attached, `4` Codex-attached
  - idle postgres clients dropped from `96` -> `49` -> `32`
- Operational rule:
  - safe to kill: `iranti-mcp` child + `iranti.js mcp` launcher pairs that have no live host ancestor
  - do not kill by default: chains still rooted in `claude.exe`, `codex.exe`, or another clearly live host process

## Productized operator command
- Added a first-party CLI surface:
  - `iranti mcp cleanup [--dry-run] [--json]`
- Behavior:
  - Windows-only safe cleanup path for stale MCP launcher/server residue
  - reports but does not kill chains still attached to `claude.exe` or `codex.exe`
  - protects the current CLI process family from self-termination
- Validation:
  - `npm run build`
  - `npx ts-node tests/runtime-lifecycle/run_setup_upgrade_tests.ts`
  - `npx ts-node scripts/test-contracts.ts`
