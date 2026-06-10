# Integration plans

**Status:** draft — June 2026. Builds on [hosts.md](hosts.md) (the capability survey); this document is the *build plan* per integration.
**[Back to map](../MAP.md)**

---

## How to read this

[hosts.md](hosts.md) answers "what is possible on each host." This document answers "what do we build, in what order, and how do we know each one works." Each integration plan lists:

- **Access path** — how the host reaches iranti's tools
- **Deliverables** — the concrete artifacts to produce
- **Acceptance** — the test that proves the integration works
- **Risk** — what could invalidate the plan

Tool names below use the **Phase 1.1 realigned set** (9 tools): `iranti_attend`, `iranti_write`, `iranti_write_rule`, `iranti_archive`, `iranti_search`, `iranti_query`, `iranti_checkpoint`, `iranti_history`, `iranti_write_issue`.

---

## June 2026 verification deltas vs hosts.md

Re-verified 2026-06-09. Changes since the original research:

1. **Custom GPTs are being deprecated for business accounts.** OpenAI announced Workspace Agents (April 22, 2026) as the successor for Business/Enterprise/Edu; Custom GPTs survive for individuals only. Impact: the "Custom GPT with Actions" write workaround remains valid for **Plus/Pro individuals** but is time-limited for Team/Business — those users should use full MCP (which their plan already allows) instead. Plan unchanged, framing corrected.
2. **ChatGPT regional exclusions softened** from a blanket EEA/CH/UK block to per-app/per-capability restrictions. An iranti connector's availability in those regions is now plausible but must be tested, not assumed.
3. **ChatGPT Plus/Pro write gating reconfirmed** — but note OpenAI's own developer-docs page (`developers.openai.com/api/docs/guides/developer-mode`) carries stale text claiming full read/write for Plus. The help center (article 12584461) is authoritative: read/fetch-only for individuals. Don't be misled by the dev-docs page when building.
4. **claude.ai connectors: DCR is no longer mandatory.** Anthropic now accepts custom credentials for non-DCR servers. This lowers the Phase 2.5 → consumer-connector bar: a static OAuth client (or token) is acceptable before full Dynamic Client Registration ships.
5. **Gemini Spark still partner-only**, with Adobe/Samsung/Spotify/CapCut/GitHub/Notion/Slack named for summer 2026. No public registry yet. Watch trigger unchanged.
6. **MCP spec stable** — 2025-11-25 revision, stdio + Streamable HTTP, nothing new in 2026. Our transport plan needs no revision.

New hosts researched (not in hosts.md): Perplexity, Grok, Mistral Le Chat, Microsoft 365 Copilot, Microsoft Copilot (consumer), Meta AI, Qwen Chat, Kimi, JetBrains, Zed/Cline/Roo Code/Continue. Profiles below in their tier sections.

---

## Universal building blocks

These are built once and reused by every integration. They are the real engineering; the per-host work is mostly configuration and documentation.

### B1. The iranti protocol text (instruction template)

One canonical instruction block, maintained in `docs/integration/protocol.md`, with per-host renderings (CLAUDE.md, AGENTS.md, GEMINI.md, Cursor rules, copilot-instructions.md, profile instructions, custom instructions). Content: call `iranti_attend` before responding with entity hints; call `iranti_write` after learning durable facts; call `iranti_checkpoint` at natural pause points; never duplicate what attend already injected.

The template must degrade gracefully: hosts with weak instruction-following get a shorter, more imperative variant, and the tool descriptions themselves carry the behavioral instructions ("call this before answering anything about the user") since tool descriptions are the one channel every MCP host honors.

### B2. Hook scripts (deterministic attend where supported)

- **Claude Code**: `UserPromptSubmit` → `iranti_attend`, `Stop` → checkpoint write. Already proven by v0; port to iranti-core tool names.
- **Cursor**: `beforeSubmitPrompt` hook script that queries iranti directly (Cursor hooks can't invoke MCP tools) and injects facts as `agent_message`.
- Everything else: instruction-driven (B1).

### B3. Single-user Streamable HTTP transport (Phase 2.5)

The same `McpServer` instance served over Streamable HTTP alongside stdio (SDK supports both from one tool registry). Auth: one static bearer token from env. Deployment story: VPS/Fly/Railway or Cloudflare Tunnel. **Must land after Phase 2 write serialization** — a remote endpoint invites phone+laptop concurrency.

Unlocks: claude.ai, Claude mobile, ChatGPT, Perplexity (web), Grok, Le Chat, M365 Copilot, Qwen desktop (via URL), and vendor-side API MCP execution. Every consumer surface researched requires this; none requires more than this plus per-host auth polish.

### B4. `search` / `fetch` alias tools (ChatGPT connector shim)

Two additional MCP tools conforming to OpenAI's deep-research connector schema: `search` (wraps `iranti_search`) and `fetch` (wraps `iranti_query`/fact retrieval by id). Registered only when `IRANTI_EXPOSE_OPENAI_ALIASES=true` so other hosts don't see duplicate tools. Cheap to build at Phase 1.1 time (the wrapped tools exist); ship with B3.

### B5. OpenAPI spec for GPT Actions / generic REST

A small REST surface over the same library (`POST /attend`, `POST /facts`, `POST /rules`, `GET /search`...) with an OpenAPI document. Serves: Custom GPT Actions (the Plus/Pro write path), and any platform that speaks OpenAPI but not MCP. Can be the same HTTP server as B3 — MCP endpoint at `/mcp`, REST at `/api`.

### B6. Generic API adapter snippets

Documented function-calling integration per provider (OpenAI, Anthropic, Gemini, DeepSeek/OpenAI-compatible): "call attend, prepend to system prompt, register write as a tool." Doubles as iranti's own integration test harness.

---

## Tier 1 — stdio, ship now (needs only Phase 1.1)

All of these work against the existing local server. Per-host work is a config snippet + an instruction template + an acceptance test. One docs page ("Install iranti in your editor") covers the lot.

| Host | Access path | Deliverables | Acceptance | Notes |
|---|---|---|---|---|
| **Claude Code** | `.mcp.json` stdio + hooks | Config snippet; B2 hook scripts; CLAUDE.md block | Hook-driven attend injects facts before first model token; checkpoint written on Stop | Reference host. Port v0 hooks to new tool names. SessionStart hook needs retry/graceful-skip (MCP may still be connecting) |
| **Claude Desktop** | `claude_desktop_config.json` stdio | Config snippet; profile-instructions block | Fresh conversation surfaces a fact written from Claude Code | Same models, same JSON shape as Claude Code |
| **Cursor** | `~/.cursor/mcp.json` stdio + hooks | Config snippet; rules file; B2 hook script | `beforeSubmitPrompt` hook injects memory deterministically | Keep tool count lean — Cursor caps active tools |
| **Windsurf** | `mcp_config.json` stdio | Config snippet; `global_rules.md` block | Instruction-driven attend observed in a fresh Cascade session | No hooks — advisory only |
| **VS Code / Copilot** | `.vscode/mcp.json` stdio | Config snippet; `copilot-instructions.md` block | Agent-mode session calls attend | Agent mode ONLY — document prominently |
| **Gemini CLI** | `settings.json` stdio | Config snippet; `GEMINI.md` block | Instruction-driven attend in fresh session | Extension packaging in Tier 2 |
| **Codex CLI/IDE** | `codex mcp add` stdio | Config snippet; `AGENTS.md` block | Instruction-driven attend in fresh session | Cloud tasks out of scope (no MCP) |
| **JetBrains AI / Junie** | AI Assistant MCP (stdio) | Config snippet; project rules block | Tool visible and callable in agent mode | New since hosts.md; free tier exists |
| **Zed / Cline / Roo Code / Continue** | stdio via each tool's config | 4 config snippets; rules-file blocks | Tool callable in each | All mature MCP clients; low effort, do as a batch |
| **Perplexity Desktop (Mac)** | Settings → Connectors, local stdio | Config walkthrough; AI Profile block | Fact written elsewhere surfaces in Perplexity answer | Desktop only; web needs Tier 3. Pro plan |
| **Qwen Chat Desktop** | MCP button → JSON config | Config walkthrough | Tool callable | Partial value: no instruction channel, so attend is model-discretion only |

**Tier 1 exit criteria:** the cross-host loop demonstrably works — write a fact in Claude Code, retrieve it in Claude Desktop and Cursor without re-telling.

---

## Tier 2 — packaging polish (no new server capability)

| Deliverable | What it is | Why |
|---|---|---|
| **Claude Desktop `.mcpb` bundle** | manifest.json + bundled server, drag-and-drop install, user-config field for `DATABASE_URL` | Removes "edit JSON" from the install; Claude Desktop ships its own Node runtime |
| **Gemini CLI extension** | Extension manifest bundling server config + its own context file | The context file installs the iranti protocol *with* the server — cleanest behavioral wiring outside hooks |
| **Editor install docs page** | One page, all Tier 1 snippets | Single canonical reference |
| **DB prerequisite story** | Decide presentation: "run `pnpm db:up` first" vs. future embedded/SQLite fallback | Honest blocker for civilian installs until iranti is hosted; document, don't solve yet |

---

## Tier 3 — remote HTTP surfaces (needs B3; after Phase 2 write serialization)

Ordered by value ÷ effort within the tier.

### claude.ai web → Claude mobile (first — cleanest, syncs to mobile free)

- **Access:** Settings → Connectors → custom connector at our HTTPS URL. Anthropic connects from their cloud — public endpoint mandatory. DCR no longer required: custom credentials acceptable (verification delta #4).
- **Deliverables:** B3 deployed; connector setup doc; profile-instructions block (B1).
- **Acceptance:** fact written from Claude Code on the laptop surfaces in a claude.ai conversation, then in the iOS/Android app with zero additional config (connectors sync).
- **Risk:** low. Free plan allows one custom connector — iranti would occupy it; note in docs.

### Mistral Le Chat (second — free tier, best permission model)

- **Access:** custom MCP connector, Streamable HTTP + TLS. Available on ALL tiers including Free — broadest reach of any consumer surface.
- **Deliverables:** B3; setup doc recommending **"Always allow" on `iranti_attend`/`iranti_search`/`iranti_query`, manual approval on writes** — Le Chat's per-tool permission split maps perfectly onto iranti's read/write asymmetry.
- **Acceptance:** attend auto-fires under always-allow; write prompts for confirmation and lands with `surface` provenance.
- **Risk:** low. Le Chat Memories may overlap/compete with iranti — test interaction.

### ChatGPT (third — biggest audience, most caveats)

- **Access, three lanes:**
  1. *Deep-research connector* (all paid): needs B4 `search`/`fetch` aliases. Read-only by design.
  2. *Developer-mode connector* (Plus/Pro): full tool list visible, **writes blocked** for individuals. Read path for power users.
  3. *Full MCP* (Business/Enterprise/Edu): everything works; admin enables.
- **Write path for Plus/Pro individuals:** Custom GPT + Actions against B5's REST API (per-call confirmation). Valid for individuals; **do not build business features on Custom GPTs** — they're deprecated for business accounts in favor of Workspace Agents (delta #1). For Team/Business, full MCP is the answer anyway.
- **Deliverables:** B3 + B4 + B5; an "iranti" Custom GPT definition (OpenAPI + instructions); custom-instructions block; doc explaining the tier matrix honestly.
- **Acceptance:** deep-research connector answers "what do you know about project X" from iranti facts; Custom GPT writes a fact that then surfaces in Claude Code.
- **Risk:** medium. Dev mode disables ChatGPT's own memory (confirmed — actually favorable: no competing memory). Regional availability per-app — test from EEA before claiming support. GPT-model instruction compliance is weaker; lean on tool descriptions.

### Grok (fourth)

- **Access:** grok.com/connectors → Custom → our URL. Remote only. SuperGrok paid tiers.
- **Deliverables:** B3; setup doc; Custom Agent template carrying the iranti protocol (Grok's Custom Agents are a real instruction channel — up to 4 agents with own system prompts).
- **Acceptance:** custom agent with iranti protocol attends before answering.
- **Risk:** low-medium. Connector docs young; re-verify at build time.

### Perplexity web (fifth — desktop already covered in Tier 1)

- **Access:** custom remote connector (Mar 2026), Pro/Max/Enterprise. OAuth, API key, or open auth.
- **Deliverables:** B3; setup doc; AI Profile block.
- **Acceptance:** same fact-roundtrip test.

### Microsoft 365 Copilot (sixth — enterprise lane, separate motion)

- **Access:** declarative agent with MCP actions (GA Dec 2025) pointing at B3's endpoint; Entra auth; admin deployment. Alternatively a federated Copilot connector.
- **Deliverables:** declarative agent manifest (instructions field carries the protocol); Entra app registration doc.
- **Acceptance:** deployed agent in Copilot Chat attends + writes with provenance.
- **Risk:** medium — admin-mediated distribution means this is a B2B sales/onboarding motion, not self-serve. Park until there's an org that wants it; the endpoint will already exist.

### Vendor-side API MCP (continuous)

OpenAI Responses API `mcp` tool type and Anthropic's MCP connector both call our hosted endpoint server-side. Zero work beyond B3 — document the snippets in B6.

---

## Tier 4 — watch list (blocked on vendors, not on iranti)

| Host | Blocker | Trigger to act | Check |
|---|---|---|---|
| **Gemini consumer (Spark)** | Partner-only connectors; no public registry | Google opens submission process (partners expanding summer 2026 — registry plausibly follows) | Quarterly |
| **Kimi web/app** | MCP "in development, coming weeks" per Moonshot | Feature ships → likely straight to Full; Kimi CLI works today via Tier 1 pattern | Monthly — nearest-term flip |
| **DeepSeek web** | No native connectors; extension workaround only | Native connector support announced | Quarterly |
| **Codex cloud** | No user MCP in cloud tasks | OpenAI ships cloud MCP | Quarterly |
| **MS Copilot consumer** | Curated connectors only, no extensibility | Microsoft opens consumer connector registration | Quarterly |
| **Meta AI** | No extensibility surface at all | Any plugin/connector surface announced | Quarterly |
| **Xcode / Apple** | Indirect only (embedded Claude/Codex agents carry own MCP config — already covered by Tier 1) | iOS/macOS 27 platform-wide MCP (Siri reaching MCP servers) materializes | At WWDC + releases |

Meta AI and MS Copilot consumer are the honest "not possible" gaps in the every-host story. Everything else is reachable or has a near-term trigger.

---

## Sequencing against the phase plan

```
Phase 1.1  Tool realignment (9 tools) ──────────── prerequisite for everything
   │       + B4 aliases designed (built later), B1 protocol template
   ▼
Tier 1     Editor/CLI integrations (stdio) ─────── config + docs, no server work
   │       Claude Code + Desktop first (Wave 1), rest as batch (Wave 2)
   ▼
Phase 2    Write serialization ─────────────────── concurrency safety
   ▼
Phase 2.5  B3 single-user HTTP + B4 + B5 ───────── the one big unlock
   ▼
Tier 3     claude.ai → mobile → Le Chat → ChatGPT → Grok → Perplexity web
   │       (M365 parked until pulled by demand)
   ▼
Phase 5    OAuth 2.1 + DCR + tenancy ───────────── connectors at scale, multi-user
```

The strategic shape is unchanged from hosts.md but sharper: **Tier 1 is nearly free and covers every developer tool; B3 is one engineering effort that unlocks eight consumer surfaces at once.** The new-host research strengthened the case — Perplexity, Grok, and Le Chat were not in the original survey and all three are full-support targets sitting behind the same HTTP endpoint.
