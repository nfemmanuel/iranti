// BENCH-1 — shared reader / answer-generation stage (D9, fairness-critical).
//
// One reader model + one prompt for every system's retrieved context. This
// is the LoCoMo/LongMemEval "Justify"/QA step: a memory system's ONLY scored
// contribution is `retrieved` (bench/competitive/types.ts's QueryResult);
// this function composes the answer the judge (judge.ts) then grades,
// identically for every system, so a system with a fancier built-in
// answer-writer cannot win on composition instead of memory (types.ts's
// ComposeAnswer contract, PRD §5 D9).
//
// Prompt fidelity: the template below is LongMemEval's OWN published
// direct-answer prompt, pulled verbatim from
// https://raw.githubusercontent.com/xiaowu0162/LongMemEval/main/src/generation/run_generation.py
// (`prepare_prompt`'s `answer_prompt_template` for the non-CoT,
// no-merge-key-expansion branch — the base case, since this harness doesn't
// do chain-of-thought answers or key-expansion merging):
//
//   'I will give you several history chats between you and a user. Please
//   answer the question based on the relevant chat history.
//
//
//   History Chats:
//
//   {}
//
//   Current Date: {}
//   Question: {}
//   Answer:'
//
// (Python `{}` positional slots, in order: history_string, question_date,
// question_string — see prepare_prompt's final `.format(history_string,
// question_date_string, question_string)` call.) Reused for EVERY dataset
// this harness runs (not just LongMemEval-S) per PRD D9's "one reader model
// + one prompt per track, applied to every system" — coding-continuity and
// (later) LoCoMo answers are composed with this same template so the reader
// stage never becomes a second place per-dataset unfairness could hide.
//
// Request shaping reuses src/extract/index.ts's already-fixed
// anthropic-host handling verbatim: `temperature: 0` is OMITTED for
// anthropic.com hosts (that endpoint pairing rejects the parameter — see
// extract/index.ts's `_extractFresh` comment and the curl reproduction it
// documents), and auth headers follow buildHeaders' contract (Authorization
// Bearer + x-api-key, anthropic-version added only for anthropic.com hosts).
// The key is read from process.env only, per bench/.env being loaded by the
// runner (see src/tests/setup.ts's dotenv convention) — never hardcoded,
// never logged.

import type { ComposeAnswer, ReaderConfig } from "./types.js";

// Recorded in ResultRow.readerPromptRef (types.ts) for reproducibility —
// pins the exact upstream file this prompt was pulled from.
export const READER_PROMPT_REF =
  "longmemeval/src/generation/run_generation.py@prepare_prompt(direct-answer,no-cot,no-merge)";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const READER_MAX_TOKENS = 500;

// LongMemEval's own template, reproduced byte-for-byte (see file header).
// Python's `{}` positional formatting becomes explicit history/date/question
// slots here.
function renderPrompt(history: string, currentDate: string, question: string): string {
  return `I will give you several history chats between you and a user. Please answer the question based on the relevant chat history.\n\n\nHistory Chats:\n\n${history}\n\nCurrent Date: ${currentDate}\nQuestion: ${question}\nAnswer:`;
}

// Renders retrieved[] into the single `{history}` slot LongMemEval's prompt
// expects. Each retrieved snippet becomes one "### Session N" block, mirroring
// run_generation.py's own `'\n### Session {}:\n...'` history_string assembly
// (retriever_type in ["orig-session","flat-session","oracle-session"]
// branch) closely enough for prompt-shape fidelity without depending on that
// function's session-date/retrieval-result bookkeeping, which this harness's
// `retrieved: string[]` (already-rendered snippets, not raw session objects)
// doesn't carry.
function renderHistory(retrieved: string[]): string {
  return retrieved.map((snippet, i) => `### Session ${i + 1}:\n${snippet}`).join("\n\n");
}

// Same auth-header contract as src/extract/index.ts's buildHeaders: send
// BOTH Authorization Bearer and x-api-key (harmless if a given provider
// ignores one), and add anthropic-version only for an anthropic.com host.
// Reimplemented locally rather than imported so bench/competitive/ has zero
// production-code import edges (per types.ts's header comment: "does not
// import from or modify src/harness/ scoring" — the same isolation applies
// to src/extract/ by the same logic, this tree only reuses the *pattern*).
function buildAnthropicHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
  };
  if (ANTHROPIC_MESSAGES_URL.includes("anthropic.com")) {
    headers["anthropic-version"] = ANTHROPIC_VERSION;
  }
  return headers;
}

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

// D9's composeAnswer: retrieved context -> composed answer, via ONE fixed
// reader model + prompt. `config.readerModel` selects the model
// (e.g. "claude-sonnet-5"); the prompt is fixed regardless of which system
// produced `retrieved`.
export const composeAnswer: ComposeAnswer = async (
  question: string,
  retrieved: string[],
  config: ReaderConfig,
): Promise<string> => {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "reader.ts: ANTHROPIC_API_KEY is not set in process.env (expected to be loaded from bench/.env by the runner)",
    );
  }

  const history = renderHistory(retrieved);
  // LongMemEval's own `question_date` slot pins the "as of" date for
  // temporal-reasoning questions; this harness doesn't carry a distinct
  // question_date separate from "now" for every dataset, so today's date
  // (ISO, date-only) fills that slot uniformly. Coding-continuity and
  // longmemeval-s both flow through the exact same call, so this choice is
  // identical for every system and every dataset — never a per-system knob.
  const currentDate = new Date().toISOString().slice(0, 10);
  const prompt = renderPrompt(history, currentDate, question);

  // anthropic.com hosts reject an explicit `temperature: 0` on some
  // model/endpoint pairings (src/extract/index.ts's documented, reproduced
  // 400 — "`temperature` is deprecated for this model"); omit it here for
  // the same reason, on the same host check, so this stays byte-consistent
  // with the one place in this codebase that already hit this failure mode.
  const isAnthropicHost = ANTHROPIC_MESSAGES_URL.includes("anthropic.com");
  const body: Record<string, unknown> = {
    model: config.readerModel,
    max_tokens: READER_MAX_TOKENS,
    messages: [{ role: "user", content: prompt }],
  };
  if (!isAnthropicHost) {
    body["temperature"] = 0;
  }

  const res = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: buildAnthropicHeaders(apiKey),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // Never include the request body/headers in the error (the prompt could
    // carry a retrieved snippet, and headers carry the key) — status/text
    // only.
    throw new Error(`reader.ts: Anthropic Messages API returned ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as AnthropicMessagesResponse;
  const text = json.content?.find((block) => block.type === "text")?.text;
  return text?.trim() ?? "";
};
