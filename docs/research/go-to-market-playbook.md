# Go-to-market playbook: how the big players got attention

**Status:** research  
**Researched:** 2026-06-07  
**Method:** Primary source verification — HN threads fetched directly, GitHub stats cross-checked, ProductHunt launches confirmed. 98 agents, 16 sources. Claims 2/3 adversarially verified. 14 confirmed, 11 killed.  
**[Back to map](../MAP.md)**

---

## The short answer

Three things drove every major traction event in this space: open-source under a permissive licence, precise pain-point language aimed at developers, and the founder being personally present in every comment thread at launch. Timing helped MemGPT (accidentally) and Supermemory (deliberately). For everyone else it was slow build followed by one good launch moment.

---

## How each one did it

### MemGPT / Letta — accidental virality, then deliberate amplification

**What happened:** A third party posted their arXiv paper to Hacker News before the founders were ready to release the code. The paper went viral before they had a chance to control the release. The founders then used that momentum deliberately.

**The launch post that mattered:** October 16, 2023. Submitted by co-author shishirpatil. 363 points, 85 comments. The authors opened with: *"Hey all, MemGPT authors here! Happy to answer any questions about the implementation."* They had a Discord bot demo ready and linked to a working GitHub repo with document QA examples.

**What you can copy:** The founder-in-the-comments move. Being personally available and responsive in the launch thread is a real signal to developers that this is real and maintained. A lazy launch with no author engagement performs significantly worse.

**What you cannot copy:** The accidental virality from an academic paper. MemGPT had the credibility of UC Berkeley behind it. That is not transferable.

**Key timing factor:** October 2023, just under a year after ChatGPT launched. Developer interest in building on top of LLMs was at its first peak. Any paper claiming to solve a fundamental LLM limitation landed well.

---

### Mem0 — audience-first, then launch

**What happened:** The founders built a different open-source project first — Embedchain (8,900+ GitHub stars) — and a GPT app store called Cookup.ai with over 1 million users. They had an existing developer audience before Mem0 existed. They then pivoted to Mem0 in January 2024 and launched the Show HN eight months later.

**The launch post that mattered:** September 4, 2024. Title: *"Show HN: Mem0 – open-source Memory Layer for AI apps."* 201 points, 61 comments.

**The messaging:** *"LLMs are stateless — they don't remember anything between sessions."* That is the exact sentence. Clear, true, painful to any developer who has built a chatbot.

**The model:** Apache 2.0 open-source core with a paid platform for production features (webhooks, auto-scaling, real-time updates). Free to start, pay when you scale.

**Numbers at the $24M raise (October 2025):** 41,000 GitHub stars, 13M+ Python package downloads, 80,000+ developer cloud signups.

**What you can copy:**
- The "LLMs are stateless" framing structure — iranti needs its own single-sentence version of this
- Build something useful and open-source before you launch the main product. Even a small tool with real users reduces cold-start risk enormously
- The open-core model (free library, paid hosted platform)

**What you cannot easily copy:** The pre-existing Embedchain audience. This was years of work. The takeaway is: do not expect a cold launch to perform the way Mem0's did. Their HN hit 201 points partly because hundreds of Embedchain users already knew them.

---

### Zep AI — slow start, product deepening, eventual YC

**What happened:** Zep's first Show HN on May 10, 2023 got 7 points and 3 comments. By most metrics that is a failed launch. They kept building.

**The one good thing from that failed launch:** The founder posted this in the thread: *"Many of the long-term memory services focus on vector search over a corpus of documents to offer the LLM domain context. Where Zep is different, is we focus on the conversation history, offering the stateless LLM a long-term state component."*

That is a high-quality differentiation statement. It names the competition, explains the difference, and does it in two sentences. They just did not have enough to back it up yet at launch time.

**What actually got them traction:** Building Graphiti — a temporal knowledge graph library — which became genuinely respected in the developer community and was cited in an arXiv paper. Technical depth earned them YC W24 eventually.

**What you can copy:** The differentiation framing structure. Name who you are not (the vector search corpus tools), then say precisely what you are (conversation history as long-term state). Iranti's version: name what you are not (memory silos per platform), say what you are (one memory layer that follows you across every AI you use).

**What you cannot copy:** You cannot replicate the slow YC path on a tight timeline. The lesson is more about messaging quality than strategy.

---

### Supermemory — MCP timing wave + Twitter-first

**What happened:** Supermemory explicitly rode the MCP protocol launch as a distribution wedge. When Anthropic released MCP in early 2025, Supermemory was ready with an MCP-native memory tool.

**The ProductHunt launch:** April 18, 2025. "Universal Memory MCP." 439 upvotes. Ranked #2 for the day.

**The core hook:** *"Your memories are in ChatGPT... But nowhere else."* This is the best consumer-facing problem statement in the space. It names a frustration that every person who uses multiple AI tools has felt. Note that this is the same structure as Mem0's line — state the problem in one sentence, make it feel personal.

**The Launch Week strategy:** December 24–31, 2025. 9 product launches in 7 days, all announced on Twitter/X (@supermemory, @DhravyaShah). No HN or ProductHunt in this wave — pure Twitter. GitHub stars for their MCP tool: 1,696.

**What you can copy:**
- The problem statement structure: *"Your [thing] is in [place]... But nowhere else."* Iranti's version: *"Your AI remembers you in ChatGPT. But when you open Claude, it's meeting you for the first time."*
- Ride protocol waves deliberately. When a new integration surface opens (MCP did this), be ready with a product that uses it before anyone else.
- Twitter/X for consumer-facing launches. ProductHunt for developer tools.

---

## The shared playbook — what is actually replicable

These are the patterns that appeared across all four, not just one:

**1. Open-source the core under Apache 2.0 or MIT**
Developers do not adopt proprietary tools for infrastructure problems. Every tool here made the core free and open. The business model goes on top (hosted platform, enterprise features, support).

**2. One precise problem sentence**
- Mem0: *"LLMs are stateless — they don't remember anything between sessions"*
- Supermemory: *"Your memories are in ChatGPT... But nowhere else"*
- Zep: *"We focus on the conversation history, offering the stateless LLM a long-term state component"*

Each one names the pain without jargon. Each one is something a developer or a regular user has actually felt. Iranti needs one of these.

**3. Be in the comments**
Every successful HN launch had the founder actively responding to every comment. This is free and completely copyable. It signals the tool is maintained, the founder is responsive, and the person using it will not be abandoned.

**4. Have something working before you post**
MemGPT had a Discord bot demo. Mem0 had 8 months of open-source momentum. Supermemory had a running MCP server. No announcement without a demo link.

**5. Timing is real but not everything**
MemGPT rode the ChatGPT wave. Supermemory rode the MCP wave. These were real tailwinds. But Mem0 succeeded without a specific wave — it succeeded because the product was good and the audience already existed. Timing helps; it does not replace substance.

---

## What is different about iranti's situation

All five tools above launched developer-first. HN is a developer audience. Their messaging was aimed at people building AI apps.

Iranti's consumer angle is genuinely different. The consumer story — *"one memory layer across all your AI tools, including on mobile"* — does not land on HN. It lands on Reddit (r/ChatGPT, r/ClaudeAI), YouTube, and potentially TikTok if the demo is visual.

The developer story (iranti as infrastructure for agents) *does* land on HN. These are two separate audiences and two separate launches. Trying to do both at once usually means doing neither well.

**Recommendation:** The developer launch comes first — it is more replicable from the playbooks above, and it builds the credibility and open-source base that makes the consumer launch more believable. Then the consumer launch, with different channels and different messaging.

---

## The one thing to do before any launch

Write the single-sentence problem statement. Everything else can be figured out. That sentence is the whole pitch compressed. If you cannot write it, the launch is not ready.

---

*Research conducted 2026-06-07. Primary sources: HN threads 37901902, 41447317, 35889826 (direct fetch). GitHub stars cross-checked. ProductHunt data from supermemory-mcp README badge. TechCrunch for funding figures.*

---

## Tools to evaluate for GTM

**avalidate.com** — flagged 2026-06-09 as a potential GTM tool to evaluate when we get to launch phase. Investigate: what it does, whether it fits the iranti GTM motion, and if so, where in the launch sequence it belongs.
