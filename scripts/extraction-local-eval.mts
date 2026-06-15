// Empirical local-extraction-quality test (OD-2): run qwen2.5:7b via local Ollama
// with the RECOMMENDED config (schema-constrained decoding + temperature 0 + seed)
// over the SAME 50-message transcript sample used by extraction-compare.mts, and
// report against the heuristic floor (known = 0 facts on this sample).
//
// Run: npx tsx scripts/extraction-local-eval.mts

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HeuristicExtractor } from "../src/extract/index.js";

const OLLAMA = "http://localhost:11434/api/chat";
const MODEL = "qwen2.5:7b";
const CLAUDE_ROOT = "C:/Users/NF/.claude/projects";
const CODEX_DIRS = ["C:/Users/NF/.codex/sessions", "C:/Users/NF/.codex/archived_sessions"];
const MAX_FILES_PER_SOURCE = 6;
const SAMPLE_SIZE = 50;
const heuristic = new HeuristicExtractor();

// ---- transcript loaders (same as extraction-compare.mts) --------------------
function walkJsonl(dir: string, skipSub: boolean): string[] {
  const out: string[] = [];
  let entries: string[]; try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e); let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (skipSub && (e === "subagents" || e === "workflows")) continue; out.push(...walkJsonl(p, skipSub)); }
    else if (e.endsWith(".jsonl")) out.push(p);
  }
  return out;
}
function claudeText(o: any): { role: string; text: string } | null {
  const m = o?.message; if (!m || (m.role !== "user" && m.role !== "assistant")) return null;
  let t = ""; if (typeof m.content === "string") t = m.content;
  else if (Array.isArray(m.content)) t = m.content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n");
  t = t.trim(); return t ? { role: m.role, text: t } : null;
}
function codexText(o: any): { role: string; text: string } | null {
  const p = o?.payload ?? o; const role = p?.role ?? o?.role; if (role !== "user" && role !== "assistant") return null;
  let t = ""; const c = p?.content ?? o?.content;
  if (typeof c === "string") t = c;
  else if (Array.isArray(c)) t = c.map((b: any) => typeof b === "string" ? b : typeof b?.text === "string" ? b.text : "").join("\n");
  t = t.trim(); return t ? { role, text: t } : null;
}
function load(files: string[], parse: (o: any) => { role: string; text: string } | null) {
  const msgs: Array<{ role: string; text: string; file: string }> = [];
  for (const f of files) {
    let raw = ""; try { raw = readFileSync(f, "utf8"); } catch { continue; }
    for (const line of raw.split("\n").slice(0, 4000)) {
      if (!line.trim()) continue; let o: any; try { o = JSON.parse(line); } catch { continue; }
      const m = parse(o); if (m) msgs.push({ ...m, file: f.split(/[\\/]/).slice(-2).join("/") });
    }
  }
  return msgs;
}

const SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: { type: "string" },
          summary: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["key", "value", "summary", "confidence"],
      },
    },
  },
  required: ["facts"],
};

function prompt(text: string): string {
  return `You are extracting structured DURABLE facts from a message for long-term memory.
Extract only distinct facts that can be represented as a concrete key/value pair and would matter to a future session.
Each fact: a short snake_case key, a concrete value, a one-sentence summary, a confidence 0-1.
Discard vague summaries, impressions, recommendations, transient status ("typecheck is clean"), and unsupported inferences.
Do not invent anything not grounded in the text. If nothing qualifies, return an empty list.

Text:
"${text}"

Return a JSON object: {"facts": [ {"key": ..., "value": ..., "summary": ..., "confidence": ...} ]}`;
}

let errs = 0;
async function localExtract(text: string): Promise<Array<{ key: string; value: string; confidence: number }>> {
  const body = {
    model: MODEL,
    stream: false,
    format: SCHEMA,
    options: { temperature: 0, seed: 42, num_ctx: 8192 },
    messages: [{ role: "user", content: prompt(text) }],
  };
  try {
    const res = await fetch(OLLAMA, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) { if (errs++ < 3) console.error(`HTTP ${res.status}`); return []; }
    const j = (await res.json()) as any;
    const parsed = JSON.parse(j?.message?.content ?? "{}");
    const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
    return facts.filter((f: any) => f && typeof f.key === "string" && f.value !== undefined);
  } catch (e) { if (errs++ < 3) console.error(`ERR ${String(e).slice(0, 120)}`); return []; }
}

async function run() {
  const claudeFiles = walkJsonl(CLAUDE_ROOT, true).filter((f) => !f.includes("subagents") && !f.includes("workflows")).sort().slice(0, MAX_FILES_PER_SOURCE);
  const codexFiles = CODEX_DIRS.flatMap((d) => walkJsonl(d, false)).slice(0, MAX_FILES_PER_SOURCE);
  const all = [...load(claudeFiles, claudeText), ...load(codexFiles, codexText)];
  const substantive = all.filter((m) => m.text.length >= 80 && m.text.length <= 2000);
  const step = Math.max(1, Math.floor(substantive.length / SAMPLE_SIZE));
  const sample = substantive.filter((_, i) => i % step === 0).slice(0, SAMPLE_SIZE);

  console.log(`Local model: ${MODEL} (schema-constrained, temp0, seed42) | sample: ${sample.length}`);
  console.log("====================================================================\n");

  let hTotal = 0, lTotal = 0, bothEmpty = 0, lOnly = 0;
  const t0 = Date.now();
  for (let i = 0; i < sample.length; i++) {
    const m = sample[i]!;
    const h = await heuristic.extract(m.text);
    const l = await localExtract(m.text);
    hTotal += h.length; lTotal += l.length;
    if (h.length === 0 && l.length === 0) bothEmpty++;
    if (h.length === 0 && l.length > 0) lOnly++;
    if (l.length) {
      console.log(`#${i} [${m.role}] ${m.file}`);
      console.log(`  snippet: ${m.text.slice(0, 130).replace(/\s+/g, " ")}`);
      console.log(`  LOCAL(${l.length}): ${l.map((f) => `${f.key}=${JSON.stringify(f.value)}@${f.confidence}`).join(" | ")}`);
      console.log("");
    }
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log("==== AGGREGATE ====");
  console.log(JSON.stringify({ sample: sample.length, heuristicFacts: hTotal, localLlmFacts: lTotal, msgsLocalFoundHeuristicMissed: lOnly, bothEmpty, wallSecs: Number(secs), avgPerMsg: (lTotal / sample.length).toFixed(1) }, null, 2));
}

run().then(() => process.exit(0)).catch((e) => { console.error("FATAL:", e); process.exit(1); });
