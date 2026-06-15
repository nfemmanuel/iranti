// Test the OLD iranti@0.4.1 MOCK provider's extractFactsFromText on the SAME
// 50-msg sample, to see whether its deterministic extraction is a viable
// general extractor or just a benchmark fixture.
//
// The function below is copied VERBATIM from
//   C:/Users/NF/AppData/Roaming/npm/node_modules/iranti/dist/src/lib/providers/mock.js
// (extractFactsFromText, lines 121-229) so this is the real old behavior.
//
// Run: npx tsx scripts/mock-extract-eval.mts

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CLAUDE_ROOT = "C:/Users/NF/.claude/projects";
const CODEX_DIRS = ["C:/Users/NF/.codex/sessions", "C:/Users/NF/.codex/archived_sessions"];
const MAX_FILES_PER_SOURCE = 6;
const SAMPLE_SIZE = 50;

function titleCase(s: string) { return s.trim().replace(/\b\w/g, (c) => c.toUpperCase()); }
function heuristicEntityId(s: string) { return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); }

// ---- VERBATIM from old mock.js extractFactsFromText ----
function extractFactsFromText(text: string): Array<{ key: string; value: unknown; confidence: number }> {
  const facts: Array<{ key: string; value: unknown; summary: string; confidence: number }> = [];
  const trimmed = text.trim();
  if (!trimmed || /no durable facts/i.test(trimmed)) return facts;
  const pushFact = (fact: any) => { if (!facts.some((e) => e.key === fact.key)) facts.push(fact); };
  const cityMatch = trimmed.match(/\b(?:currently\s+)?operates in\s+([A-Za-z][A-Za-z\s-]+?)(?:[.!,]|$)/i);
  if (cityMatch) pushFact({ key: "hq_city", value: { city: titleCase(cityMatch[1]!) }, summary: "", confidence: 96 });
  const teamMatch = trimmed.match(/\bhas\s+(\d+)\s+employees\b/i);
  if (teamMatch) pushFact({ key: "team_size", value: { count: Number(teamMatch[1]) }, summary: "", confidence: 95 });
  const runwayMatch = trimmed.match(/\bhas\s+(\d+)\s+months?\s+of\s+runway\b/i);
  if (runwayMatch) pushFact({ key: "runway_months", value: { months: Number(runwayMatch[1]) }, summary: "", confidence: 93 });
  const pilotMatch = trimmed.match(/\bhas\s+(\d+)\s+pilots?\b/i);
  if (pilotMatch) pushFact({ key: "pilot_count", value: { count: Number(pilotMatch[1]) }, summary: "", confidence: 95 });
  const expansionMatch = trimmed.match(/\bcould be expanding into\s+([a-z][a-z\s-]+?)(?:\s+next year|[.!,]|$)/i);
  if (expansionMatch) pushFact({ key: "expansion_target", value: { market: heuristicEntityId(expansionMatch[1]!).replace(/_/g, " ") }, summary: "", confidence: 38 });
  const budgetMatch = trimmed.match(/\bbudget of\s+(\d[\d,]*)\s*(usd|eur|gbp)\b/i);
  if (budgetMatch) pushFact({ key: "budget", value: { amount: Number(budgetMatch[1]!.replace(/,/g, "")), currency: budgetMatch[2]!.toUpperCase() }, summary: "", confidence: 91 });
  const publicationsMatch = trimmed.match(/\bhas\s+(\d+)\s+publications?\b/i);
  if (publicationsMatch) pushFact({ key: "publication_count", value: { count: Number(publicationsMatch[1]) }, summary: "", confidence: 93 });
  const professorMatch = trimmed.match(/\bis a professor at\s+([A-Za-z][A-Za-z\s().-]+?)(?:[.!,]|$)/i);
  if (professorMatch) pushFact({ key: "affiliation", value: { institution: professorMatch[1]!.trim() }, summary: "", confidence: 92 });
  const focusMatch = trimmed.match(/\bresearch focus:\s*([A-Za-z][A-Za-z\s-]+?)(?:[.!,]|$)/i);
  if (focusMatch) pushFact({ key: "research_focus", value: { primary: focusMatch[1]!.trim().toLowerCase() }, summary: "", confidence: 88 });
  const favoriteCityMatch = trimmed.match(/\bfavorite city is\s+([A-Za-z][A-Za-z\s-]+?)(?:[.!,]|$)/i);
  if (favoriteCityMatch) pushFact({ key: "favorite_city", value: { city: titleCase(favoriteCityMatch[1]!) }, summary: "", confidence: 92 });
  return facts;
}

// ---- loaders (same sample as the other eval scripts) ----
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
function claudeText(o: any) { const m = o?.message; if (!m || (m.role !== "user" && m.role !== "assistant")) return null; let t = ""; if (typeof m.content === "string") t = m.content; else if (Array.isArray(m.content)) t = m.content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n"); t = t.trim(); return t ? { role: m.role, text: t } : null; }
function codexText(o: any) { const p = o?.payload ?? o; const role = p?.role ?? o?.role; if (role !== "user" && role !== "assistant") return null; let t = ""; const c = p?.content ?? o?.content; if (typeof c === "string") t = c; else if (Array.isArray(c)) t = c.map((b: any) => typeof b === "string" ? b : typeof b?.text === "string" ? b.text : "").join("\n"); t = t.trim(); return t ? { role, text: t } : null; }
function load(files: string[], parse: (o: any) => any) { const msgs: any[] = []; for (const f of files) { let raw = ""; try { raw = readFileSync(f, "utf8"); } catch { continue; } for (const line of raw.split("\n").slice(0, 4000)) { if (!line.trim()) continue; let o: any; try { o = JSON.parse(line); } catch { continue; } const m = parse(o); if (m) msgs.push(m); } } return msgs; }

const claudeFiles = walkJsonl(CLAUDE_ROOT, true).filter((f) => !f.includes("subagents") && !f.includes("workflows")).sort().slice(0, MAX_FILES_PER_SOURCE);
const codexFiles = CODEX_DIRS.flatMap((d) => walkJsonl(d, false)).slice(0, MAX_FILES_PER_SOURCE);
const all = [...load(claudeFiles, claudeText), ...load(codexFiles, codexText)];
const substantive = all.filter((m) => m.text.length >= 80 && m.text.length <= 2000);
const step = Math.max(1, Math.floor(substantive.length / SAMPLE_SIZE));
const sample = substantive.filter((_, i) => i % step === 0).slice(0, SAMPLE_SIZE);

let total = 0;
for (const m of sample) {
  const f = extractFactsFromText(m.text);
  if (f.length) { total += f.length; console.log(`HIT: ${f.map((x) => x.key).join(",")} <= ${m.text.slice(0, 90).replace(/\s+/g, " ")}`); }
}
console.log("==== OLD MOCK EXTRACTOR ====");
console.log(JSON.stringify({ sample: sample.length, mockFacts: total }, null, 2));
