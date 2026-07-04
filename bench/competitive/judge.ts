// BENCH-1 — shared judge stage.
//
// Grades one composed answer (reader.ts's output) against the gold answer,
// per bench/competitive/types.ts's Judge contract. One fixed prompt family
// per track/category (D4 in docs/prds/phases/bench-1-fair-competitive-
// harness.md), reused from LongMemEval's own published judge — not
// reinvented — for every dataset this harness scores against it
// (LongMemEval-S directly, coding-continuity by explicit design choice
// since it shares the same category shape and there is no published
// coding-continuity judge to reuse; iranti-original-ness is documented on
// the ResultRow's judgePromptRef, never disguised as "the LongMemEval
// judge" for a dataset LongMemEval doesn't cover).
//
// Prompt fidelity: all 5 variants below are pulled VERBATIM from
// https://raw.githubusercontent.com/xiaowu0162/LongMemEval/main/src/evaluation/evaluate_qa.py
// (`get_anscheck_prompt`). Python `.format(question, answer, response)` /
// `.format(question, answer, response)` positional slots become explicit
// {question}/{gold}/{answer} substitutions below; the template TEXT is
// unchanged from the source, including its exact wording and punctuation:
//
//   standard (single-session-user / single-session-assistant / multi-session):
//     "I will give you a question, a correct answer, and a response from a
//     model. Please answer yes if the response contains the correct answer.
//     Otherwise, answer no. If the response is equivalent to the correct
//     answer or contains all the intermediate steps to get the correct
//     answer, you should also answer yes. If the response only contains a
//     subset of the information required by the answer, answer no. \n\n
//     Question: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the
//     model response correct? Answer yes or no only."
//
//   temporal-reasoning (off-by-one-tolerant):
//     "I will give you a question, a correct answer, and a response from a
//     model. Please answer yes if the response contains the correct answer.
//     Otherwise, answer no. If the response is equivalent to the correct
//     answer or contains all the intermediate steps to get the correct
//     answer, you should also answer yes. If the response only contains a
//     subset of the information required by the answer, answer no. In
//     addition, do not penalize off-by-one errors for the number of days.
//     If the question asks for the number of days/weeks/months, etc., and
//     the model makes off-by-one errors (e.g., predicting 19 days when the
//     answer is 18), the model's response is still correct. \n\nQuestion:
//     {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model
//     response correct? Answer yes or no only."
//
//   knowledge-update:
//     "I will give you a question, a correct answer, and a response from a
//     model. Please answer yes if the response contains the correct answer.
//     Otherwise, answer no. If the response contains some previous
//     information along with an updated answer, the response should be
//     considered as correct as long as the updated answer is the required
//     answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response:
//     {}\n\nIs the model response correct? Answer yes or no only."
//
//   single-session-preference (rubric variant):
//     "I will give you a question, a rubric for desired personalized
//     response, and a response from a model. Please answer yes if the
//     response satisfies the desired response. Otherwise, answer no. The
//     model does not need to reflect all the points in the rubric. The
//     response is correct as long as it recalls and utilizes the user's
//     personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\n
//     Model Response: {}\n\nIs the model response correct? Answer yes or no
//     only."
//
//   abstention override (any category, when isAbstention):
//     "I will give you an unanswerable question, an explanation, and a
//     response from a model. Please answer yes if the model correctly
//     identifies the question as unanswerable. The model could say that the
//     information is incomplete, or some other information is given but the
//     asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel
//     Response: {}\n\nDoes the model correctly identify the question as
//     unanswerable? Answer yes or no only."
//
// Selection logic mirrors get_anscheck_prompt's own branching (task/
// abstention params) exactly: abstention wins first (checked before
// category), then category dispatch, else the standard variant — which
// covers single-session-user/assistant/multi-session AND this harness's two
// datasets' remaining categories that LongMemEval's own function has no
// branch for (LongMemEval-S's own question_type values already match one of
// the 4 named branches or fall through to its `else: raise
// NotImplementedError`, i.e. single-session-user/assistant/multi-session
// hit its explicit first branch; coding-continuity is new and reuses that
// same first branch by design, per this file's header note above).
//
// Reply parsing: LongMemEval's own evaluate_qa.py does
// `label = 'yes' in eval_response.lower()` (substring, not a whole-word
// match) directly after `.strip()`. This file uses a word-boundary regex
// (`/\byes\b/i`) per the task brief's explicit instruction, which is
// stricter (a reply containing "yesterday" would count under the source's
// literal substring check but not here) — noted as an intentional, minor
// deviation from the literal upstream one-liner, not a fidelity gap in the
// prompt text itself.
//
// Request shaping is identical to reader.ts's (itself reusing
// src/extract/index.ts's anthropic-host temperature-omit + dual-auth-header
// pattern) — max_tokens=10 per the task brief (a yes/no reply needs very
// few tokens) and temperature=0 (omitted only for the anthropic.com host,
// same as the reader).

import type { Judge, JudgeConfig } from "./types.js";

// Recorded in ResultRow.judgePromptRef (types.ts) for reproducibility.
export const JUDGE_PROMPT_REF =
  "longmemeval/src/evaluation/evaluate_qa.py@get_anscheck_prompt(all 5 variants)";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const JUDGE_MAX_TOKENS = 10;

type JudgeCategory =
  | "single-session-user"
  | "single-session-assistant"
  | "multi-session"
  | "temporal-reasoning"
  | "knowledge-update"
  | "single-session-preference"
  | string; // coding-continuity and any other category fall through to standard.

// The 5 verbatim templates, positional slots named explicitly. Each is
// exactly the source string (see file header) with Python's trailing
// `.format(...)` slots replaced by named placeholders substituted below.
const STANDARD_TEMPLATE =
  "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {question}\n\nCorrect Answer: {gold}\n\nModel Response: {answer}\n\nIs the model response correct? Answer yes or no only.";

const TEMPORAL_REASONING_TEMPLATE =
  "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {question}\n\nCorrect Answer: {gold}\n\nModel Response: {answer}\n\nIs the model response correct? Answer yes or no only.";

const KNOWLEDGE_UPDATE_TEMPLATE =
  "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {question}\n\nCorrect Answer: {gold}\n\nModel Response: {answer}\n\nIs the model response correct? Answer yes or no only.";

const SINGLE_SESSION_PREFERENCE_TEMPLATE =
  "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {question}\n\nRubric: {gold}\n\nModel Response: {answer}\n\nIs the model response correct? Answer yes or no only.";

const ABSTENTION_TEMPLATE =
  "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {question}\n\nExplanation: {gold}\n\nModel Response: {answer}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.";

function fillTemplate(
  template: string,
  vars: { question: string; gold: string; answer: string },
): string {
  return template
    .replace("{question}", vars.question)
    .replace("{gold}", vars.gold)
    .replace("{answer}", vars.answer);
}

// Mirrors get_anscheck_prompt's branch order: abstention checked first
// (its `if not abstention: ... else: ...` structure), then category.
function selectPrompt(
  category: JudgeCategory,
  isAbstention: boolean | undefined,
  vars: { question: string; gold: string; answer: string },
): string {
  if (isAbstention) {
    return fillTemplate(ABSTENTION_TEMPLATE, vars);
  }
  switch (category) {
    case "temporal-reasoning":
      return fillTemplate(TEMPORAL_REASONING_TEMPLATE, vars);
    case "knowledge-update":
      return fillTemplate(KNOWLEDGE_UPDATE_TEMPLATE, vars);
    case "single-session-preference":
      return fillTemplate(SINGLE_SESSION_PREFERENCE_TEMPLATE, vars);
    // single-session-user, single-session-assistant, multi-session,
    // coding-continuity, and anything else: the standard variant.
    default:
      return fillTemplate(STANDARD_TEMPLATE, vars);
  }
}

// Same auth-header contract as reader.ts / src/extract/index.ts's
// buildHeaders: both Authorization Bearer and x-api-key, plus
// anthropic-version only for an anthropic.com host. Duplicated locally
// (rather than shared with reader.ts via an import) to keep each file's
// request-shaping self-contained and independently auditable against the
// upstream pattern — the two copies are intentionally identical, not
// intentionally divergent.
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

export const judge: Judge = async (input, config: JudgeConfig) => {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "judge.ts: ANTHROPIC_API_KEY is not set in process.env (expected to be loaded from bench/.env by the runner)",
    );
  }

  const prompt = selectPrompt(input.category, input.isAbstention, {
    question: input.question,
    gold: input.gold,
    answer: input.answer,
  });

  const isAnthropicHost = ANTHROPIC_MESSAGES_URL.includes("anthropic.com");
  const body: Record<string, unknown> = {
    model: config.judgeModel,
    max_tokens: JUDGE_MAX_TOKENS,
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
    throw new Error(`judge.ts: Anthropic Messages API returned ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as AnthropicMessagesResponse;
  const reply = json.content?.find((block) => block.type === "text")?.text?.trim() ?? "";

  // Task brief's explicit rule: score = /\byes\b/i.test(reply) ? 1 : 0.
  const score = /\byes\b/i.test(reply) ? 1 : 0;

  return { score, raw: reply };
};
