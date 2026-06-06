# Usage analytics

**Status:** template  
**Group:** Observability and accounts · **Phase:** 7  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

Opt-out behavioural telemetry sent back to the developer.

## Why it matters

Understanding how iranti is actually used in practice is essential for improving it. The analytics are designed to answer real product questions without ever including session content.

## The hard constraint

No metric ever includes the content of a fact, conversation, or session. Analytics carry behavioural metadata only. This is a hard constraint, not a preference. It protects users, avoids GDPR exposure, and ensures that intercepted telemetry reveals nothing meaningful about what users are working on.

## What is collected

**Primary signal:**
- **Disconnect rate** — whether someone is still connected after 30 days. This is the most important signal. Downloads show interest. Continued connection shows value.

**Other product signals:**
- Active installations and active instances per week
- Projects and repos connected per installation
- Sessions per project per week
- Host distribution (Claude Code, Codex, SDK)
- Tokens used per session (proxy for session depth)
- Attend call volume per session
- Fact count per project over time
- Correction-to-injection ratio (proxy for recall quality)

## What is never collected

- Fact values or summaries
- Message content of any kind
- User identity beyond an anonymised installation identifier
- Session content in any form
- Anything that would allow reading what a user is working on

## Opt-out

Analytics are on by default and opt-out. A single config flag disables all telemetry. When telemetry is disabled, nothing crosses the wire.

## User stories

- As the iranti developer, I want to know which host types are most popular so that I can prioritise integration work.
- As the iranti developer, I want to see the disconnect rate trend so that I can measure whether iranti is actually providing value over time.
- As an iranti user, I want to be able to disable telemetry completely with a single config option.

## Acceptance criteria

- [ ] Telemetry is opt-out with a single config flag
- [ ] The telemetry pipeline is active even before external installs exist (ready to receive data)
- [ ] All listed product signals are collected when telemetry is on
- [ ] No session content, fact values, or user-identifiable information ever crosses the wire
- [ ] The anonymised installation identifier is generated locally and never linked to identity
- [ ] Disconnect rate is calculable from the collected data

## Technical notes

_Fill in when ready to build (Phase 7). Cover: telemetry pipeline architecture, how events are queued and sent, anonymised ID generation, opt-out implementation, data retention policy._

## Dependencies

- Session ledger in place (Phase 7) — telemetry events reference session ledger events
- Agent registry in place (Phase 7)

## Related specs

- [Session ledger](session-ledger.md) — staff events are the source of telemetry events
- [Cloud account and backup](cloud-account-backup.md) — cloud accounts create a richer analytics surface for opted-in users
- [GDPR compliance](../../deferred/gdpr-compliance.md) — analytics must be GDPR-compliant
