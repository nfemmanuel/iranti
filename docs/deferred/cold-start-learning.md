# Cold start learning

**Status:** deferred  
**[Back to map](../MAP.md)** · **[PRD §13](../rough-notes/iranti-core-prd.md#13-open-items)**

---

> Explicitly deferred. No decisions made yet. This is a future research problem.

## What this is

How a fresh iranti installation learns before it has accumulated context from real sessions.

## Why it matters

A brand new iranti installation knows nothing. It has no facts, no preferences, no accumulated context. It is most vulnerable at the start, when users are most likely to evaluate whether it is worth using. Cold start is the gap between "installed" and "useful."

## The problem

iranti is a memory system. Its value comes from accumulated context. A fresh install has none. The question is: how does iranti provide value from day one before it has learned anything about the user or project?

## What we know

From the PRD: "A fresh iranti installation should learn like an LLM learns: from the people using it and from the system. What this means in practice, how long it takes, and how iranti bootstraps before it has accumulated context are all open. No decisions made yet."

The PRD explicitly parks this: cold start learning is not required for done-enough.

## Possible directions (not decided)

- **Onboarding ingest** — users provide existing docs, READMEs, or project context at setup time. iranti processes these as initial facts.
- **System defaults** — iranti ships with a set of common developer preferences and conventions as a starting point.
- **Adaptive cold start** — iranti detects that it is in a cold start state and adjusts its behaviour (more conservative retrieval, more aggressive write routing to accumulate context quickly).
- **Nothing** — the system simply starts empty and becomes useful after a few sessions. This may be acceptable.

## Open questions

- Is cold start a real problem in practice, or do users become comfortable with it being empty at first?
- How long does it take iranti to become meaningfully useful on a real project?
- Does the onboarding experience need to address cold start explicitly?

## Prerequisites before writing this spec

- iranti-core done enough and in real use
- Data on how long it actually takes to become useful on a new project (requires real users)

---

_Come back here after iranti is in real use and there is data on the cold start experience._
