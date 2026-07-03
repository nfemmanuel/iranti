// Detached background-work registry — root fix for backlog RULE-2.
//
// iranti fires several chains fire-and-forget so they never block a
// response: attend()'s post-response chain (edge recording → extraction →
// attend-log → metrics) and writeFact()'s post-commit side effects
// (supersession reliability, deep-conflict check, write-time edges). On
// embedded PGlite (single connection), closing the store while one of
// those chains has a query in flight leaves that query's promise pending
// FOREVER — PGlite's teardown neither resolves nor rejects it — hanging
// the whole process. A host that shuts down immediately after a turn hit
// exactly this (reproduced during the Layer 0d build; previously papered
// over with 300ms sleeps in individual test files).
//
// The fix: every detached chain registers here at the moment it's fired,
// and closeDb()/the PGlite pool.end() shim settle the registry (bounded)
// BEFORE tearing the connection down. Chains stay fire-and-forget for the
// response path — nothing awaits them except teardown.
//
// No imports from connection.ts/facts.ts here (they import US) — this
// module must stay dependency-free to avoid cycles.

const pending = new Set<Promise<unknown>>();

// Register a detached chain. Replaces the bare `void promise` idiom at the
// fire site: same non-blocking semantics, but teardown can find it.
// Rejections are swallowed here — every fire site already attaches its own
// .catch() logging; the registry must never introduce unhandled rejections.
export function trackBackground(work: Promise<unknown>): void {
  const entry: Promise<unknown> = work
    .catch(() => undefined)
    .finally(() => {
      pending.delete(entry);
    });
  pending.add(entry);
}

// How many detached chains are still in flight (test observability).
export function pendingBackgroundCount(): number {
  return pending.size;
}

// Await all currently-tracked work, bounded by timeoutMs. Loops because a
// settling chain can register follow-on work. Returns true when the
// registry drained, false on deadline (caller proceeds with teardown
// anyway — a bounded wait beats both an unbounded hang and a blind close).
export async function settleBackground(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, remaining);
    });
    await Promise.race([Promise.allSettled([...pending]), timeout]);
    if (timer) clearTimeout(timer);
  }
  return true;
}
