// iranti_attend — Phase 1
//
// The core bidirectional call. The host calls this before responding:
//
//   WRITE side: deterministic artifacts (URLs, file paths) are extracted
//   from the incoming message and stored as facts — the host doesn't have
//   to remember to store anything.
//
//   READ side: relevant rules, recent facts, and the active checkpoint for
//   the entities in scope are returned for injection into the host's context.
//
// The response is bounded: at most MAX_FACTS_PER_ENTITY facts per entity
// hint and MAX_TOTAL_FACTS overall. Facts are relevance-ranked: keyword
// overlap between the message and fact key/value scores first, with recency
// as a tiebreaker. When no message is present, pure recency is used.
// "Return everything" stops scaling within weeks of real use — the cap is
// the contract, not an implementation detail.
//
// Phase 1.2 — context window observation: when the host passes currentContext
// (the agent's visible window), facts already present there are suppressed so
// iranti never re-injects what the agent can already see. The response reports
// how many were suppressed via `alreadyPresent`. Correction of *stale* context
// (the window holds an outdated value) is Phase 3; Phase 1.2 only suppresses.

import { z } from "zod";
import type { Fact, Rule } from "../../db/schema.js";
import {
  CHECKPOINT_KEY,
  getActiveCheckpoint,
} from "../../library/checkpoints.js";
import { upsertEntity } from "../../library/entities.js";
import {
  getProjectState,
  type ProjectStateSummary,
} from "../../library/project-state.js";
import {
  VALID_SURFACES,
  findFact,
  readArchivedValuesByFactIds,
  readFactsByIds,
  readRelevantFactsByEntity,
  writeFact,
} from "../../library/facts.js";
import { getRulesForAttend } from "../../library/rules.js";
import { learnAlias, resolveAlias } from "../../library/aliases.js";
import { normalizeKey } from "../../library/keys.js";
import { graph } from "../../graph/index.js";
import { extractor } from "../../extract/index.js";
import { EXTRACT_SOURCE, extractAliases, extractArtifacts } from "../extractor.js";
import { ensureContext } from "../context.js";
import { writeAttendLog, persistMetricCounters } from "../../library/attend-log.js";
import { trackBackground } from "../../library/background.js";
import { incrementTurnCount } from "../../library/sessions.js";
import { comprehensionMetrics } from "../../library/conflicts.js";
import { searchMedia } from "../../library/media.js";
import { getEffectiveProjectIds } from "../../library/projects.js";

export const MAX_FACTS_PER_ENTITY = 10;
export const MAX_TOTAL_FACTS = 20;
// Mid-turn is a cheap top-up — small budget so it doesn't re-inject the turn.
export const MAX_MID_TURN_FACTS = 3;
// Secondary (graph-hop) peripheral facts cap. Separate from primary budget.
export const MAX_PERIPHERAL_FACTS = 10;
// Layer 0d: rules are imperative and meant to be actively read/obeyed every
// turn, not browsed like facts — a long rules block defeats its own purpose
// (the "dumped every turn" failure mode). Applied AFTER situational relevance
// filtering + the existing priority-DESC sort, so critical (priority >= 100)
// rules always occupy the top slots and the highest-scoring relevant rules
// fill the rest. See PRD layer-0d-rules-enforcement.md D4.
export const MAX_RULES_PER_ATTEND = 5;

// Token budget for injection. Priority order: rules > checkpoint > primary > peripheral.
// Override via IRANTI_TOKEN_BUDGET env var (integer, tokens). Default is calibrated to
// fit a typical session's rules + checkpoint + ~15 facts within a 2k-token window.
const INJECT_BUDGET_DEFAULT = 2000;

function getInjectionBudget(): number {
  const env = process.env["IRANTI_TOKEN_BUDGET"];
  if (env) {
    const n = parseInt(env, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return INJECT_BUDGET_DEFAULT;
}

export const MAX_CORRECTIONS = 5;

// Track the last persisted metric values so we only send deltas.
// Reset to zero on process start; DB holds the cumulative all-time total.
let lastSyncedMetrics = {
  minimalConflictsChecked: 0,
  supersessions: 0,
  escalations: 0,
  deepConflictsDetected: 0,
};

// ---------------------------------------------------------------------------
// Layer 0e — project-state rollup surfacing
// ---------------------------------------------------------------------------

// "First attend of a session" latch. sessions.turnCount exists in the schema
// but is a fire-and-forget observability counter never read back by this
// module (see sessions.ts's header comment) — using it here would require an
// extra DB round trip on every attend just to check a value this in-process
// flag already knows for free. Module-level state resets naturally on
// process restart (and on vi.resetModules() in tests), which is exactly the
// semantics wanted: "first attend since this server started serving." Mirrors
// the lastSyncedMetrics pattern immediately above.
let hasAttendedThisProcess = false;

// ---------------------------------------------------------------------------
// Async edge recording — best-effort, never blocks the response
// ---------------------------------------------------------------------------

// Record co_access and governs edges after each attend that returns facts.
// Runs fire-and-forget after the response is assembled so attend latency is
// unchanged. A failure here must never surface to the caller.
//
// co_access: all-pairs among returned facts. With a cap of 20 facts that is
//            at most 190 upserts — trivial, and done concurrently.
// governs:   directed rule→fact edges for every (rule, fact) pair injected
//            together. Groundwork for graph-proximity rule triggering (Phase 3).
async function recordAttendEdges(
  returnedFacts: Fact[],
  returnedRules: Rule[],
  tenantId = "default",
  project = "default",
): Promise<void> {
  const ops: Promise<void>[] = [];

  // All-pairs co_access among returned facts.
  for (let i = 0; i < returnedFacts.length; i++) {
    for (let j = i + 1; j < returnedFacts.length; j++) {
      ops.push(
        graph.reinforceEdge(
          { type: "fact", id: returnedFacts[i]!.id },
          { type: "fact", id: returnedFacts[j]!.id },
          "co_access",
          1,
          tenantId,
          project,
        ),
      );
    }
  }

  // governs edges: each active rule → each returned fact it co-fired with.
  for (const rule of returnedRules) {
    for (const fact of returnedFacts) {
      ops.push(
        graph.reinforceEdge(
          { type: "rule", id: rule.id },
          { type: "fact", id: fact.id },
          "governs",
          1,
          tenantId,
          project,
        ),
      );
    }
  }

  await Promise.all(ops);
}

// ---------------------------------------------------------------------------
// Async semantic extraction — Phase 2b / CORE-32
// ---------------------------------------------------------------------------

// Extract durable facts from text and write them to the primary entity.
// Returns the count of facts written for telemetry.
// sourceOverride / confidenceOverride: for attendant_autowrite (context-delta
// extraction), overrides the per-fact source tag and confidence so auto-writes
// are distinguishable from agent-authored explicit writes.
const AUTOWRITE_SOURCE = "attendant_autowrite";
const AUTOWRITE_CONFIDENCE = 0.70;

async function extractAndStore(
  message: string,
  primary: { entityType: string; entityId: string },
  sessionId: string,
  agentId: string,
  project: string,
  sourceOverride?: string,
  confidenceOverride?: number,
): Promise<number> {
  const extracted = await extractor.extract(message);
  if (extracted.length === 0) return 0;

  await upsertEntity(primary.entityType, primary.entityId);
  // Sequential on purpose: two extracted facts can share a key (e.g. two
  // "decision:" sentences in one message), and writeFact is last-write-wins.
  // Array order then deterministically decides the survivor; Promise.all would
  // race them. This runs in the fire-and-forget chain, off the response path,
  // so the extra round trips cost no user-visible latency.
  let count = 0;
  for (const fact of extracted) {
    await writeFact({
      entityType: primary.entityType,
      entityId: primary.entityId,
      key: fact.key,
      value: fact.value,
      source: sourceOverride ?? fact.source,
      confidence: confidenceOverride ?? fact.confidence,
      sessionId,
      agentId,
      project,
    });
    count++;
  }
  return count;
}

const entityHintSchema = z.object({
  entityType: z
    .string()
    .min(1)
    .describe("Broad category: 'user', 'project', 'system', ..."),
  entityId: z.string().min(1).describe("Identifier within the type."),
});

export const attendInputSchema = {
  entityHints: z
    .array(entityHintSchema)
    .default([])
    .describe(
      "Entities in scope for this conversation turn. The first hint is the " +
        "primary entity — extracted artifacts are stored on it.",
    ),
  message: z
    .string()
    .optional()
    .describe(
      "The latest user message, verbatim. iranti extracts and stores URLs " +
        "and file paths from it automatically.",
    ),
  currentContext: z
    .string()
    .optional()
    .describe(
      "The agent's currently visible context window, or a representative " +
        "slice of it. iranti suppresses any fact whose value is already " +
        "present here, so it never re-injects what the agent can already " +
        "see. Omit to receive all relevant facts.",
    ),
  surface: z
    .enum(VALID_SURFACES)
    .optional()
    .describe("Which AI host platform this call comes from."),
  agentName: z
    .string()
    .optional()
    .describe(
      "Agent name for the handshake. Only the first tool call's name is " +
        "used; subsequent values are ignored.",
    ),
  // Phase 3 (CORE-31): attend lifecycle phase.
  //
  //   pre-response  — full budget, full rule scan; call at turn start.
  //   mid-turn      — small budget (3 facts), no rule rescan, dedup vs recent
  //                   access; call when a new entity is discovered mid-turn.
  //   post-response — retrieval side identical to pre-response; call after the
  //                   response is sent to persist turn state.
  //
  // First attend of a session auto-bootstraps agent + session regardless of phase.
  phase: z
    .enum(["pre-response", "mid-turn", "post-response"])
    .optional()
    .default("pre-response")
    .describe(
      "Lifecycle phase: 'pre-response' (default, full budget), " +
        "'mid-turn' (small budget, no rule rescan), " +
        "'post-response' (persist + close).",
    ),
};

export const attendInput = z.object(attendInputSchema);
// Use z.input so callers (tests, hooks) can omit fields that have defaults.
// The output type (z.infer) has phase required; the input type has it optional.
export type AttendInput = z.input<typeof attendInput>;

export interface AttendResult {
  rules: Array<{ entity: string; text: string; priority: number }>;
  facts: Array<{
    entity: string;
    key: string;
    value: string;
    source: string;
    updatedAt: string;
  }>;
  // Phase 3 (CORE-15): graph-hop secondary tier. Facts within 2 hops of the
  // primary hits, weight-ordered, capped at MAX_PERIPHERAL_FACTS.
  // Each entry carries the edge relation that connects it to a primary fact.
  peripheral: Array<{
    entity: string;
    key: string;
    value: string;
    source: string;
    updatedAt: string;
    relation: string;
  }>;
  checkpoint: { entity: string; text: string; updatedAt: string } | null;
  extracted: Array<{ kind: string; value: string }>;
  // Phase 1.2: how many relevant facts were suppressed because their value
  // was already present in the host-provided currentContext. 0 when no
  // currentContext was passed.
  alreadyPresent: number;
  // CORE-17: stale-context corrections. Each entry means the host's context
  // window contains an old value for a fact that has since been updated.
  // currentValue is what the fact holds now; staleValue is what the host has.
  corrections: Array<{
    entity: string;
    key: string;
    currentValue: string;
    staleValue: string;
  }>;
  // OD-4: media objects whose description/tags keyword-match the message,
  // scoped to the entity hints in scope. Returns description + pointer only,
  // never raw bytes — bytes are large; the description is the memory.
  media: Array<{
    entity: string;
    key: string;
    description: string | null;
    mime: string;
    objectUrl: string;
    tags: string[];
  }>;
  // Phase 3 (CORE-31): protocol breadcrumb — what the host should call next.
  nextDue: string;
  // Layer 0e: "where did we leave off?" rollup. Populated ONLY on the first
  // attend of this process (a fresh session) AND only when the gap since
  // last project activity exceeds the deterministic threshold — otherwise
  // null. This mirrors Layer 0d's "don't dump it every turn" posture for
  // rules: the rollup is valuable exactly once, at reorientation time, not
  // on every subsequent call.
  projectState: ProjectStateSummary | null;
}

function entityLabel(f: { entityType: string; entityId: string }): string {
  return `${f.entityType}/${f.entityId}`;
}

// Collapse whitespace and lowercase so presence checks are robust to
// formatting differences between the stored fact and the agent's window.
function normalizeForContext(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

// True if a fact value is already present in the (already-normalized) window.
// Values shorter than the floor are never suppressed — short strings produce
// false-positive substring hits, and a missed suppression is far cheaper than
// hiding a real fact. Long values are probed by a leading slice so a verbatim
// copy in the window still matches without requiring the whole value.
const PRESENCE_MIN_LEN = 8;
const PRESENCE_PROBE_LEN = 160;
function isAlreadyPresent(value: string, normalizedHaystack: string): boolean {
  const needle = normalizeForContext(value);
  if (needle.length < PRESENCE_MIN_LEN) return false;
  const probe =
    needle.length > PRESENCE_PROBE_LEN ? needle.slice(0, PRESENCE_PROBE_LEN) : needle;
  return normalizedHaystack.includes(probe);
}

// CORE-17: stale-context correction helper.
// Given the pre-budget candidate list (ranked primary facts) and the host's
// normalised context window, return any cases where the host is holding an old
// value that has since been superseded. Looks up the most recent archived
// snapshot per candidate fact; a correction fires when the archived value IS
// in context but the current value is NOT.
async function getCorrections(
  candidates: Fact[],
  normalizedContext: string,
  tenantId = "default",
): Promise<AttendResult["corrections"]> {
  if (!normalizedContext || candidates.length === 0) return [];

  // Only facts whose current value is absent from context are candidates
  // — if the current value is already there, nothing to correct.
  const notCurrent = candidates.filter(
    (f) => !isAlreadyPresent(f.value, normalizedContext),
  );
  if (notCurrent.length === 0) return [];

  const archivedValues = await readArchivedValuesByFactIds(
    notCurrent.map((f) => f.id),
    tenantId,
  );

  const corrections: AttendResult["corrections"] = [];
  for (const fact of notCurrent) {
    if (corrections.length >= MAX_CORRECTIONS) break;
    const staleValue = archivedValues.get(fact.id);
    if (!staleValue) continue;
    if (isAlreadyPresent(staleValue, normalizedContext)) {
      corrections.push({
        entity: entityLabel(fact),
        key: fact.key,
        currentValue: fact.value,
        staleValue,
      });
    }
  }
  return corrections;
}

// The full attend pipeline, separated from MCP plumbing so integration
// tests can call it directly against the database.
// Compute the protocol breadcrumb based on the current phase.
function computeNextDue(phase: string): string {
  switch (phase) {
    case "pre-response":
      return "iranti_attend(phase='post-response') due after response; iranti_attend(phase='mid-turn') available if new entities discovered";
    case "mid-turn":
      return "iranti_attend(phase='post-response') due after response";
    case "post-response":
      return "iranti_attend(phase='pre-response') due at next user turn";
    default:
      return "iranti_attend(phase='post-response') due after response";
  }
}

export async function attend(input: AttendInput): Promise<AttendResult> {
  const startTime = Date.now();
  const ctx = await ensureContext(input.agentName);
  const hints = input.entityHints ?? [];
  const phase = input.phase ?? "pre-response";
  const isMidTurn = phase === "mid-turn";

  // Layer 0 (D5/D6/D7): the writing project is always the single current
  // project (writes never target the combined/effective set — combine
  // affects reads only, §11.6). Reads span the effective set: the current
  // project plus anything actively combined with it.
  const currentProject = ctx.project.id;
  const effectiveProjectIds = await getEffectiveProjectIds(currentProject);

  // ---- WRITE side: extract artifacts from the message ----------------------
  // Skipped for mid-turn: it's a read-only top-up triggered by discovery.
  // Extracted facts land on the primary entity (first hint). With no hints,
  // they land on the session entity so they are at least recoverable.
  const primary = hints[0] ?? {
    entityType: "session",
    entityId: ctx.session.id,
  };

  const artifacts = !isMidTurn && input.message ? extractArtifacts(input.message) : [];

  if (artifacts.length > 0) {
    await upsertEntity(primary.entityType, primary.entityId);
    for (const artifact of artifacts) {
      await writeFact({
        entityType: primary.entityType,
        entityId: primary.entityId,
        key: artifact.key,
        value: artifact.value,
        source: EXTRACT_SOURCE,
        surface: input.surface,
        sessionId: ctx.session.id,
        agentId: ctx.agent.id,
        project: currentProject,
      });
    }

    // Layer 0c (entity resolution): learn any nickname declared for an
    // artifact in THIS message ("everyone calls it 'the figma file'").
    // Deterministic, heuristic-only — see extractAliases's header comment.
    // Aliases land on the same primary entity the artifact itself did, and
    // are project-scoped exactly like the fact they point to (currentProject,
    // never the effective/combined set — matches writeFact's write-attribution
    // rule, §11.6 of the Layer 0 PRD).
    for (const alias of extractAliases(input.message!, artifacts)) {
      await learnAlias({
        entityType: primary.entityType,
        entityId: primary.entityId,
        rawAlias: alias.rawAlias,
        factKey: alias.factKey,
        source: EXTRACT_SOURCE,
        project: currentProject,
      });
    }
  }

  // ---- READ side: rules + recent facts + checkpoint ------------------------
  // Mid-turn skips the rule rescan (rules don't change within a turn and the
  // rescan was already done by the pre-response attend).
  // Layer 0d: input.message activates situational relevance filtering inside
  // getRulesForAttend (undefined when no message is present preserves the
  // pre-Layer-0d unfiltered behavior — see rules.ts's header comment). The
  // result is then capped at MAX_RULES_PER_ATTEND, after the priority-DESC
  // sort getRulesForAttend already applies, so the cap always keeps the
  // highest-priority/most-relevant rules first.
  const rules = isMidTurn
    ? []
    : (await getRulesForAttend(hints, "default", effectiveProjectIds, input.message)).slice(
        0,
        MAX_RULES_PER_ATTEND,
      );

  // Mid-turn uses a smaller fact budget: it's a discovery top-up, not a full
  // context load. Per-entity cap is also reduced proportionally.
  const totalBudget = isMidTurn ? MAX_MID_TURN_FACTS : MAX_TOTAL_FACTS;
  const perEntityCap = isMidTurn
    ? Math.max(1, Math.ceil(MAX_MID_TURN_FACTS / Math.max(1, hints.length)))
    : MAX_FACTS_PER_ENTITY;

  const factsPerEntity = await Promise.all(
    hints.map(async (h) => {
      const relevant = await readRelevantFactsByEntity(
        h.entityType,
        h.entityId,
        perEntityCap,
        input.message,
        "default",
        effectiveProjectIds,
      );

      // Layer 0c (entity resolution): an alias shares zero tokens with the
      // fact it names by definition ("the figma file" vs a Figma URL), so
      // keyword-overlap scoring in readRelevantFactsByEntity structurally
      // cannot find it. Resolve any alias the message matches for this
      // entity and GUARANTEE a hit is present — prepended, so it wins the
      // entity's own rank-1 slot — rather than hoping it scores well
      // competing against the keyword-ranked candidates (see PRD D6).
      if (!input.message) return relevant;
      const matchedAlias = await resolveAlias(
        h.entityType,
        h.entityId,
        input.message,
        "default",
        effectiveProjectIds,
      );
      if (!matchedAlias) return relevant;

      const targetFact = await findFact(
        h.entityType,
        h.entityId,
        matchedAlias.factKey,
        "default",
        effectiveProjectIds,
      );
      if (!targetFact) return relevant;

      // Surface the alias itself as a retrievable "alias:<slug>" fact
      // (normalizeKey("alias:" + the learned phrase) — e.g. "the figma
      // file" -> "alias:the-figma-file"), carrying the target's current
      // value. This is a synthesized VIEW of the target fact, not a second
      // stored row: the underlying source of truth stays the one fact at
      // matchedAlias.factKey. Reuses the target's id so graph edge
      // recording continues to accrue against the real fact even when it's
      // found by nickname.
      const aliasFact: Fact = {
        ...targetFact,
        key: normalizeKey(`alias:${matchedAlias.alias}`),
      };
      if (relevant.some((f) => f.key === aliasFact.key)) return relevant;

      // The alias view REPLACES any same-id entry keyword scoring found
      // independently — two entries sharing one fact id must never coexist
      // in the returned list (review findings: the all-pairs co_access loop
      // in recordAttendEdges would insert a fact:X<->fact:X self-loop edge,
      // and getCorrections would emit a duplicate correction for the same
      // superseded fact). One id, one entry; the alias-keyed view wins the
      // slot because it is the one deterministic match for the query.
      const withoutTarget = relevant.filter((f) => f.id !== targetFact.id);

      // Prepend and re-cap at perEntityCap: the alias hit takes the rank-1
      // slot (it's the one deterministic thing we KNOW answers the query),
      // pushing out the lowest-ranked keyword match if the list was already
      // full — never silently growing the per-entity budget.
      return [aliasFact, ...withoutTarget].slice(0, perEntityCap);
    }),
  );
  const ranked = factsPerEntity
    .flat()
    // The checkpoint is returned separately — don't duplicate it here.
    .filter((f: Fact) => f.key !== CHECKPOINT_KEY)
    // When a message is present, each entity's facts are already
    // relevance-ranked by readRelevantFactsByEntity — do not re-sort by
    // recency or the ranking is undone. Without a message, sort by recency.
    .sort((a, b) =>
      input.message ? 0 : b.updatedAt.getTime() - a.updatedAt.getTime(),
    );

  // Phase 1.2 — context window observation. Suppress facts already present in
  // the host-reported window BEFORE applying the total cap, so the injected
  // budget is filled with facts the agent does not already hold. Suppression
  // counts toward `alreadyPresent` for token-saving measurement.
  let alreadyPresent = 0;
  let suppressedChars = 0;
  const visible = input.currentContext
    ? (() => {
        const haystack = normalizeForContext(input.currentContext);
        return ranked.filter((f: Fact) => {
          if (isAlreadyPresent(f.value, haystack)) {
            alreadyPresent++;
            suppressedChars += f.value.length;
            return false;
          }
          return true;
        });
      })()
    : ranked;

  const returnedFacts = visible.slice(0, totalBudget);

  const checkpoint = await getActiveCheckpoint(hints, "default", effectiveProjectIds);

  // Layer 0e: compute the project-state rollup ONLY on the first
  // non-mid-turn attend of this process, and only surface it when the gap
  // since last activity is long — see PRD Decision 5/6. Mid-turn calls
  // neither compute the rollup nor claim the latch (they're deliberately
  // cheap top-ups, same reasoning as the peripheral-facts skip below) — a
  // host whose first call in a fresh process happens to be mid-turn must
  // not burn the one-shot surfacing before its real pre-response arrives
  // (review finding).
  //
  // TRANSPORT SCOPE (review finding): this latch is module-level, i.e.
  // once per PROCESS. Under the stdio transport (one process per host
  // session) that equals once per session — the intended semantics. Under
  // the HTTP transport (src/mcp/http.ts, one long-lived process serving
  // many callers) the rollup fires at most once for the server's lifetime:
  // no cross-project leak (the process is pinned to one project by
  // ensureContext), but reorientation-after-a-gap is effectively a
  // stdio-only guarantee until HTTP grows per-session identity. Documented
  // in the PRD §9.
  let projectState: ProjectStateSummary | null = null;
  if (!isMidTurn && !hasAttendedThisProcess) {
    hasAttendedThisProcess = true;
    const rollup = await getProjectState(effectiveProjectIds);
    if (rollup.isLongGap) projectState = rollup;
  }

  // ---- SECONDARY PASS: graph-hop peripheral retrieval (CORE-15) ------------
  // Walk up to 2 hops from each primary fact. Collect fact-type neighbor IDs,
  // deduplicate against primary hits, sort by edge weight, cap, look up.
  // Skipped for mid-turn — that's a cheap top-up, not a full retrieval.
  const peripheralFacts: AttendResult["peripheral"] = [];
  if (!isMidTurn && returnedFacts.length > 0) {
    const primaryIds = new Set(returnedFacts.map((f) => f.id));
    const checkpointFactId = checkpoint?.id;

    const edgeLists = await Promise.all(
      returnedFacts.map((f) =>
        graph.getNeighbors(
          { type: "fact", id: f.id },
          { depth: 2, limit: 20 },
          "default",
          effectiveProjectIds,
        ),
      ),
    );

    // candidates: neighborFactId → { relation, weight } (highest-weight edge wins)
    const candidates = new Map<string, { relation: string; weight: number }>();
    for (const edges of edgeLists) {
      for (const edge of edges) {
        for (const [nodeType, nodeId] of [
          [edge.sourceType, edge.sourceId],
          [edge.targetType, edge.targetId],
        ] as [string, string][]) {
          if (nodeType !== "fact") continue;
          if (primaryIds.has(nodeId)) continue;
          if (checkpointFactId && nodeId === checkpointFactId) continue;
          const existing = candidates.get(nodeId);
          if (!existing || existing.weight < edge.weight) {
            candidates.set(nodeId, { relation: edge.relation, weight: edge.weight });
          }
        }
      }
    }

    if (candidates.size > 0) {
      const sorted = Array.from(candidates.entries())
        .sort((a, b) => b[1].weight - a[1].weight)
        .slice(0, MAX_PERIPHERAL_FACTS);

      const neighborFacts = await readFactsByIds(
        sorted.map(([id]) => id),
        "default",
        effectiveProjectIds,
      );
      const factById = new Map(neighborFacts.map((f) => [f.id, f]));

      for (const [id, meta] of sorted) {
        const fact = factById.get(id);
        if (!fact || fact.isArchived) continue;
        peripheralFacts.push({
          entity: entityLabel(fact),
          key: fact.key,
          value: fact.value,
          source: fact.source,
          updatedAt: fact.updatedAt.toISOString(),
          relation: meta.relation,
        });
      }
    }
  }

  // ---- CORE-33: token-budgeted injection ----------------------------------
  // Priority order: rules > checkpoint > primary > peripheral.
  // Items that exceed the remaining budget are dropped; their char counts
  // accumulate into suppressedChars so suppressed_tokens_est covers both
  // context-window suppression (Phase 1.2) and budget truncation (CORE-33).
  // est() is a deliberate approximation (~4 chars/token). It over- or
  // under-counts CJK and code-heavy values, but the budget is a soft guardrail,
  // not an exact accounting — a real tokenizer isn't worth the dependency here.
  const est = (text: string) => Math.ceil(text.length / 4);
  let budgetRemaining = getInjectionBudget();
  let budgetSuppressedChars = 0;

  // Charge one item against the remaining budget. Deduct and keep when it fits;
  // otherwise record the dropped chars (for suppressed_tokens_est) and reject.
  // Called in priority order — rules, then checkpoint, then primary, then
  // peripheral — so earlier tiers win the budget.
  const fitsBudget = (text: string): boolean => {
    const t = est(text);
    if (budgetRemaining >= t) { budgetRemaining -= t; return true; }
    budgetSuppressedChars += text.length;
    return false;
  };

  const budgetedRuleList = rules.filter((r) => fitsBudget(r.text));

  let budgetedCheckpoint = checkpoint;
  if (checkpoint && !fitsBudget(checkpoint.value)) budgetedCheckpoint = undefined;

  const budgetedFacts = returnedFacts.filter((f) => fitsBudget(f.value));

  const budgetedPeripheral = peripheralFacts.filter((pf) => fitsBudget(pf.value));

  suppressedChars += budgetSuppressedChars;

  // CORE-17: stale-context corrections. Fires when the host provides a
  // currentContext window; without it there is no comparison source.
  const normalizedContext = input.currentContext
    ? normalizeForContext(input.currentContext)
    : "";
  const corrections = normalizedContext
    ? await getCorrections(ranked, normalizedContext)
    : [];

  // OD-4: media tier — keyword search over description_text / tags for the
  // entities in scope. Only fires when there is a message to match against,
  // and only for pre/post-response phases (skip on mid-turn cheap top-ups).
  const mediaHits: AttendResult["media"] = [];
  if (!isMidTurn && input.message) {
    for (const hint of hints) {
      const hits = await searchMedia(input.message, {
        entityType: hint.entityType,
        entityId: hint.entityId,
        tenantId: "default",
        project: effectiveProjectIds,
        limit: 3,
      }).catch(() => []);
      for (const h of hits) {
        mediaHits.push({
          entity: h.entity,
          key: h.key,
          description: h.description,
          mime: h.mime,
          objectUrl: h.objectUrl,
          tags: h.tags,
        });
      }
    }
  }

  // Route media hits through fitsBudget at lowest priority (after peripheral)
  // so they cannot blow the 2000-token injection contract.
  const budgetedMedia = mediaHits.filter((m) =>
    fitsBudget((m.description ?? "") + " " + m.tags.join(" ")),
  );

  // Phase 2.5 / CORE-32 — fire-and-forget chain: extraction → log → metrics.
  // Chained so facts_extracted in the log reflects the actual write count.
  // None of these must block the response.
  const latencyMs = Date.now() - startTime;
  const injectedChars =
    budgetedFacts.reduce((s, f) => s + f.value.length, 0) +
    budgetedRuleList.reduce((s, r) => s + r.text.length, 0);

  // Snapshot metric deltas before the async chain — conflicts may fire
  // during extraction; cursor advances only after persist succeeds.
  const snapshot = { ...comprehensionMetrics };
  const metricDelta = {
    minimalConflictsChecked:
      snapshot.minimalConflictsChecked - lastSyncedMetrics.minimalConflictsChecked,
    supersessions: snapshot.supersessions - lastSyncedMetrics.supersessions,
    escalations: snapshot.escalations - lastSyncedMetrics.escalations,
    deepConflictsDetected:
      snapshot.deepConflictsDetected - lastSyncedMetrics.deepConflictsDetected,
  };

  // Phase 2a — async edge recording — and the extraction/log/metrics chain
  // above are collected into ONE detached, sequential chain rather than
  // several independent `void`-fired ones. All of it is still fire-and-forget
  // relative to the response (this whole IIFE runs after `return` below, off
  // the response path), so response latency is unaffected either way. But
  // several independent detached chains hitting the DB concurrently is safe
  // on postgres-js (a connection pool) and NOT safe on embedded PGlite
  // (Layer 0, single connection) — running them concurrently was observed to
  // wedge the process during PGlite engine testing. Sequencing them here
  // costs nothing (nobody awaits this chain) and is correct on both engines.
  // trackBackground (not bare `void`) so closeDb can settle this chain
  // before tearing down the connection — RULE-2 root fix; see background.ts.
  trackBackground((async () => {
    if (budgetedFacts.length >= 2 || budgetedRuleList.length > 0) {
      // Layer 0 (D7): edges are tagged to the ATTENDING project (currentProject),
      // never a combined partner — this edge records "these were co-accessed
      // while attending in project X," which is true regardless of whether
      // some of the source facts physically live in a combined partner
      // project. Writes never target the effective/combined set (§11.6).
      await recordAttendEdges(budgetedFacts, budgetedRuleList, "default", currentProject).catch(
        (err: unknown) => console.error("[iranti] edge recording error:", err),
      );
    }

    let factsExtracted = 0;

    // CORE-32: extraction is the primary write path.
    // pre/post phases: extract from latestMessage (same as Phase 2b).
    // post-response additionally: extract from currentContext (the full turn
    // payload including the assistant response), tagged attendant_autowrite at
    // reduced confidence so auto-writes are distinguishable in reliability scoring.
    if (!isMidTurn && input.message) {
      factsExtracted += await extractAndStore(
        input.message, primary, ctx.session.id, ctx.agent.id, currentProject,
      );
    }
    if (phase === "post-response" && input.currentContext) {
      factsExtracted += await extractAndStore(
        input.currentContext, primary, ctx.session.id, ctx.agent.id, currentProject,
        AUTOWRITE_SOURCE, AUTOWRITE_CONFIDENCE,
      );
    }

    await writeAttendLog({
      sessionId: ctx.session.id,
      agentId: ctx.agent.id,
      surface: input.surface,
      factCount: budgetedFacts.length,
      ruleCount: budgetedRuleList.length,
      alreadyPresent,
      injectedChars,
      injectedTokensEst: Math.floor(injectedChars / 4),
      suppressedTokensEst: Math.floor(suppressedChars / 4),
      latencyMs,
      phase,
      factsExtracted,
      correctionsCount: corrections.length,
    });

    await incrementTurnCount(ctx.session.id).catch((err: unknown) =>
      console.error("[iranti] turn count error:", err),
    );

    await persistMetricCounters(metricDelta);
    lastSyncedMetrics = snapshot;
  })().catch((err: unknown) =>
    console.error("[iranti] async post-attend chain error:", err),
  ));

  return {
    rules: budgetedRuleList.map((r) => ({
      entity: entityLabel(r),
      text: r.text,
      priority: r.priority,
    })),
    facts: budgetedFacts.map((f) => ({
      entity: entityLabel(f),
      key: f.key,
      value: f.value,
      source: f.source,
      updatedAt: f.updatedAt.toISOString(),
    })),
    peripheral: budgetedPeripheral,
    checkpoint: budgetedCheckpoint
      ? {
          entity: entityLabel(budgetedCheckpoint),
          text: budgetedCheckpoint.value,
          updatedAt: budgetedCheckpoint.updatedAt.toISOString(),
        }
      : null,
    extracted: artifacts.map((a) => ({ kind: a.kind, value: a.value })),
    alreadyPresent,
    corrections,
    media: budgetedMedia,
    nextDue: computeNextDue(phase),
    projectState,
  };
}
