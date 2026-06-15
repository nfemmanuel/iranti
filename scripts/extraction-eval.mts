// One-off evaluation harness (not part of the build).
// Runs the real HeuristicExtractor against actual Claude Code + Codex
// transcripts to measure precision/recall of the universal extraction floor.
//
// Run: npx tsx scripts/extraction-eval.mts
//
// It does NOT touch the database — HeuristicExtractor is pure.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HeuristicExtractor } from "../src/extract/index.js";

const extractor = new HeuristicExtractor();

const CLAUDE_ROOT = "C:/Users/NF/.claude/projects";
const CODEX_DIRS = [
  "C:/Users/NF/.codex/sessions",
  "C:/Users/NF/.codex/archived_sessions",
];

const MAX_FILES_PER_SOURCE = 10;
const MAX_LINES_PER_FILE = 4000;

interface Msg {
  role: string;
  text: string;
  file: string;
}

// ---- transcript discovery -------------------------------------------------

function walkJsonl(dir: string, skipSubagents: boolean): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (skipSubagents && (e === "subagents" || e === "workflows")) continue;
      out.push(...walkJsonl(p, skipSubagents));
    } else if (e.endsWith(".jsonl")) {
      out.push(p);
    }
  }
  return out;
}

// ---- text extraction from each host's line format -------------------------

function textFromClaudeLine(obj: any): Msg | null {
  const m = obj?.message;
  if (!m || (m.role !== "user" && m.role !== "assistant")) return null;
  let text = "";
  if (typeof m.content === "string") text = m.content;
  else if (Array.isArray(m.content)) {
    text = m.content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
  }
  text = text.trim();
  if (!text) return null;
  return { role: m.role, text, file: "" };
}

function textFromCodexLine(obj: any): Msg | null {
  // Codex rollout lines vary; pull human/assistant prose where present.
  const payload = obj?.payload ?? obj;
  const role = payload?.role ?? obj?.role;
  if (role !== "user" && role !== "assistant") return null;
  let text = "";
  const content = payload?.content ?? obj?.content;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((b: any) =>
        typeof b === "string" ? b : typeof b?.text === "string" ? b.text : "",
      )
      .join("\n");
  }
  text = text.trim();
  if (!text) return null;
  return { role, text, file: "" };
}

function loadMessages(
  file: string,
  parse: (obj: any) => Msg | null,
): Msg[] {
  const msgs: Msg[] = [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return msgs;
  }
  const lines = raw.split("\n").slice(0, MAX_LINES_PER_FILE);
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const m = parse(obj);
    if (m) {
      m.file = file;
      msgs.push(m);
    }
  }
  return msgs;
}

// ---- run --------------------------------------------------------------------

interface FactHit {
  key: string;
  value: string;
  confidence: number;
  role: string;
  snippet: string;
  file: string;
}

async function run() {
  const claudeFiles = walkJsonl(CLAUDE_ROOT, true)
    .filter((f) => !f.includes("subagents") && !f.includes("workflows"))
    // prefer non-iranti projects for "normal dev" signal, but include all
    .sort()
    .slice(0, MAX_FILES_PER_SOURCE);

  const codexFiles = CODEX_DIRS.flatMap((d) => walkJsonl(d, false)).slice(
    0,
    MAX_FILES_PER_SOURCE,
  );

  const sources: Array<{ label: string; files: string[]; parse: (o: any) => Msg | null }> = [
    { label: "claude", files: claudeFiles, parse: textFromClaudeLine },
    { label: "codex", files: codexFiles, parse: textFromCodexLine },
  ];

  const hits: FactHit[] = [];
  const noFactUserSamples: string[] = [];
  let totalMsgs = 0;
  let totalUserMsgs = 0;
  let msgsYieldingFacts = 0;
  const perSource: Record<string, { files: number; msgs: number; facts: number }> = {};

  for (const src of sources) {
    perSource[src.label] = { files: src.files.length, msgs: 0, facts: 0 };
    for (const file of src.files) {
      const msgs = loadMessages(file, src.parse);
      for (const m of msgs) {
        totalMsgs++;
        perSource[src.label].msgs++;
        if (m.role === "user") totalUserMsgs++;
        // Extract from each message in isolation (mirrors per-message extraction).
        const facts = await extractor.extract(m.text);
        if (facts.length > 0) {
          msgsYieldingFacts++;
          perSource[src.label].facts += facts.length;
          for (const f of facts) {
            hits.push({
              key: f.key,
              value: f.value,
              confidence: f.confidence,
              role: m.role,
              snippet: m.text.slice(0, 200).replace(/\s+/g, " "),
              file: file.split(/[\\/]/).slice(-2).join("/"),
            });
          }
        } else if (m.role === "user" && m.text.length > 40 && noFactUserSamples.length < 40) {
          noFactUserSamples.push(m.text.slice(0, 220).replace(/\s+/g, " "));
        }
      }
    }
  }

  // ---- report ----
  console.log("==== EXTRACTION EVAL ====");
  console.log(JSON.stringify({ perSource, totalMsgs, totalUserMsgs, totalFacts: hits.length, msgsYieldingFacts }, null, 2));

  const byPrefix: Record<string, number> = {};
  for (const h of hits) {
    const prefix = h.key.split(":")[0];
    byPrefix[prefix] = (byPrefix[prefix] ?? 0) + 1;
  }
  console.log("\n==== FACTS BY CATEGORY ====");
  console.log(JSON.stringify(byPrefix, null, 2));

  console.log("\n==== ALL EXTRACTED FACTS (key | value | conf | role | snippet) ====");
  for (const h of hits) {
    console.log(`[${h.key}] "${h.value}" (${h.confidence}, ${h.role}) <= ${h.snippet}`);
  }

  console.log("\n==== SAMPLE USER MESSAGES THAT PRODUCED NO FACT (recall probe) ====");
  for (const s of noFactUserSamples) {
    console.log(`- ${s}`);
  }
}

run().catch((e) => {
  console.error("EVAL ERROR:", e);
  process.exit(1);
});
