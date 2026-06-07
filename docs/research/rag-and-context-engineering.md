# RAG and context engineering: a primer

**Status:** research  
**Researched:** 2026-06-07  
**Method:** 111 agents, 29 sources fetched, 118 claims extracted, 25 adversarially verified (2/3 threshold). 10 confirmed, 15 killed. Note: many specific benchmark numbers in this space did not survive verification — they are not cited here.  
**[Back to map](../MAP.md)**

---

## Why this matters for iranti

Iranti describes itself as "automatic context engineering for AI agents." To explain what that means — to an engineer, an investor, or a user — you need to understand what context engineering is, how it differs from older approaches like RAG, and why iranti's approach is a step beyond both.

---

## Start here: the core problem

An LLM has no memory. Every time you send it a message, it starts from zero. It knows only what is inside the current conversation window — a limited amount of text that fits in one shot. Anything outside that window does not exist to the model.

This is the problem that RAG, context engineering, and iranti all exist to solve. They just solve it at different levels of sophistication.

---

## What RAG is

**RAG stands for Retrieval-Augmented Generation.** The idea is: before you ask the AI a question, you go find relevant information from an external source and add it to the question. The AI now answers with that retrieved context included.

Think of it like open-book exam vs. closed-book exam. The AI without RAG is doing a closed-book exam — it can only use what it memorised during training. The AI with RAG has the relevant pages from the textbook slipped into its prompt before it answers.

The three stages of the simplest version (called Naive RAG):
1. **Indexing** — take a collection of documents, break them into pieces (chunks), and store them in a searchable index
2. **Retrieval** — when a user asks a question, find the most relevant chunks from the index
3. **Generation** — give the AI the question plus the retrieved chunks, and it answers using both

**What Naive RAG gets wrong:**
- Retrieval pulls the wrong chunks — things that match the keywords but miss the actual meaning
- The AI still hallucinates even with retrieved context if the context is irrelevant
- Piecing together disconnected chunks produces incoherent outputs

---

## How RAG evolved

The field progressed through three generations, where each one contains all the previous:

**Naive RAG** → the basic three-step version above

**Advanced RAG** → adds steps before and after retrieval to fix Naive RAG's failures:
- Before retrieval: rewrite the user's query to improve search results, expand it with related terms, break it into sub-questions
- After retrieval: re-rank the retrieved chunks, filter out irrelevant ones, compress the context before it goes to the AI

**Modular RAG** → treats RAG as a configurable system with six interchangeable modules: Indexing, Pre-retrieval, Retrieval, Post-retrieval, Generation, and Orchestration. You can swap out any module for a better one without changing the rest. This is where the field is now.

Beyond these three: **Graph-Enhanced RAG** and **Agentic RAG** are emerging as distinct approaches. Graph RAG (Microsoft, 2024) uses a knowledge graph instead of a flat document index, which lets it answer questions that require connecting multiple pieces of information. Agentic RAG lets the AI decide whether to retrieve and when, rather than always retrieving before every answer.

---

## Reranking — the precision fix

When you retrieve 100 candidate chunks from an index, you need a way to rank them from most to least relevant before feeding them to the AI. This is called **reranking**, and it is one of the most important improvements Advanced RAG made.

Two types of models do this differently:

**Bi-encoders** — encode the query and each document separately into vectors, then measure similarity by comparing the vectors. Fast, because you can pre-compute document vectors. But the query and document never interact at the encoding stage, so word-level nuance is lost.

**Cross-encoders** — feed the query and document together in a single pass. The model sees both at the same time and can reason about how specific words in the query relate to specific words in the document. Slower, but significantly more precise. This is what modern reranking systems use.

---

## The difference between RAG and what iranti is doing

RAG is fundamentally about **retrieval from a static document corpus**. You index a set of documents, and when asked a question, you retrieve from them. The corpus does not change much over time. It does not learn from the conversation. It does not decide what is worth remembering. It does not forget things that have become stale.

Iranti is a **memory system**, not a retrieval system. The difference:

| RAG | Iranti |
|---|---|
| Retrieves from a static corpus | Memory grows and changes over time |
| You decide what goes into the index | Iranti decides what is worth remembering |
| Retrieval is triggered by queries | Memory is also triggered by observation (what the agent reads) |
| Nothing is forgotten unless you delete it | Memories decay if not accessed, like real memory |
| No relationships between memories | Memories form a knowledge graph with weighted edges |
| Retrieval only | Write routing, conflict detection, decay, reinforcement all included |

The simplest way to put it: RAG is a search engine. Iranti is a brain.

---

## Context engineering — the term iranti uses

**Context engineering** is the term Tobi Lütke (CEO of Shopify) coined in June 2025. An academic survey of 1,400 papers (Mei et al., arXiv 2507.13334, July 2025) formalised the definition:

> *"The systematic optimization of information payloads for LLMs, treating context as a dynamically structured set of informational components rather than a static string."*

The contrast with the older approach is precise:
- **Prompt engineering** treated the context as a monolithic fixed string. You wrote a prompt, and that was the context.
- **Context engineering** treats the context as a set of dynamic components — memories, retrieved facts, rules, instructions, conversation history — each of which can be managed, updated, and optimised independently.

This is why iranti calls itself "automatic context engineering." It is managing each component of the context — what facts to inject, which rules to activate, what the agent should already know — without the user or agent having to think about it.

The term is very recent (June 2025). Being early to use it with a working product behind it is a genuine positioning advantage.

---

## What the competitors actually do technically

### Mem0
Uses a hybrid search approach combining three methods in parallel: semantic similarity (vector embeddings), BM25 keyword scoring, and entity linking. Stores memories at three levels: User (who the person is), Session (what happened in this conversation), and Agent (what the AI has learned about its own context). The developer calls the API to write memories — memory creation is not autonomous.

### Zep / Graphiti
Uses a **temporal knowledge graph** — a graph where every node and edge has a timestamp, and where older versions of facts are preserved rather than overwritten. This means the system can answer questions like "what did the user tell me about this three months ago, before they changed their mind?" Memory retrieval is sub-200ms. Academic paper: arXiv 2501.13956 (vendor-authored, medium confidence). Like Mem0, the developer controls what gets written.

### MemGPT / Letta
Inspired by how operating systems manage RAM. The AI is given a small "working memory" (what's in the current context window) and a much larger "external memory" (what's stored in a database). The AI itself decides when to read from and write to external memory, using special function calls. First paper to treat the AI as an active participant in memory management rather than a passive recipient of retrieved context.

---

## Hebbian reinforcement and memory decay

These are the two neuroscience principles iranti applies to its memory system. They are not part of standard RAG — iranti is one of very few systems implementing them.

**Hebbian reinforcement** comes from the 1949 neuroscience principle: *"Neurons that fire together, wire together."* Applied to iranti: when two memories are retrieved at the same time — because they were both relevant to the same query — the connection between them is strengthened. Over time, frequently co-retrieved memories become strongly linked, making future retrieval of related information faster and more precise. This is how associations form.

**Memory decay** comes from Ebbinghaus's forgetting curve (1885). Applied to iranti: every stored memory has a `lastAccessedAt` timestamp and a `stabilityScore`. If a memory is not accessed for a long time, its confidence score gradually decreases. Memories that are accessed frequently become more stable and decay slower. This mirrors how human long-term memory works — things you use regularly you retain, things you never revisit fade.

The combination means iranti's memory is not static. It is a living system that gets better the more it is used, and that self-cleans memories that are no longer relevant.

---

## Long-context models vs. RAG — when each is right

This is a real debate in the field. Modern models like Gemini 1.5 Pro have context windows of 1 million tokens — large enough to fit thousands of pages of text in a single prompt. Does that make RAG obsolete?

Not for iranti's use case. The tradeoffs:

**Long-context models are better when:**
- You need to reason across a whole document at once
- The document is small enough to fit
- Latency is not critical
- You are doing a one-off task

**RAG (and persistent memory systems) are better when:**
- The total knowledge is larger than any context window
- You need memory to persist across many conversations, potentially forever
- You want only the relevant subset of knowledge injected, not everything
- You want the system to learn and update over time
- Cost matters (stuffing a 1M token context into every request is expensive)

For iranti specifically: the memory grows over months or years. It will never fit in a context window. Selective, intelligent retrieval is the only viable approach.

---

## Summary: where iranti sits in this landscape

The field moved from prompt engineering (static strings) to RAG (retrieve from a corpus) to context engineering (dynamically manage all components of context). Iranti is built at the context engineering layer, with memory management that goes beyond retrieval: autonomous write routing, conflict detection, Hebbian reinforcement, memory decay, knowledge graph relationships, and support for multiple memory types (facts, rules, checkpoints).

The gap in the market: every existing tool at this level requires developer integration and manual write calls. Iranti makes the entire process automatic — the memory layer runs invisibly, deciding what to store and what to surface, without the user or the agent having to ask.

---

*Research conducted 2026-06-07. Primary academic sources: arXiv 2407.21059 (Modular RAG taxonomy), arXiv 2507.13334 (context engineering survey, 1400 papers), arXiv 2501.13956 (Graphiti paper). Note: specific benchmark numbers from this space (GraphRAG accuracy, HippoRAG cost reduction, cross-encoder gain percentages) did not survive adversarial verification and are not cited here.*
