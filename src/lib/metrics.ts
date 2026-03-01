type CounterName =
  | "llm.calls"
  | "llm.failures"
  | "llm.cache_hit"
  | "llm.cache_miss"
  | "db.queries"
  | "librarian.created"
  | "librarian.updated"
  | "librarian.rejected"
  | "librarian.escalated"
  | "archivist.processed"
  | "archivist.resolutions_applied";

type TimerName =
  | "attendant.handshake_ms"
  | "attendant.observe_ms"
  | "attendant.reconvene_ms"
  | "librarian.write_ms"
  | "llm.latency_ms"
  | "archivist.cycle_ms";

const counters: Record<string, number> = {};
const timers: Record<string, number[]> = {};

export function inc(name: CounterName, by: number = 1) {
  counters[name] = (counters[name] ?? 0) + by;
}

export function timeStart(): number {
  return Date.now();
}

export function timeEnd(name: TimerName, startMs: number) {
  const dur = Date.now() - startMs;
  if (!timers[name]) timers[name] = [];
  timers[name].push(dur);
}

export function snapshot() {
  return {
    counters: { ...counters },
    timers: Object.fromEntries(
      Object.entries(timers).map(([k, v]) => [
        k,
        { count: v.length, avg: avg(v), p95: p95(v), max: Math.max(...v) },
      ])
    ),
  };
}

export function reset() {
  for (const k of Object.keys(counters)) delete counters[k];
  for (const k of Object.keys(timers)) delete timers[k];
}

function avg(arr: number[]) {
  return arr.reduce((a, b) => a + b, 0) / Math.max(arr.length, 1);
}

function p95(arr: number[]) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
}
