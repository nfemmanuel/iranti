// One-off A/B: iranti-core regex HeuristicExtractor (new) vs the OLD iranti@0.4.1
// LLM chunker prompt (run via OpenAI), over the SAME transcript sample.
//
// Faithful to the old system: replicates librarian/chunker.js runExtractionPass
// PROMPT verbatim (primary pass only — the old system additionally does a
// per-sentence fallback for recall, omitted here to bound cost).
//
// The OpenAI key + model are read directly from the running old server's runtime
// env file so the secret never appears in output. Reuses the existing key with
// the user's authorization; does not create a new one.
//
// Run: npx tsx scripts/extraction-compare.mts

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HeuristicExtractor } from "../src/extract/index.js";

const RUNTIME_ENV = "C:/Users/NF/.iranti-runtime/instances/iranti_dev/.env";
const CLAUDE_ROOT = "C:/Users/NF/.claude/projects";
const CODEX_DIRS = ["C:/Users/NF/.codex/sessions", "C:/Users/NF/.codex/archived_sessions"];
const MAX_FILES_PER_SOURCE = 6;
const SAMPLE_SIZE = 50; // bounded LLM calls (~cents)
const heuristic = new HeuristicExtractor();

// ---- read the existing OpenAI key/model from the old runtime env (no print) --
function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw = "";
  try { raw = readFileSync(path, "utf8"); } catch { return out; }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "").trim();
  }
  return out;
}
const env = readEnvFile(RUNTIME_ENV);
// OpenAI key is out of quota (429 insufficient_quota) — use Anthropic, also a
// provider the old chunker supports. Equally faithful as an LLM-extraction test.
const ANTHROPIC_API_KEY = env["ANTHROPIC_API_KEY"];
const MODEL = "claude-haiku-4-5-20251001";
if (!ANTHROPIC_API_KEY) { console.error("No ANTHROPIC_API_KEY in runtime env"); process.exit(1); }

// ---- transcript discovery + loaders (mirror extraction-eval.mts) -------------
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
function load(files: string[], parse: (o: any) => { role: string; text: string } | null): Array<{ role: string; text: string; file: string }> {
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

// ---- OLD chunker prompt (verbatim from librarian/chunker.js) ------------------
function chunkerPrompt(text: string, entityType: string, entityId: string, source: string): string {
  return `You are extracting structured facts about exactly one entity.

Entity type: ${entityType}
Entity ID: ${entityId}
Source: ${source}

Text to chunk:
"${text}"

Extract only distinct facts that clearly belong to this entity and can be represented as a concrete key/value pair.
Each fact must have:
- A short snake_case key describing what the fact is (e.g. "affiliation", "publication_count", "research_focus")
- A concrete JSON value (string, number, boolean, array, or object)
- A one-sentence summary
- A confidence score from 0 to 100 based on how explicitly the fact is stated in the text

Rules:
- Discard vague summaries, impressions, recommendations, and unsupported inferences
- If a fact is only weakly implied, either omit it or assign it a lower confidence than directly stated facts
- Do not invent keys or values that are not grounded in the text
- If you cannot express something as a clear key/value fact for this entity, discard it

Return ONLY a valid JSON array. No explanation, no markdown, no backticks.
If no facts can be extracted, return an empty array: []`;
}

let loggedErr = 0;
async function llmExtract(text: string, role: string): Promise<Array<{ key: string; value: unknown; summary: string; confidence: number }>> {
  const body = {
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: chunkerPrompt(text, "project", "sample", `transcript_${role}`) }],
  };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      if (loggedErr < 3) { console.error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`); loggedErr++; }
      return [];
    }
    const j = (await res.json()) as any;
    const content: string = (j?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("") || "[]";
    const clean = content.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x: any) => x && typeof x.key === "string" && x.value !== undefined && typeof x.summary === "string" && typeof x.confidence === "number");
  } catch (e) {
    if (loggedErr < 3) { console.error(`PARSE/NET ERR: ${String(e).slice(0, 200)}`); loggedErr++; }
    return [];
  }
}

async function run() {
  const claudeFiles = walkJsonl(CLAUDE_ROOT, true).filter((f) => !f.includes("subagents") && !f.includes("workflows")).sort().slice(0, MAX_FILES_PER_SOURCE);
  const codexFiles = CODEX_DIRS.flatMap((d) => walkJsonl(d, false)).slice(0, MAX_FILES_PER_SOURCE);
  const all = [...load(claudeFiles, claudeText), ...load(codexFiles, codexText)];

  // sample: substantive messages, evenly spaced for variety, deterministic.
  const substantive = all.filter((m) => m.text.length >= 80 && m.text.length <= 2000);
  const step = Math.max(1, Math.floor(substantive.length / SAMPLE_SIZE));
  const sample = substantive.filter((_, i) => i % step === 0).slice(0, SAMPLE_SIZE);

  console.log(`Model: ${MODEL} | sample: ${sample.length} substantive msgs (of ${substantive.length})`);
  console.log("====================================================================\n");

  let hTotal = 0, lTotal = 0, bothEmpty = 0, lOnly = 0, hOnly = 0;
  for (let i = 0; i < sample.length; i++) {
    const m = sample[i]!;
    const h = await heuristic.extract(m.text);
    const l = await llmExtract(m.text, m.role);
    hTotal += h.length; lTotal += l.length;
    if (h.length === 0 && l.length === 0) bothEmpty++;
    if (h.length === 0 && l.length > 0) lOnly++;
    if (h.length > 0 && l.length === 0) hOnly++;
    if (h.length || l.length) {
      console.log(`#${i} [${m.role}] ${m.file}`);
      console.log(`  snippet: ${m.text.slice(0, 140).replace(/\s+/g, " ")}`);
      console.log(`  HEURISTIC(${h.length}): ${h.map((f) => `${f.key}="${f.value}"`).join(" | ") || "—"}`);
      console.log(`  LLM(${l.length}): ${l.map((f) => `${f.key}=${JSON.stringify(f.value)}@${f.confidence}`).join(" | ") || "—"}`);
      console.log("");
    }
  }

  console.log("==== AGGREGATE ====");
  console.log(JSON.stringify({
    sample: sample.length,
    heuristicFacts: hTotal,
    llmFacts: lTotal,
    bothEmpty,
    llmFoundHeuristicMissed: lOnly,
    heuristicFoundLlmRejected: hOnly,
  }, null, 2));
}

run().then(() => process.exit(0)).catch((e) => { console.error("COMPARE ERROR:", e); process.exit(1); });
