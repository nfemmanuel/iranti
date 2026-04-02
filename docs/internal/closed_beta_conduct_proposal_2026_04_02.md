# Closed Beta Conduct Proposal — 2026-04-02

This document proposes how to run Iranti's first closed beta in a way that gives us useful signal instead of vague "seems cool" feedback.

It is intentionally practical. The goal is not to maximize signups. The goal is to learn whether Iranti materially improves continuity for people who do serious AI-assisted coding and repeatedly start, stop, hand off, or resume work.

## Working Thesis

Iranti's first closed beta should target people who:

1. use AI heavily for coding
2. regularly switch sessions, restart context, or hand work across sessions/tools
3. are comfortable enough with terminal and repo workflows to notice whether continuity improved or not

This means the strongest early-fit cohort is probably:

- heavy Claude Code / Codex / CLI users
- people who actively stop and resume work instead of living in one endless chat
- developers who already feel the pain of rediscovery, missing context, repeated explanation, and tool handoff friction

This also means the least useful early cohort is probably:

- casual AI chat users
- people who mostly stay in one long VS Code extension thread and rarely restart
- people who are excited by "AI memory" as an idea but do not actually have a continuity problem in daily work

## Primary Beta User Profile

The best first beta users are:

1. individual developers or technical founders doing real coding work with AI
2. agents-first users who touch terminal/CLI workflows often
3. people who naturally create discontinuity:
   - new session every few hours
   - multiple repos
   - multiple tools
   - switching between laptop/desktop
   - handoff from one model or host to another

Examples:

- "I use Claude Code and Codex every day and I keep losing context when I restart."
- "I use AI for implementation, debugging, and repo exploration, but I never trust it to remember what already happened."
- "I do a lot of command-line work and multi-session debugging, and I want memory to survive that."

## Secondary Beta User Profile

A second wave could include:

- VS Code extension users who still start fresh chats frequently
- small teams experimenting with multiple AI hosts
- people doing long-running product or debugging work where checkpoints matter

But I would not center the first beta on them unless they also show the continuity pain clearly.

## What The Beta Should Prove

The beta should answer these questions:

1. Does Iranti reduce rediscovery during resumed coding sessions?
2. Does Iranti make cross-session continuity feel materially better than "start over and re-explain"?
3. Does Iranti make cross-host or cross-tool handoff feel real rather than gimmicky?
4. Are the setup, status, and memory surfaces truthful enough that users trust what Iranti says?
5. Do users naturally adopt the memory loop, or do they fight it constantly?

The first beta does **not** need to prove every future product idea. It only needs to prove the continuity core strongly enough that the next wave is obvious.

## Required Workflows For Closed Beta

A user in the beta should be able to do these successfully:

1. Set up Iranti without feeling lost
2. Bind a project and understand what runtime/DB/authority is actually active
3. Start a coding session with a supported AI host
4. Stop and resume later without major rediscovery pain
5. Recover:
   - current step
   - next step
   - important file changes
   - relevant risks / blockers
6. In at least some cases, hand off work across sessions or hosts and feel that the memory mattered

If these are not reliable, the beta is too early.

## Acceptable Rough Edges

These are probably okay for a first closed beta:

- some retrieval misses in edge cases
- some prompts still needing explicit hints
- rough internal docs or operator surfaces
- partial host coverage
- some advanced workflows still feeling "expert mode"

As long as:

- the system is truthful
- the failures are understandable
- the core continuity value is still real

## Unacceptable Failures

These are the kinds of failures that would make the beta feel fake or frustrating:

1. Iranti claims to have memory but repeatedly loses current project state
2. Resumed sessions require heavy rediscovery anyway
3. Users cannot tell which runtime/database/project binding is actually active
4. Setup produces broken or insecure instances
5. Cross-session memory feels random rather than dependable
6. Hosts do not leave enough breadcrumbs, so the "hive mind" promise feels empty

## Recommended Cohort Size

Start smaller than your instinct wants.

Suggested size:

- first wave: 5–10 users
- second wave: 10–20 if first wave confirms continuity value

Why small:

- easier to support manually
- easier to learn from each person
- easier to spot recurring failure modes
- less pressure to pretend everything is done

## Recommended Beta Mix

I would aim for a mix like:

1. 3–5 very heavy AI coding users
2. 2–3 terminal-first / CLI-heavy users
3. 1–2 multi-host experimenters
4. optionally 1–2 VS Code-heavy users who still restart sessions frequently

The important thing is not host diversity by itself. It is continuity-pain diversity.

## Onboarding Approach

Do not throw people into a generic "use it however you want" beta.

Instead, ask them to try a few concrete scenarios:

1. Start a coding task and stop midway
2. Resume the task later in a fresh session
3. Switch to a different host or session and recover the task
4. Ask what changed, what worked, what failed, and what happens next

This gives us direct evidence on the actual promise of the product.

## Suggested Beta Script

Each beta user should be asked to try:

1. Fresh setup and project binding
2. One real coding task over at least two sessions
3. One interruption or overnight resume
4. One handoff or "pick up where I left off" attempt
5. One diagnostic or debugging flow where Iranti should preserve validated findings

## Feedback Questions That Matter

Avoid asking "did you like it?"

Ask:

1. Did Iranti save you from re-explaining context?
2. When it helped, what exactly did it save you from having to reconstruct?
3. When it failed, what was missing?
4. Did you trust what Iranti told you about the current project state?
5. Was setup/binding/runtime authority clear?
6. Did the memory loop feel natural, or did it feel like extra work?
7. Would you keep it on for real coding work?

## Success Criteria

The closed beta is going well if users say things like:

- "It actually remembered where I left off."
- "I didn’t have to re-explain the task."
- "It made restart/resume materially less annoying."
- "The handoff felt real."

The beta is not going well if users say things like:

- "Cool idea, but I still had to tell it everything again."
- "I never knew if it was looking at the right project/runtime."
- "It felt random whether memory worked."
- "It mostly created more process than value."

## How To Run The Beta Operationally

Recommended operating style:

1. Keep the cohort small and high-touch
2. Track each user's host/tool pattern
3. Log every meaningful failure mode as a canonical issue
4. Patch high-frequency continuity failures quickly
5. Keep docs and setup truthful as the system changes

## What To Instrument During Beta

We should pay close attention to:

- resumed-session success vs rediscovery
- handoff success vs handoff confusion
- setup/runtime authority confusion
- missing breadcrumbs
- retrieval misses on "what changed / what worked / what failed / what's next"
- host-specific compliance failures

## Proposed Beta Positioning

The pitch should be simple:

> Iranti gives coding agents shared persistent memory so sessions can stop, restart, and hand off work without losing the thread.

Not:

- "universal AGI memory"
- "perfect autonomous memory forever"
- anything that oversells full real-time shared consciousness

The beta should sell continuity, not magic.

## Recommendation

Proceed with a small closed beta when:

1. the top continuity blockers are reduced enough that resumed coding sessions genuinely feel better
2. setup/runtime authority is trustworthy
3. at least one or two host paths feel solid enough to support real users

If one major deep blocker remains, that is still okay **if** the core continuity story is already real for the target cohort.

## Immediate Next Use

Tomorrow morning, review this proposal against:

1. the current blocker list
2. what the overnight CLI runs actually closed
3. whether the first beta should be:
   - CLI-heavy only
   - host-limited
   - or a mixed small cohort
