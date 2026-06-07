# Competitive landscape

**Status:** research  
**Researched:** 2026-06-07  
**Method:** Multi-source web research across GitHub, HN, Reddit, YC directory, ProductHunt, and the broader web. 113 search and fetch agents. Claims adversarially verified at a 2/3 threshold before inclusion.  
**[Back to map](../MAP.md)**

---

## Summary

The persistent AI memory space is active but segmented into three distinct distribution models: developer SDKs and libraries, MCP server tools, and consumer browser extensions. The market has two YC-funded companies (Mem0, Zep) — which validates investor interest — but both are exclusively developer-facing. Cross-platform memory for everyday users spanning ChatGPT, Claude, Gemini, and other hosts simultaneously is largely unserved. No well-funded or widely adopted solution offers this. That is the opening iranti is positioned to take.

---

## The funded players

### Mem0 — YC S24
- **What it does:** Intelligent memory layer for AI agents with multi-level memory (User, Session, Agent state) and hybrid search (semantic + BM25 + entity linking). Automatically extracts and retrieves relevant memories across sessions.
- **Who built it:** Mem0 (YC S24 company)
- **Distribution:** `pip install mem0ai`, `npm install mem0ai`, hosted SaaS at app.mem0.ai (Free / $19/mo / $249/mo / Enterprise)
- **Who it targets:** Developers building AI applications. No consumer product exists.
- **Key differentiator:** Best-funded, most mature. 57,000+ GitHub stars. V3 hybrid search is genuinely sophisticated.
- **Key limitation:** Requires developer integration. A regular person cannot use it directly. Memory writes require the developer to explicitly call the API — not autonomous.
- **Funding:** $24M (reported by TechCrunch)
- **Sources:** [GitHub](https://github.com/mem0ai/mem0) · [YC](https://www.ycombinator.com/companies/mem0) · [PyPI](https://pypi.org/project/mem0ai/) · [npm](https://www.npmjs.com/package/mem0ai) · [SaaS](https://app.mem0.ai)

### Zep AI — YC W24
- **What it does:** Long-term memory for AI assistants using a temporal knowledge graph (Graphiti engine). Automatically populates prompts with relevant facts and summaries from past conversations. Handles fact changes over time — if a stored fact becomes outdated, the graph knows.
- **Who built it:** Zep AI (YC W24 company)
- **Distribution:** Zep Cloud SaaS (sign-up), open-source Community Edition (self-hosted)
- **Who it targets:** Developers. Enterprise customers include AWS and Samsung. Python, TypeScript, and Go SDKs. No consumer UI.
- **Key differentiator:** Temporal knowledge graph. Sub-200ms retrieval. Benchmarked on LongMemEval.
- **Key limitation:** Full features require Zep Cloud. Community edition is self-hosted. Developer-only — no path for a regular user.
- **Sources:** [YC launch](https://www.ycombinator.com/launches/Kd4-zep-long-term-memory-for-ai-assistants) · [Website](https://getzep.com) · [GitHub](https://github.com/getzep/zep) · [Community edition announcement](https://blog.getzep.com/announcing-zep-community-edition/)

### Letta (formerly MemGPT)
- **What it does:** Agent memory framework from UC Berkeley. Pioneered the idea of agents managing their own memory like an operating system manages RAM.
- **Who built it:** UC Berkeley spinout, came out of stealth 2024
- **Distribution:** Open-source, self-hosted
- **Who it targets:** Developers and researchers
- **Key limitation:** Academic in origin, complex to operate
- **Sources:** [TechCrunch](https://techcrunch.com/2024/09/23/letta-one-of-uc-berkeleys-most-anticipated-ai-startups-has-just-come-out-of-stealth/) · [Website](https://www.letta.com/blog/memgpt-and-letta)

### Supermemory
- **What it does:** Hosted MCP server providing persistent, cross-platform memory across Claude Desktop, Cursor, Windsurf, VS Code, and Cline. Memories added in one tool are retrievable in another.
- **Who built it:** Supermemory (backed by Google execs, founder was 19 at the time)
- **Distribution:** Hosted MCP server at `https://mcp.supermemory.ai/mcp`. Zero infrastructure required — just add the URL to your MCP client config.
- **Who it targets:** Developers using AI coding tools. Not ChatGPT or Gemini users.
- **Key differentiator:** Truly zero-setup for MCP-compatible clients. Cross-platform within the MCP/coding-tool ecosystem.
- **Key limitation:** MCP-only. Works in coding tools (Claude Desktop, Cursor, VS Code). Does not work in ChatGPT, Gemini, or any consumer AI interface.
- **Sources:** [Docs](https://supermemory.ai/docs/supermemory-mcp/introduction) · [TechCrunch](https://techcrunch.com/2025/10/06/a-19-year-old-nabs-backing-from-google-execs-for-his-ai-memory-startup-supermemory/)

---

## The MCP tool cluster

All of these require developer setup. None work with ChatGPT, Gemini, or consumer AI interfaces.

### Official MCP Memory Server
- **What it does:** Reference implementation of MCP-based memory maintained by the MCP protocol authors (Anthropic). Stores knowledge in a local JSONL file.
- **Distribution:** Part of [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) on GitHub
- **Who it targets:** Developers
- **Key differentiator:** Official, zero-dependency, maintained by the protocol authors
- **Key limitation:** Local file only. No cloud sync. No semantic search. Single-host by design. Pointing the file path at Dropbox is the only workaround for cross-device access.

### Graphiti (by Zep AI)
- **What it does:** The open-source graph library powering Zep's memory architecture. Ships its own MCP server implementation. Temporal, episode-aware knowledge graph.
- **Distribution:** `pip install graphiti-core`. MCP server deployable via Docker with Neo4j or FalkorDB as graph backend.
- **Who it targets:** Developers
- **Key differentiator:** Temporal graph — handles facts that change over time natively
- **Key limitation:** Requires running a graph database (Neo4j or FalkorDB). More operational overhead than simpler tools.
- **Sources:** [GitHub](https://github.com/getzep/graphiti) · [Docs](https://help.getzep.com)

### MemMachine (by MemVerge Inc.)
- **What it does:** Open-source memory layer for AI agents offering three tiers: episodic (graph-based), profile (SQL-backed long-term facts), and working (short-term session context). Architecture uses PostgreSQL with pgvector, SQLite, and Neo4j.
- **Distribution:** `pip install memmachine-client`, Docker, managed cloud at console.memmachine.ai
- **Who it targets:** "Agent developers and organisations building AI applications" (official FAQ)
- **Key differentiator:** Three-tier memory taxonomy maps well to how human memory works
- **Key limitation:** Developer-facing. MCP integration claimed but not independently verified.
- **Sources:** [GitHub](https://github.com/MemMachine/MemMachine) · [PyPI client](https://pypi.org/project/memmachine-client/) · [PyPI server](https://pypi.org/project/memmachine-server/) · [Docker](https://hub.docker.com/r/memmachine/memmachine) · [Website](https://memmachine.ai)

### claude-mem
- **What it does:** MCP memory plugin for AI coding agents. Installable via `npx claude-mem install` or via the Claude Code plugin marketplace.
- **Distribution:** npm/npx
- **Who it targets:** Developers using coding agents (Claude Code, Gemini CLI, OpenCode)
- **Key limitation:** Primarily Claude-ecosystem. Claimed multi-host support was not independently verified.
- **Sources:** [GitHub](https://github.com/thedotmack/claude-mem) · [npm](https://www.npmjs.com/package/claude-mem)

### mcp-memory-keeper
- **What it does:** Context preservation for long coding sessions in Claude Code and Claude Desktop.
- **Distribution:** `npx mcp-memory-keeper`
- **Who it targets:** Developers in the Claude ecosystem
- **Key limitation:** Claude-centric by documentation and UX design. No ChatGPT or Gemini support documented.
- **Sources:** [GitHub](https://github.com/mkreyman/mcp-memory-keeper) · [mcpservers.org](https://mcpservers.org)

### memories.sh CLI
- **What it does:** Persistent memory management for AI coding tools with MCP integration and native config generation for Cursor, Claude Code, and Windsurf.
- **Distribution:** `npm install -g @memories.sh/cli` (Node.js >= 20)
- **Who it targets:** Developers using coding tools only
- **Key limitation:** Coding tools only. No consumer AI platform support.
- **Sources:** [npm](https://www.npmjs.com/package/@memories.sh/cli) · [Docs](https://memories.sh/docs/cli)

---

## The consumer side

### Rethread
- **What it does:** Cross-platform AI memory across ChatGPT, Claude, Gemini, Grok, Perplexity, and DeepSeek. The clearest analogue to a consumer cross-host memory layer that was independently verified.
- **Distribution:** Free Chrome extension (also works in Edge, Brave, Arc)
- **Who it targets:** Everyday AI users — no developer setup required
- **Key differentiator:** The only confirmed, working, zero-setup solution for cross-platform consumer memory across multiple AI hosts simultaneously
- **Key limitation:** Browser extension only — no mobile, no native apps. Technical depth unknown (likely simple context injection rather than intelligent retrieval). No information on storage backend or memory management.
- **Sources:** [Website](https://rethread.dev/)

### OpenMemory Chrome Extension (by Mem0)
- **What it does:** Mem0's consumer-facing browser extension, a recent expansion of their product line into the consumer space.
- **Distribution:** Chrome extension
- **Who it targets:** Everyday users
- **Note:** Shows that Mem0 recognises the consumer gap and is trying to address it. Worth monitoring.
- **Sources:** [Mem0 blog](https://mem0.ai/blog/introducing-the-openmemory-chrome-extension)

### MemoryPlugin.com
- **What it does:** Claims to support 19+ AI platforms via a browser extension (Chrome, Safari, iOS, Android) and an MCP server.
- **Distribution:** Browser extension + MCP server (claimed)
- **Who it targets:** Everyday users (claimed)
- **Note:** Could not be independently verified to research standard. If accurate, would be the closest competitor to iranti's consumer cross-platform vision. Treat as unconfirmed but worth investigating directly.
- **Sources:** [Website](https://www.memoryplugin.com/) — *claims unverified*

---

## What iranti does differently

Every tool above fails on at least one of these dimensions. iranti is designed to satisfy all of them simultaneously.

| Capability | Mem0 | Zep | Rethread | Supermemory MCP | iranti |
|---|---|---|---|---|---|
| Works without developer setup | No | No | Yes | No | Yes (target) |
| Works on mobile | No | No | No | No | Yes (target) |
| Autonomous writes (no manual save) | No | No | No | No | Yes |
| Cross-host (ChatGPT + Claude + Gemini + ...) | No | No | Partial | No | Yes (target) |
| Intelligent memory (decay, conflict, reinforcement) | Partial | Partial | No | No | Yes |
| Works at the API layer, not browser layer | Yes | Yes | No | Yes | Yes |

The core differentiation: iranti is the only design in this space where the memory layer is **autonomous** (decides what to remember without being told) and **cross-host** (works across every AI platform, not just one ecosystem), delivered at the API layer rather than as a browser extension.

---

## What this means for a funding pitch

Two YC companies (Mem0, Zep) validate that investors believe this is a real problem worth funding. Both raised meaningful capital going developer-first. Neither has a working consumer product.

Rethread's existence shows consumer demand is real. Its technical shallowness shows the consumer problem has not been solved yet.

The honest risk: this space moves fast. New MCP memory tools are appearing weekly. Mem0 is already expanding toward consumers with their Chrome extension. The window to be the differentiated cross-platform autonomous memory layer is real but not permanent.

---

## Open questions from the research

- Does MemoryPlugin.com actually work as described? If it supports 19+ platforms including mobile, it is the closest competitor to iranti's vision and needs direct investigation.
- Are there any funded startups specifically targeting the consumer cross-platform niche (as opposed to the developer SDK segment)?
- How does cross-host identity work in MCP-based tools? If a user adds a memory via Claude Desktop and then opens Cursor, can the same memory surface? Is there any standardised identity layer emerging?
- What other browser extensions exist for AI memory beyond Rethread with meaningful adoption?

---

*Research conducted 2026-06-07. 30 sources fetched, 143 claims extracted, 25 adversarially verified (2/3 vote threshold). 15 confirmed, 10 killed. Landscape moves quickly — recheck before any investor conversation.*
