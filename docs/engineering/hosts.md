# AI host profiles

**Status:** draft — researched June 2026, re-verify quarterly (this landscape changes monthly)
**[Back to map](../MAP.md)**

---

## Purpose

iranti's value proposition is one memory across every AI host. That only works if iranti actually integrates with every AI host. This document profiles each major host: what MCP support it has today, how iranti plugs in, whether iranti can inject instructions so the host calls `iranti_attend` before responding, and the concrete steps to wire it up.

Every claim that depends on a vendor's current product state is cited. Treat uncited claims as design reasoning; treat cited claims as snapshots of June 2026 that will rot.

**Two integration problems per host.** Wiring iranti to a host always splits into:

1. **Tool access** — can the host call `iranti_attend` / `iranti_write` at all? (MCP transport, GPT Actions, API function calling)
2. **Behavioral wiring** — will the host call `iranti_attend` *before responding* and `iranti_write` *after learning something*? This needs instruction injection (system prompt, custom instructions, rules files) or, better, deterministic hooks.

A host with tool access but no behavioral wiring gives you a memory the model only consults when it feels like it. Hosts with hooks (Claude Code, Cursor) can make the loop deterministic. Everywhere else, we rely on instructions plus well-written tool descriptions.

---

## Capability matrix

| Host | MCP transport | Instruction injection | Auto tool-calling | Feasibility |
|---|---|---|---|---|
| Claude Code (CLI) | stdio + HTTP + SSE | CLAUDE.md, hooks (deterministic), skills | Yes — hooks can force `attend` | **Full** (already running iranti v0) |
| Claude Desktop | stdio (local config + .mcpb) + remote HTTP connectors | Profile instructions, project instructions, skills | Yes — instruction-driven | **Full** — works with Phase 1 stdio today |
| claude.ai (web) | Remote HTTP only (OAuth 2.1) | Profile instructions, project instructions, skills | Yes — instruction-driven | **Full once HTTP ships** — blocked on transport, not on Claude |
| Claude mobile | Remote HTTP only (configured via web, syncs) | Profile instructions (sync from web) | Yes — instruction-driven | **Full once HTTP ships** — free rider on the claude.ai connector |
| ChatGPT (web + desktop) | Remote HTTP only; dev mode beta; write tools gated by plan | Custom instructions, project instructions | Partial — dev mode may disable memory; model discretion | **Partial** — read path solid, write path plan-gated |
| OpenAI Codex (CLI/IDE) | stdio + Streamable HTTP | AGENTS.md | Yes — instruction-driven | **Full** |
| OpenAI Codex (cloud) | Not shipped for cloud tasks | AGENTS.md (repo) | No | **Not currently possible** |
| Gemini CLI | stdio + SSE + Streamable HTTP | GEMINI.md, extensions | Yes — instruction-driven | **Full** |
| Gemini (web/app) | None for consumers (partner-only Spark connectors) | Saved Info / personal context | No third-party tools | **Not currently possible** (consumer); partial via Gemini Enterprise |
| DeepSeek (web) | None native; third-party browser extension only | System-prompt field via extension only | No | **Workaround-only** |
| DeepSeek (API) | n/a — OpenAI-compatible function calling | Full system prompt control | Yes, in your own harness | **Full** (via generic adapter) |
| Cursor | stdio + SSE + Streamable HTTP | Rules + hooks (deterministic) | Yes — hooks can force `attend` | **Full** |
| Windsurf | stdio + SSE + Streamable HTTP | global_rules.md + workspace rules | Yes — instruction-driven | **Full** |
| VS Code / GitHub Copilot | stdio + HTTP/SSE (agent mode) | copilot-instructions.md, instruction files | Yes — agent mode only | **Full** |
| Generic API harness | n/a — function calling or vendor MCP-client features | Full system prompt control | Yes — you own the loop | **Full** (fallback for everything else) |

Reading the matrix: **8 of 15 surfaces work with Phase 1 stdio alone** — and they happen to be every developer-facing tool. Everything consumer-facing (claude.ai, Claude mobile, ChatGPT, Gemini app) requires a remote HTTP server. That asymmetry drives the rollout order and the transport recommendation at the bottom of this document.

---

## Host profiles

### Claude Code (CLI)

**MCP support.** Native and the most complete of any host: stdio, Streamable HTTP, and SSE transports; project-scoped (`.mcp.json`), user-scoped, and local-scoped server config. MCP tools appear as `mcp__<server>__<tool>` and are matchable in hooks ([docs](https://code.claude.com/docs/en/hooks)).

**Behavioral wiring.** The strongest of any host, because it is deterministic rather than advisory:
- **Hooks** fire at fixed lifecycle points — `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` — and can inject context or invoke MCP tools directly (`mcp_tool` handler type). A `SessionStart`/`UserPromptSubmit` hook can call `iranti_attend` and inject the result into context *before the model sees the prompt*. No reliance on model compliance.
- **CLAUDE.md** carries standing instructions ("call `iranti_write` when you learn a durable fact").
- One known caveat: `SessionStart` hooks can fire while MCP servers are still connecting and get a "server not connected" error on first run ([hooks reference](https://thepromptshelf.dev/blog/claude-code-hooks-complete-reference-2026/)) — hooks that call iranti at session start need a retry or graceful-skip.

**Limitations.** None material. This is the reference host.

**Integration path.**
1. Add iranti to `.mcp.json` (project) or user scope: `{ "mcpServers": { "iranti": { "command": "node", "args": ["<path>/dist/mcp/server.js"] } } }`.
2. Add a `UserPromptSubmit` (or `SessionStart`) hook that calls `iranti_attend` with entity hints derived from cwd/project, injecting the returned facts and rules as context.
3. Add a CLAUDE.md section instructing the agent to call `iranti_write` after learning durable facts and `iranti_write_rule` for behavioral preferences.
4. Optionally add a `Stop` hook to write a checkpoint at end of turn.

**Feasibility: Full.** The user already runs iranti v0 here via hooks + MCP; Phase 1 formalizes it.

---

### Claude Desktop

**MCP support.** Two distinct paths:
- **Local stdio** via `claude_desktop_config.json` — Claude Desktop launches the server as a child process ([help center](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)). This works with Phase 1 as-is.
- **Desktop Extensions (.mcpb bundles)** — a zip with `manifest.json` + the server, drag-and-drop install, no Node/config editing required by the end user. Claude Desktop ships its own Node runtime ([Anthropic engineering](https://www.anthropic.com/engineering/desktop-extensions), [MCPB spec](https://github.com/modelcontextprotocol/mcpb)). The old `.dxt` extension was renamed `.mcpb`; both still work ([help center](https://support.claude.com/en/articles/12922929-building-desktop-extensions-with-mcpb)).
- **Remote custom connectors** (Settings → Connectors) over Streamable HTTP + OAuth — but note these connect *from Anthropic's cloud*, not from the local machine ([help center](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)). Irrelevant for Phase 1; relevant once iranti has a hosted endpoint.

Claude's official remote transport is Streamable HTTP (MCP protocol 2025-11-25); SSE is deprecated.

**Behavioral wiring.** No hooks. Three instruction layers, all advisory: account-wide "Instructions for Claude" (Settings → Profile), per-Project instructions, and Skills ([personalization docs](https://support.claude.com/en/articles/10185728-understanding-claude-s-personalization-features)). Profile instructions are the right place for the iranti protocol ("at the start of every conversation, call `iranti_attend` before answering; store durable facts with `iranti_write`"). Claude models follow this reliably in practice, but it is model discretion, not a guarantee.

**Limitations.** The .mcpb path requires the user's machine to reach the local PostgreSQL instance — fine for the single-user phases, but it means "install the extension" is really "install the extension *and run the database*" until iranti is hosted. Bundling a fallback to SQLite or an embedded DB is out of scope for now; document Docker Compose as the prerequisite.

**Integration path.**
1. Phase 1: add a `claude_desktop_config.json` entry pointing at the iranti stdio server (same JSON as Claude Code).
2. Add the iranti protocol to profile instructions (and per-project instructions where relevant).
3. Phase 1.x polish: package the server as a `.mcpb` bundle (manifest + bundled server, user-config field for `DATABASE_URL`) so install is drag-and-drop.
4. Later, when hosted: register the remote connector instead, and the same account's web/mobile/desktop all share it.

**Feasibility: Full.** Works with Phase 1 stdio today; .mcpb makes it civilian-friendly.

---

### claude.ai (web)

**MCP support.** Remote MCP only, via **custom connectors**: Settings → Connectors → Add custom connector, with the server's HTTPS URL. The connection originates from Anthropic's cloud infrastructure — `localhost` is unreachable; the server must be on the public internet ([help center](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [build docs](https://support.claude.com/en/articles/11503834-build-custom-connectors-via-remote-mcp-servers)). Transport is Streamable HTTP. Auth is OAuth 2.1 with PKCE; Claude supports Dynamic Client Registration, Client ID Metadata Documents, or manually-entered client credentials ([connector OAuth guide](https://sunpeak.ai/blogs/claude-connector-oauth-authentication/)). Unauthenticated connectors are also allowed if the server opts out of auth — acceptable for a personal deployment behind a secret URL, not acceptable for multi-user.

Availability: custom connectors are available on free, Pro, Max, Team, and Enterprise plans; free is limited to one custom connector ([connectors overview](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities)).

**Behavioral wiring.** Same as Claude Desktop: profile instructions, project instructions, skills. All advisory, all reliable in practice with Claude models.

**Limitations.** Entirely blocked on iranti having an HTTP transport and a public endpoint. OAuth 2.1 + DCR is real implementation work (this is the bulk of "consumer MCP tokens" currently scheduled in Phase 5).

**Integration path.**
1. Ship iranti's Streamable HTTP transport (see [Transport implications](#transport-implications)).
2. Deploy to a public HTTPS endpoint (small VPS / Fly.io / Railway, or a Cloudflare Tunnel in front of the home machine for the single-user phase).
3. Implement OAuth 2.1 + PKCE with DCR (or run unauthenticated behind a long random path for personal use, explicitly documented as such).
4. Add the connector at claude.ai → Settings → Connectors.
5. Add the iranti protocol to profile instructions.

**Feasibility: Full once HTTP transport ships.** Nothing on Claude's side is missing; the blocker is entirely iranti's Phase 1 stdio-only decision.

---

### Claude mobile apps (iOS / Android)

**MCP support.** Remote MCP connectors work on mobile, but cannot be *configured* there — you add the connector on claude.ai web and it syncs automatically to mobile and desktop ([setup guide](https://dev.to/zhizhiarv/how-to-set-up-remote-mcp-on-claude-iosandroid-mobile-apps-3ce3), [help center](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities)). No local stdio option exists or will plausibly ever exist on mobile.

**Behavioral wiring.** Profile instructions sync from the account, so the iranti protocol set up for claude.ai applies on mobile for free.

**Limitations.** Pure downstream of claude.ai: same HTTP/OAuth requirements, zero extra work, zero extra control.

**Integration path.**
1. Complete the claude.ai integration above.
2. There is no step 2. The connector and instructions sync.

**Feasibility: Full once HTTP ships.** Mobile is the single strongest argument for the hosted endpoint: it is where "your memory follows you" stops being a developer feature and becomes a product.

---

### ChatGPT (web + desktop)

**MCP support.** Remote MCP only — HTTPS endpoints; no local stdio on web *or* desktop ([OpenAI MCP docs](https://developers.openai.com/api/docs/mcp), [community confirmation](https://www.usecarly.com/blog/chatgpt-mcp/)). Connectors were renamed "apps" in December 2025 ([help center](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt)). Three tiers matter:

| Tier | What it allows | Who gets it |
|---|---|---|
| Deep research / company knowledge connectors | Read-only; server **must** expose tools named exactly `search` and `fetch` matching OpenAI's schema | Plans with connectors enabled |
| Developer mode custom connectors (beta) | Full tool lists visible, but **read/fetch-only for Plus and Pro individual users** | Plus, Pro, Business, Enterprise, Edu ([help center](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta)) |
| Full write-capable MCP | Write/modify tools callable | Business / Enterprise / Edu workspaces only |

Two further constraints reported as of mid-2026: custom connectors have regional gaps (EEA, Switzerland, UK exclusions have applied to some tiers — verify current state before promising anything to EU users), and enabling developer mode can disable ChatGPT's own memory in those chats ([developer mode guide](https://medium.com/@alexeylark/chatgpt-custom-mcp-connectors-with-developer-mode-d791fde17d25)) — which is ironically favorable for iranti (no competing memory) but signals OpenAI treats third-party tools as a trust boundary.

**The write problem.** `iranti_attend` is a read — it fits the read-only tier. `iranti_write` is a write — for Plus/Pro individuals it is blocked in developer mode. Workarounds, in order of preference:
1. **Custom GPT with Actions**: a GPT with an OpenAPI spec pointing at an iranti HTTP API can call write endpoints on any paid plan (with per-call user confirmation). Cost: users must talk to the iranti GPT rather than vanilla ChatGPT, and GPTs don't combine with the user's other custom GPTs.
2. **Read-only on ChatGPT, write elsewhere**: ChatGPT gets `iranti_attend` only; facts are written from hosts with full support. Memory still *follows* the user to ChatGPT; it just doesn't *learn* there. This is a legitimate degraded mode and is easy to ship.
3. Business plan users get everything.

**Behavioral wiring.** Custom instructions (Settings → Personalization) and per-project instructions are the only injection points. Advisory only, and GPT models are observably less consistent than Claude at "always call this tool first." Expect the attend rate to be imperfect; tool descriptions ("call this before answering anything about the user") carry real weight here.

**Limitations summary.** Remote-only; write-gated by plan; deep-research path requires renaming/aliasing tools to `search`/`fetch`; regional availability gaps; instruction compliance weaker than Claude.

**Integration path.**
1. Ship HTTP transport + public endpoint (same prerequisite as claude.ai).
2. Expose `search` and `fetch` tool aliases conforming to OpenAI's connector schema (thin wrappers over `iranti_attend`/fact retrieval) so iranti works as a deep-research/company-knowledge connector *without* developer mode.
3. For full tooling: user enables developer mode (Settings → Apps & Connectors → Advanced) and adds the connector URL; document that writes need a Business workspace.
4. Optionally publish an "iranti" custom GPT whose Actions hit the iranti HTTP API, as the write path for Plus/Pro users.
5. Add the iranti protocol to ChatGPT custom instructions.

**Feasibility: Partial.** The read path (memory injection) is achievable for all paid users; the write path is plan-gated, so the full loop only closes for Business/Enterprise users or via the custom-GPT workaround.

---

### OpenAI Codex (CLI, IDE extension, cloud)

**MCP support (CLI + IDE).** Native: stdio servers and Streamable HTTP servers, configured in `~/.codex/config.toml` (or project-scoped `.codex/config.toml` in trusted projects), managed with `codex mcp add`. CLI and IDE extension share the config ([Codex MCP docs](https://developers.openai.com/codex/mcp), [config reference](https://developers.openai.com/codex/config-reference)). OAuth for remote servers is supported, including fixed callback ports.

**MCP support (cloud).** Codex Cloud tasks do not run user MCP servers — long planned, not shipped, with cited blockers around secure tool proxying and credential forwarding ([Composio guide](https://composio.dev/content/how-to-mcp-with-codex)). Re-check quarterly.

**Behavioral wiring.** `AGENTS.md` is the instruction file Codex reads per-project (plus global `~/.codex/AGENTS.md`). Advisory. No hook system comparable to Claude Code's.

**Limitations.** No hooks means no deterministic attend; cloud tasks are out of reach entirely.

**Integration path.**
1. `codex mcp add iranti -- node <path>/dist/mcp/server.js` (or the equivalent `config.toml` block).
2. Add the iranti protocol to `~/.codex/AGENTS.md` (global) and project `AGENTS.md`.

**Feasibility: Full** for CLI/IDE with Phase 1 stdio. **Not currently possible** for Codex cloud.

---

### Gemini CLI

**MCP support.** Native: stdio, SSE, and Streamable HTTP via `mcpServers` in `settings.json`; OAuth supported for remote servers ([Gemini CLI MCP docs](https://geminicli.com/docs/tools/mcp-server/)). **Extensions** bundle an MCP server + context file + custom commands into one installable unit ([extensions docs](https://google-gemini.github.io/gemini-cli/docs/extensions/)) — the Gemini equivalent of a .mcpb bundle.

**Behavioral wiring.** `GEMINI.md` context files (global `~/.gemini/GEMINI.md` and per-project), loaded into every prompt. An iranti extension can ship its own context file (`contextFileName` in the extension manifest), which means the iranti protocol instructions install *with* the server — nice property no other host offers as cleanly except Claude Code plugins.

**Limitations.** Advisory instructions only; Gemini models' tool-calling discipline is decent in agent mode but unverified for "always attend first" — needs empirical testing.

**Integration path.**
1. Add iranti to `settings.json` `mcpServers` (stdio command).
2. Add the iranti protocol to `~/.gemini/GEMINI.md`.
3. Phase 1.x: publish a Gemini CLI extension bundling the server config + context file for one-command install (`gemini extensions install`).

**Feasibility: Full** with Phase 1 stdio.

---

### Gemini (web + consumer app)

**MCP support.** None that iranti can use. As of Google I/O 2026 (May 19), the Gemini app's new Spark agent runtime shipped with exactly three MCP connectors — Canva, OpenTable, Instacart — all private partnerships; there is no public connector registration, no submission form, no policy page ([Spark connector analysis](https://findskill.ai/blog/gemini-spark-mcp-connector-roadmap/), [Gemini Apps community threads](https://support.google.com/gemini/thread/364779684/does-gemini-chat-support-mcp-custom-connectors?hl=en)). **Gemini Enterprise** (Google Cloud) does support custom MCP server data stores ([Cloud docs](https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server)), but that is an org-level Cloud product, not the consumer app.

**Behavioral wiring.** "Saved Info" / personal context holds standing instructions ([Gemini Apps help](https://support.google.com/gemini/answer/16598625)), but with no tool to call, instructions cannot close the loop.

**Limitations.** This is the biggest gap in iranti's "every host" story. Google is signaling MCP intent (Spark, Enterprise, CLI) but has not opened the consumer surface.

**Integration path (today).**
1. Nothing direct. Watch for a Spark connector submission process — that is the trigger to act.
2. Meanwhile: Gemini API function-calling via the generic adapter (below) covers Gemini *models*, and Gemini CLI covers Gemini *for developers*.
3. If/when targeting orgs: Gemini Enterprise custom MCP data store using the same hosted HTTP endpoint built for claude.ai.

**Feasibility: Not currently possible** (consumer app). Partial via Gemini Enterprise; full via Gemini CLI and API.

---

### DeepSeek (web + API)

**Web (chat.deepseek.com).** No native plugin, connector, or MCP support in the consumer chat. The only path is third-party browser extensions such as DeepSeek++, which bolt MCP tools and memory onto the web UI ([DeepSeek++ repo](https://github.com/zhu1090093659/deepseek-pp)) — a workaround we can document but should not depend on or recommend as a supported path.

**API.** Strong. DeepSeek's API is OpenAI-compatible with function calling ([API docs](https://api-docs.deepseek.com/guides/function_calling)); DeepSeek V4 (April 2026) supports parallel tool calls at scale and works with any OpenAI-compatible MCP client harness ([V4 agent guide](https://lushbinary.com/blog/deepseek-v4-ai-agents-function-calling-mcp-guide/)). Any agent framework that speaks MCP (LangChain, OpenAI Agents SDK, custom harness) can connect DeepSeek models to the iranti stdio server today.

**Behavioral wiring.** Full system-prompt control at the API level; none on the consumer web app.

**Integration path.**
1. Web: document the DeepSeek++ extension as an unsupported community workaround; revisit if DeepSeek ships native connectors.
2. API: covered by the generic adapter below — DeepSeek is just an OpenAI-compatible endpoint.

**Feasibility: Workaround-only** (web); **Full** (API, via generic adapter).

---

### Cursor

**MCP support.** Native: stdio, SSE, and Streamable HTTP; global `~/.cursor/mcp.json` and project `.cursor/mcp.json`, merged ([Cursor MCP docs](https://cursor.com/docs/mcp)). Note Cursor's practical cap on simultaneously active tools — keep iranti's tool count small (Phase 1's four tools are fine).

**Behavioral wiring.** Two layers, one of them deterministic:
- **Rules** (`.cursor/rules/`, global rules) — advisory instructions, same role as CLAUDE.md.
- **Hooks** (since 1.7): `beforeSubmitPrompt`, `beforeMCPExecution`, `afterFileEdit`, `stop`, configured in JSON, scripts receive structured stdin and can inject an `agent_message` into context ([Cursor hooks docs](https://cursor.com/docs/hooks), [deep dive](https://blog.gitbutler.com/cursor-hooks-deep-dive)). A `beforeSubmitPrompt` hook can run `iranti_attend` out-of-band (the hook script can hit the iranti library or a local HTTP shim directly) and inject memory before the model responds — the same deterministic pattern as Claude Code, with the caveat that Cursor hooks can't invoke MCP tools natively, so the hook script talks to iranti itself.

**Integration path.**
1. Add iranti to `~/.cursor/mcp.json` (stdio).
2. Add the iranti protocol to global Cursor rules.
3. Optional hardening: a `beforeSubmitPrompt` hook script that queries iranti directly and injects facts/rules as `agent_message`.

**Feasibility: Full** with Phase 1 stdio.

---

### Windsurf

**MCP support.** Native in Cascade: stdio, SSE, and Streamable HTTP ([Windsurf MCP docs](https://docs.windsurf.com/plugins/cascade/mcp)); config via Settings → Cascade → MCP Servers or `~/.codeium/windsurf/mcp_config.json`; built-in MCP marketplace. Hard cap of 100 active tools across all servers — not a problem at iranti's size.

**Behavioral wiring.** `global_rules.md` (account-wide) and workspace rules files — advisory only; no hook system comparable to Cursor/Claude Code as of June 2026.

**Integration path.**
1. Add iranti as a custom MCP server (stdio command) in Windsurf settings.
2. Add the iranti protocol to `global_rules.md`.

**Feasibility: Full** with Phase 1 stdio (instruction-driven attend only).

---

### VS Code / GitHub Copilot (agent mode)

**MCP support.** GA: MCP servers configured in `.vscode/mcp.json` (project) or user-level, root key `servers`, stdio and HTTP/SSE transports ([GitHub docs](https://docs.github.com/en/copilot/concepts/context/mcp), [GitHub blog](https://github.blog/news-insights/product-news/github-copilot-agent-mode-activated/)). Critical constraint: **MCP tools only exist in agent mode** — Ask and Edit modes never see them. Visual Studio (full IDE) gained the same support ([VS blog](https://devblogs.microsoft.com/visualstudio/agent-mode-is-now-generally-available-with-mcp-support/)).

**Behavioral wiring.** `.github/copilot-instructions.md` plus scoped `*.instructions.md` files — advisory. No hooks.

**Limitations.** Agent-mode-only means iranti is invisible in the inline-chat flows many Copilot users live in; VS Code also has a per-request tool budget (128 tools), so users with many MCP servers may toggle iranti off.

**Integration path.**
1. Add iranti to `.vscode/mcp.json` (`"servers": { "iranti": { "type": "stdio", "command": "node", "args": [...] } }`) or user config.
2. Add the iranti protocol to `.github/copilot-instructions.md` (project) and user instructions.
3. Document "agent mode only" prominently.

**Feasibility: Full** with Phase 1 stdio, scoped to agent mode.

---

### Generic API-level integration (fallback for everything)

For any host or app with function calling but no MCP UI — or for products *built on* the APIs — iranti integrates at the API layer:

- **Direct function calling.** Expose iranti's four tools as JSON-schema function definitions; the harness executes them against the iranti library or HTTP API. Works with OpenAI, Anthropic, Gemini, DeepSeek, and every OpenAI-compatible endpoint.
- **Vendor-side MCP execution.** OpenAI's Responses API can call remote MCP servers server-side (the `mcp` tool type) ([OpenAI tools/connectors docs](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)); Anthropic's API has an equivalent MCP connector feature; both require iranti's hosted HTTP endpoint. Agent SDKs (OpenAI Agents SDK, Claude Agent SDK, LangChain, Vercel AI SDK) all speak MCP client-side and can spawn the stdio server directly.
- **Behavioral wiring** is trivial here: the developer owns the system prompt and the loop, so `iranti_attend` can be called unconditionally before every model invocation — the deterministic pattern, no model discretion involved.

A thin published adapter (`@iranti/openai` or just documented snippets) covering "call attend, prepend result to system prompt, register write as a tool" makes iranti available to every custom agent regardless of what the host UIs do.

**Feasibility: Full.** This is also the escape hatch for Gemini consumer and DeepSeek web: the models are reachable even where the first-party UIs are closed.

---

## Recommended rollout order

Ordered by feasibility × user value, given Phase 1 is stdio-only:

| Wave | Hosts | Why | Needs |
|---|---|---|---|
| **1 — now (Phase 1)** | Claude Code, Claude Desktop | Already proven (v0 on Claude Code); Claude Desktop is the same config file format and the same models; hooks give deterministic attend on Claude Code | Phase 1 stdio server, hook scripts, CLAUDE.md/profile-instructions templates |
| **2 — Phase 1.x (config + docs only)** | Cursor, Windsurf, VS Code/Copilot, Gemini CLI, Codex CLI | Zero server work — the same stdio binary with five different config snippets and five instruction-file templates. One docs page ("Install iranti on your editor") covers all five | Config snippets, rules/instructions templates, Cursor hook script |
| **3 — packaging polish** | Claude Desktop `.mcpb` bundle, Gemini CLI extension | Turns "edit JSON" into one-click/one-command install; widens the audience beyond people who edit config files | MCPB manifest, extension manifest; decide how the DB prerequisite is presented |
| **4 — remote (needs HTTP transport)** | claude.ai web → Claude mobile → ChatGPT | Highest *user* value of the whole list — this is where memory follows you to your phone. claude.ai first (cleanest MCP implementation, syncs to mobile for free), ChatGPT second (add `search`/`fetch` aliases + document the write gate; optional custom GPT for writes) | Streamable HTTP transport, public deployment, OAuth 2.1 + PKCE (or documented unauthenticated personal mode), `search`/`fetch` alias tools |
| **5 — watch list** | Gemini consumer (Spark), DeepSeek web, Codex cloud | All blocked on vendor decisions, not on iranti. Re-check quarterly; Spark opening a connector registry is the trigger event | The wave-4 hosted endpoint is the prerequisite for all of them, so being ready costs nothing extra |
| **Continuous** | Generic API adapter | Cheap, unlocks every custom agent, and serves as iranti's own integration-test harness | Documented function-calling snippets per provider |

The deliberate shape: waves 1–3 are nearly free (one stdio server, N config files) and cover the entire developer-tool market. Wave 4 is one substantial engineering effort (HTTP + auth + hosting) that unlocks the entire consumer market at once.

---

## Transport implications

**What stdio covers.** Claude Code, Claude Desktop, Cursor, Windsurf, VS Code/Copilot, Gemini CLI, Codex CLI — every developer-facing host supports launching a local stdio MCP server. Phase 1's stdio-only decision is correct for this segment and nothing here pressures it.

**What requires remote Streamable HTTP.** claude.ai, Claude mobile, ChatGPT (all tiers), Codex cloud (when it ships), Gemini Enterprise, and vendor-side API MCP execution. These are not "HTTP on localhost" — Anthropic and OpenAI both connect **from their cloud**, so iranti must be publicly reachable over HTTPS with real auth. There is no tunnel-free local workaround for any consumer surface.

**The bridges don't help here.** `mcp-proxy`-style stdio→HTTP bridges ([mcp-proxy](https://github.com/sparfenyuk/mcp-proxy), [mcp-bridge](https://github.com/brrock/mcp-bridge)) can expose the Phase 1 server over HTTP without code changes, and a Cloudflare Tunnel can make it public. That is a viable *personal* stopgap for claude.ai (single user, secret URL), and worth documenting as such — but it is not a product answer: no OAuth, fragile, and one process per user.

**Recommendation: split HTTP transport out of Phase 5 and pull it forward.** The current plan bundles HTTP transport with multi-user SaaS (auth, tenancy, metering) in Phase 5. The research says these are separable, and the most valuable surfaces (mobile, web, ChatGPT) need only the first half:

1. **Phase 2.x or 3 — single-user HTTP transport.** Add Streamable HTTP alongside stdio in the MCP server (the SDK supports serving both from the same tool definitions). Auth = one static bearer token from an env var. Deployment = user-hosted (VPS/Fly/tunnel). This alone unlocks claude.ai + Claude mobile for the project's own user and any self-hoster, and the `tenantId` seam means no schema work is needed.
2. **Phase 5 — multi-user hosting.** OAuth 2.1 + PKCE + DCR (required for frictionless claude.ai/ChatGPT connectors at scale), tenancy, metering — unchanged in scope, but no longer gating the transport itself.

Supporting reasons:
- The `surface` enum already anticipates `chatgpt`, `gemini`, `web_ui` writes — those writes can only ever arrive over HTTP. Stdio-only Phases 1–4 would mean the cross-platform provenance system has nothing to record from non-Claude consumer hosts for a year of roadmap.
- ChatGPT's deep-research tier needs `search`/`fetch` tool aliases — a small Phase 1-compatible design decision (name two extra tools now or alias later) that costs nothing if known early.
- Concurrency caution: Phase 1 is explicitly single-instance, and a remote endpoint invites simultaneous sessions (phone + laptop). Single-user HTTP should therefore land *after* Phase 2's write-serialization work, not before — which is why the recommendation is "Phase 2.x/3", not "Phase 1.x".

**One-line summary:** stdio gets iranti onto every desk; HTTP gets it into every pocket — and HTTP only needs a bearer token, not the whole SaaS, so it should not wait for Phase 5.
