// BENCH-1 — iranti-original coding-continuity dataset.
//
// No published benchmark tests cross-session continuity within a single
// coding task (docs/research/2026-07-04-memory-benchmark-methods.md §d —
// SWE-ContextBench is the closest published work, but it tests cross-*task*
// trajectory reuse, not "did the standing project decision survive the
// session boundary"). This is iranti's own methodology, kept on a
// permanently separate, distinctly labeled axis (PRD D7) — never described
// as a LongMemEval or LoCoMo number.
//
// Each case is one "continuity probe" (§d's unit of measurement): session 1
// is a realistic coding conversation that naturally states 2-4 decisions/
// constraints/failed-approaches/corrections; a session boundary follows;
// the probe question is a "silent-confirmation" probe (§d step 4, shape 2)
// — phrased as if the asker forgot, never restating or hinting at the fact
// — and `gold` is the session-1 fact it should surface. Two cases are
// negative/no-bleed-shaped instead: the fact asked about was never
// established, so the correct behavior is to decline (isAbstention: true),
// mirroring LongMemEval's own abstention category and reusing the same
// scoring path (falsePositiveRate-shaped, per §d step 5's cross-task bleed
// framing) rather than inventing a new one.
//
// Phrasing is authored fresh (bench/corpus/README.md's "author fresh
// sentences without looking at the pattern list" discipline, cited
// directly by §d) — conversational, not keyword-engineered, so the test
// measures memory rather than string-matching.

import type { DatasetLoader, EvalCase, WriteInput } from "../types.js";

// -----------------------------------------------------------------------
// Case authoring.
// -----------------------------------------------------------------------

// One coding-continuity case: a session-1 transcript (rendered as a single
// WriteInput per the task's "keep it real and specific, not toy" ask — one
// coherent conversation, not turn-by-turn fragments), a session boundary,
// and the session-2 probe. `sessionBoundary: 0` on the lone history entry
// marks it as "session 1" of this case's own two-session structure (the
// coding-continuity dataset's private numbering — unrelated to any other
// case's sessions, since each EvalCase.id is its own isolation scope per
// types.ts's Adapter.write contract).
interface ContinuityCase {
  id: string;
  // Session-1 conversation: realistic, multi-turn, states the fact(s)
  // naturally along the way (never as an isolated keyword-shaped sentence).
  session1: string;
  // The session-2 silent-confirmation probe — must NOT restate or hint at
  // the fact (§d step 4).
  question: string;
  // The session-1 decision/constraint/failed-approach/correction the probe
  // is testing recall of. Empty string + isAbstention:true for the two
  // negative cases (nothing to recall — the correct behavior is decline).
  gold: string;
  isAbstention?: boolean;
}

const CASES: ContinuityCase[] = [
  {
    id: "cc-01-orm-choice",
    session1: `We're kicking off the new billing-service rewrite today. First real decision: ORM. I spent an hour comparing Prisma and Drizzle against our Postgres 16 setup — Drizzle wins for us because we need raw SQL escape hatches for the reporting queries and Prisma's query engine binary has been a pain in our Docker builds. We're using Drizzle over Prisma for the ORM, final call, no more relitigating this one. Next: logging. Right now every service rolls its own console.log wrapper and it's inconsistent garbage in production. Logging goes through pino from now on, structured JSON, one shared logger config in libs/logger. Also flagging: we tried adding a retry wrapper around the payment-provider webhook handler with no retry limit at all and it just hammered their API into a 429 loop during their last outage — that approach is dead. The retry limit is 3, with exponential backoff starting at 250ms. Let's get the skeleton committed today and pick up auth tomorrow.`,
    question: "Quick check before I scaffold the models directory — which ORM did we land on for the billing service?",
    gold: "Drizzle (chosen over Prisma)",
  },
  {
    id: "cc-02-logging-library",
    session1: `Continuing the billing-service setup from earlier. We're using Drizzle over Prisma for the ORM — that's locked in. For observability, I looked at winston vs pino vs just structured console output, and pino won on performance and the fact half our other services already emit pino-compatible JSON that our log aggregator expects. So: logging goes through pino from now on, no per-service custom wrappers. On the retry side, the retry limit is 3 for the payment-provider webhook calls, exponential backoff from 250ms — we tried unlimited retries first and it made an outage worse, so that's not up for debate again. One more thing before I forget: auth is via Clerk for this service, same as the dashboard app, so we don't have to stand up a second auth provider just for billing.`,
    question: "What library are we piping application logs through on this service?",
    gold: "pino",
  },
  {
    id: "cc-03-retry-limit",
    session1: `Picking up the payment webhook handler today. Context for whoever reads this later: we're using Drizzle over Prisma for the ORM, logging goes through pino, and auth is via Clerk — all locked from yesterday's kickoff. The thing I actually need to nail down now is retry behavior on the webhook receiver. We tried an unbounded retry loop first (just keep hitting the provider until it 200s) and it made their last outage worse by hammering a already-struggling endpoint — that approach is scrapped. The retry limit is 3, with exponential backoff starting at 250ms and doubling each attempt, then give up and dead-letter the event. That's the number product signed off on after the incident review, so don't bump it back up without going through them again.`,
    question: "Before I wire up the dead-letter fallback, remind me — how many retry attempts are we allowing on the webhook handler?",
    gold: "3 (exponential backoff starting at 250ms)",
  },
  {
    id: "cc-04-auth-provider",
    session1: `Starting the auth wiring for billing-service. Everything else from the kickoff still stands: Drizzle over Prisma, pino for logging, retry limit of 3 on the webhook handler. For auth specifically — I know we batted around rolling our own JWT issuance, but auth is via Clerk for this service, matching the dashboard app, precisely so we're not maintaining a second identity provider and a second set of session-refresh edge cases. Clerk's webhook for user.created is what seeds our local users table. Let's get that seeding job working before lunch.`,
    question: "For the user.created seeding job — which auth provider's webhook are we listening to?",
    gold: "Clerk",
  },
  {
    id: "cc-05-select-star-constraint",
    session1: `Reporting queries are next on the billing-service list. Heads up for anyone touching this file later: never use SELECT * in the reporting queries — compliance flagged it during the ledger-service audit last quarter because a schema change silently pulled a PII column into an export nobody reviewed. Every reporting query here must explicitly list columns, no exceptions, and that's why we picked Drizzle over Prisma in the first place — Drizzle lets us drop to raw parameterized SQL for these without fighting a query builder. Logging on these queries still goes through pino same as everywhere else in the service.`,
    question: "I'm about to add a new revenue-by-region report — any constraint I should know about on how these reporting queries are written?",
    gold: "never use SELECT * in reporting queries — must explicitly list columns",
  },
  {
    id: "cc-06-idempotency-approach",
    session1: `Idempotency on the checkout endpoint took longer than expected today. First pass: we tried doing idempotency with a unique constraint alone on the request ID column, and it didn't work under concurrent retries — two requests could both pass the existence check before either one's insert committed, so we still got double-charges under load. What actually works: an idempotency-key table with a row-level lock acquired via SELECT ... FOR UPDATE before the charge logic runs, and the key expires after 24 hours. That's committed now. As a reminder to future-me, this whole service runs its ORM as Drizzle, not Prisma, and all logging is pino.`,
    question: "How are we actually handling idempotency on checkout now — I remember we hit a snag with the first approach?",
    gold: "idempotency-key table with a row-level lock (SELECT ... FOR UPDATE) before charging, key expires after 24 hours — the earlier unique-constraint-only approach failed under concurrent retries",
  },
  {
    id: "cc-07-pool-size-correction",
    session1: `Quick correction from standup — I said the connection pool size for billing-service's Postgres pool was 10 earlier this week, but that was wrong. Actually, the pool size is 20, not 10 — I misspoke earlier, and I've already updated the drizzle config to match. Everything else from the kickoff is unchanged: Drizzle over Prisma, pino logging, Clerk auth, retry limit of 3 on webhooks.`,
    question: "What did we end up setting the DB connection pool size to for billing-service?",
    gold: "20",
  },
  {
    id: "cc-08-rate-limit-value",
    session1: `Rate limiting for the public billing API is done. We're capping it at 100 requests per minute per API key, using a sliding-window counter in Redis rather than a fixed-window one — fixed windows let a client burst 2x the limit right at the window boundary, and finance didn't want that exploitable on the invoice-export endpoint. Redis TTL on each window key is 90 seconds so we're not accumulating counters forever. Same service, same stack underneath: Drizzle, pino, Clerk.`,
    question: "What's the actual cap we landed on for the public API's rate limiting?",
    gold: "100 requests per minute per API key (sliding-window counter in Redis)",
  },
  {
    id: "cc-09-failed-caching-approach",
    session1: `Spent this afternoon on invoice PDF generation performance. We tried caching the rendered PDF bytes in Redis keyed by invoice ID, and it didn't work because invoices can be regenerated after a line-item correction and we had no reliable invalidation trigger — twice today it served a stale PDF after a correction. Rolled that back. What we're doing instead: render on-demand every time, but cache the expensive line-item aggregation query result (not the PDF itself) for 5 minutes, since that query is the actual bottleneck and line items rarely change within a 5-minute window. Standard stack still applies here — Drizzle, pino, retry limit 3.`,
    question: "Where did we land on speeding up invoice PDF generation, given the caching approach we tried first didn't pan out?",
    gold: "cache the line-item aggregation query result for 5 minutes (not the rendered PDF itself) — PDF caching was rolled back due to stale-PDF-after-correction issues",
  },
  {
    id: "cc-10-migration-reversibility",
    session1: `Writing the first schema migration for the new refunds table. Standing requirement I want to restate here since it's easy to forget under deadline pressure: every migration must be reversible and tested against a staging snapshot before it ships — that's been true since the original ledger-service days and it applies here too, no exceptions for "small" migrations. This one adds a nullable refund_reason column plus an index on invoice_id; down migration drops both cleanly. Same ORM and logging conventions as the rest of the service: Drizzle, pino.`,
    question: "Before I ship this next migration, what's our house rule on migrations again?",
    gold: "every migration must be reversible and tested against a staging snapshot first",
  },
  {
    id: "cc-11-abstention-caching-layer",
    session1: `Wrapped up the webhook retry logic today — retry limit of 3, exponential backoff from 250ms, same as we set at kickoff. Also finished wiring pino logging into the new refunds module and confirmed Clerk auth is working end-to-end for the refunds admin panel. Tomorrow I want to look at whether the invoice-export endpoint needs pagination, since finance mentioned some exports are getting large.`,
    question: "Just so I don't duplicate work — which caching layer (Redis, in-memory, CDN) did we settle on for the invoice-export endpoint?",
    gold: "",
    isAbstention: true,
  },
  {
    id: "cc-12-abstention-deploy-target",
    session1: `Today was mostly cleanup: renamed a few Drizzle schema files for consistency, tightened the pino log level for the webhook handler from debug to info in non-dev environments, and confirmed the retry-limit-of-3 behavior with a manual test against the provider's sandbox. Also paired with the frontend folks on what fields the Clerk-authenticated refunds panel needs from the API — nothing code-side changed there yet, just a shared doc.`,
    question: "Did we ever decide which cloud region or provider billing-service actually deploys to?",
    gold: "",
    isAbstention: true,
  },
];

// -----------------------------------------------------------------------
// Normalization to EvalCase.
// -----------------------------------------------------------------------

function toEvalCase(c: ContinuityCase): EvalCase {
  const history: WriteInput[] = [
    {
      conversation: c.session1,
      sessionBoundary: 0,
    },
  ];

  return {
    id: c.id,
    history,
    question: c.question,
    gold: c.gold,
    category: "coding-continuity",
    isAbstention: c.isAbstention,
  };
}

// -----------------------------------------------------------------------
// Loader.
// -----------------------------------------------------------------------

// Pure and synchronous under the hood (no download — this corpus is
// authored in-repo, not fetched), but the DatasetLoader contract is async,
// so this just resolves immediately. `opts.limit` returns the first N by
// the CASES array's own fixed order (already the "first N by id sort"
// convention, since CASES is authored in ascending cc-NN order).
export const loadCodingContinuity: DatasetLoader = async (opts) => {
  const sorted = [...CASES].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const limited = opts?.limit !== undefined ? sorted.slice(0, opts.limit) : sorted;
  const cases: EvalCase[] = limited.map(toEvalCase);
  return { id: "coding-continuity", cases };
};
