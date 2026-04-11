// src/staff/subTurnLoop.ts
//
// B8 M6 — Sub-turn reasoning loop.
//
// Pure helper. Given a mid-turn attend input that carries a partial assistant
// response, decides whether the Attendant should re-score its own in-progress
// output against memory and re-run retrieval with new entity hints harvested
// from the partial text. Never executes observe() itself — the caller fires at
// most one extra retrieval when the plan says `attempted=true`.
//
// This is A3's iterative refinement pattern re-applied on response progress
// rather than initial-pass emptiness. Gates follow the same shape as
// planRefinementPass: post-response closeout is gated off, pre-response is
// rejected (pre-response is the initial pass, not a sub-turn loop), empty or
// short partial responses are declined, and a no-new-tokens verdict declines
// the retry so we don't thrash on text the caller already searched for.
//
// When the plan does propose a retry it surfaces `rescoreTokens` (novel
// lowercase tokens from the partial) + `proposedHints` (novel type/id
// patterns extracted by regex). The caller UNIONs those proposed hints with
// the original entity hints before firing observe() again — same fix pattern
// as B6's refinement retry (see the union-of-original+widened comment in
// AttendantInstance.ts around line 5228).
//
// Pure function. No LLM. No I/O. Deterministic. Fully unit-testable.

// ─── Types ───────────────────────────────────────────────────────────────────

export type SubTurnLoopOutcome =
    | 'declined_phase'           // phase is pre-response — initial pass, not a sub-turn loop
    | 'declined_post_response'   // post-response closeout gated off
    | 'declined_no_partial'      // no partialResponse field supplied on mid-turn
    | 'declined_too_short'       // partialResponse under MIN_PARTIAL_LENGTH
    | 'declined_no_new_tokens'   // every partial token already covered by baseline
    | 'budget_exhausted'         // budgetMax <= 0
    | 'attempted_empty'          // retry fired but no new facts (set by caller)
    | 'attempted_added';         // retry fired and added facts (set by caller)

export interface SubTurnLoopPlan {
    outcome: SubTurnLoopOutcome;
    attempted: boolean;
    partialResponseLength: number;
    initialFactCount: number;
    addedFactCount: number;
    rescoreTokens: string[];
    proposedHints: string[];
    budgetMax: number;
    reason: string;
    note: string;
}

export interface PlanSubTurnLoopInput {
    phase?: 'pre-response' | 'mid-turn' | 'post-response';
    partialResponse?: string;
    latestMessage?: string;
    originalEntityHints: readonly string[];
    initialFactCount: number;
    /** Max retry budget (default 1). Caller fires one extra observe when attempted=true. */
    budget?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const SUB_TURN_LOOP_DEFAULT_BUDGET = 1;
export const SUB_TURN_LOOP_MIN_PARTIAL_LENGTH = 40;
export const SUB_TURN_LOOP_MAX_RESCORE_TOKENS = 5;
export const SUB_TURN_LOOP_MAX_PROPOSED_HINTS = 3;
export const SUB_TURN_LOOP_MIN_TOKEN_LENGTH = 4;

const SUB_TURN_LOOP_STOPWORDS = new Set<string>([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those',
    'have', 'has', 'had', 'will', 'would', 'should', 'could', 'about',
    'into', 'then', 'than', 'also', 'just', 'some', 'such', 'very', 'like',
    'been', 'being', 'because', 'before', 'after', 'while', 'where', 'when',
    'what', 'which', 'they', 'them', 'their', 'there', 'here', 'your', 'yours',
    'mine', 'ours', 'theirs', 'over', 'under', 'between', 'against', 'every',
    'more', 'most', 'much', 'many', 'each', 'any', 'all', 'not', 'nor',
    'only', 'own', 'same', 'once', 'other', 'another',
]);

// Match "type/id" or "type/id/key" patterns in free-form text. Entity segments
// must start with a letter and contain at least 2 chars total to avoid matching
// ratios like "2/3" or short paths like "a/b". Three-segment form also
// supported so we can harvest "project/iranti/feature_idea_user_rules" but we
// always return the two-segment prefix for retrieval widening.
const ENTITY_HINT_REGEX = /([a-zA-Z][a-zA-Z0-9_-]{1,})\/([a-zA-Z][a-zA-Z0-9_-]{1,})(?:\/([a-zA-Z][a-zA-Z0-9_-]{1,}))?/g;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeTokens(text: string): string[] {
    if (!text) return [];
    const normalized = text
        .toLowerCase()
        .replace(/[^a-z0-9_\-\s\/]/g, ' ');
    const tokens: string[] = [];
    for (const raw of normalized.split(/\s+/)) {
        if (!raw) continue;
        // Split entity-shaped tokens into parts so "project/iranti" contributes
        // "project" and "iranti" to the baseline set, too.
        for (const piece of raw.split('/')) {
            if (!piece) continue;
            if (piece.length < SUB_TURN_LOOP_MIN_TOKEN_LENGTH) continue;
            if (SUB_TURN_LOOP_STOPWORDS.has(piece)) continue;
            tokens.push(piece);
        }
    }
    return tokens;
}

function extractProposedHintsFromText(
    text: string,
    existingHints: readonly string[],
): string[] {
    const existingSet = new Set(existingHints.map((h) => h.toLowerCase().trim()));
    // Also consider two-segment prefixes of any three-segment existing hint
    // as "already covered" so we don't re-propose a widening of what the
    // caller already supplied.
    for (const hint of existingHints) {
        const parts = hint.toLowerCase().split('/');
        if (parts.length >= 2) {
            existingSet.add(`${parts[0]}/${parts[1]}`);
        }
    }

    const proposed: string[] = [];
    const seen = new Set<string>();
    ENTITY_HINT_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ENTITY_HINT_REGEX.exec(text)) !== null) {
        const entityType = match[1];
        const entityId = match[2];
        if (!entityType || !entityId) continue;
        const hint = `${entityType}/${entityId}`.toLowerCase();
        if (existingSet.has(hint)) continue;
        if (seen.has(hint)) continue;
        seen.add(hint);
        proposed.push(hint);
        if (proposed.length >= SUB_TURN_LOOP_MAX_PROPOSED_HINTS) break;
    }
    return proposed;
}

// ─── planSubTurnLoop ─────────────────────────────────────────────────────────

/**
 * Pure function. Decides whether the Attendant should run a bounded sub-turn
 * retrieval retry against its own partial response. Never calls observe().
 * Never hits I/O.
 *
 * Gate order:
 *  1. Phase gate — post-response and pre-response reject immediately. M6 only
 *     fires on mid-turn attends.
 *  2. Partial response presence — no field → declined_no_partial.
 *  3. Length gate — partial under MIN_PARTIAL_LENGTH → declined_too_short.
 *  4. Budget gate — budgetMax <= 0 → budget_exhausted.
 *  5. Novelty gate — extract tokens + type/id hints from partial; if every
 *     token and hint is already in the baseline (original entity hints +
 *     latest message), decline as declined_no_new_tokens.
 *  6. Otherwise set attempted=true with rescoreTokens + proposedHints
 *     populated. Outcome starts as 'attempted_empty' and the caller flips it
 *     to 'attempted_added' when the retry observe returns new facts.
 */
export function planSubTurnLoop(input: PlanSubTurnLoopInput): SubTurnLoopPlan {
    const {
        phase,
        partialResponse,
        latestMessage,
        originalEntityHints,
        initialFactCount,
        budget,
    } = input;

    const budgetMax = Math.max(0, Math.floor(budget ?? SUB_TURN_LOOP_DEFAULT_BUDGET));
    const partialText = (partialResponse ?? '').trim();
    const partialResponseLength = partialText.length;

    // Gate 1a: post-response is always a closeout path.
    if (phase === 'post-response') {
        return {
            outcome: 'declined_post_response',
            attempted: false,
            partialResponseLength,
            initialFactCount,
            addedFactCount: 0,
            rescoreTokens: [],
            proposedHints: [],
            budgetMax,
            reason: 'post_response_closeout',
            note: 'Sub-turn loop is gated off on post-response attends.',
        };
    }

    // Gate 1b: M6 only fires on mid-turn. Pre-response is the initial pass;
    // an undefined phase is treated the same as pre-response.
    if (phase !== 'mid-turn') {
        return {
            outcome: 'declined_phase',
            attempted: false,
            partialResponseLength,
            initialFactCount,
            addedFactCount: 0,
            rescoreTokens: [],
            proposedHints: [],
            budgetMax,
            reason: 'phase_not_mid_turn',
            note: `Sub-turn loop only fires on mid-turn attend; current phase = ${phase ?? 'unknown'}.`,
        };
    }

    // Gate 2: no partial response supplied — nothing to rescore.
    if (!partialResponse || partialResponseLength === 0) {
        return {
            outcome: 'declined_no_partial',
            attempted: false,
            partialResponseLength,
            initialFactCount,
            addedFactCount: 0,
            rescoreTokens: [],
            proposedHints: [],
            budgetMax,
            reason: 'no_partial_response',
            note: 'Sub-turn loop requires a partialResponse field on mid-turn attend.',
        };
    }

    // Gate 3: partial response too short to be worth re-scoring.
    if (partialResponseLength < SUB_TURN_LOOP_MIN_PARTIAL_LENGTH) {
        return {
            outcome: 'declined_too_short',
            attempted: false,
            partialResponseLength,
            initialFactCount,
            addedFactCount: 0,
            rescoreTokens: [],
            proposedHints: [],
            budgetMax,
            reason: 'partial_response_below_min_length',
            note: `Partial response is ${partialResponseLength} chars, below minimum of ${SUB_TURN_LOOP_MIN_PARTIAL_LENGTH}.`,
        };
    }

    // Gate 4: budget check — can't fire a retry with zero budget.
    if (budgetMax === 0) {
        return {
            outcome: 'budget_exhausted',
            attempted: false,
            partialResponseLength,
            initialFactCount,
            addedFactCount: 0,
            rescoreTokens: [],
            proposedHints: [],
            budgetMax,
            reason: 'budget_zero',
            note: 'Sub-turn loop budget is 0; not firing a retry.',
        };
    }

    // Token extraction: collect normalized tokens from the partial response
    // and diff them against the baseline of original hints + latest message.
    // Tokens that match the baseline don't count — we're looking for what's
    // NEW in the partial.
    const hintText = originalEntityHints.join(' ');
    const baselineTokens = new Set(normalizeTokens(`${latestMessage ?? ''} ${hintText}`));
    const partialTokens = normalizeTokens(partialText);
    const rescoreTokens: string[] = [];
    const seenRescore = new Set<string>();
    for (const token of partialTokens) {
        if (baselineTokens.has(token)) continue;
        if (seenRescore.has(token)) continue;
        seenRescore.add(token);
        rescoreTokens.push(token);
        if (rescoreTokens.length >= SUB_TURN_LOOP_MAX_RESCORE_TOKENS) break;
    }

    // Proposed hints: extract type/id patterns from the partial text that
    // weren't already in the original hints.
    const proposedHints = extractProposedHintsFromText(partialText, originalEntityHints);

    // Gate 5: no novel tokens AND no novel hints → nothing to rescore.
    if (rescoreTokens.length === 0 && proposedHints.length === 0) {
        return {
            outcome: 'declined_no_new_tokens',
            attempted: false,
            partialResponseLength,
            initialFactCount,
            addedFactCount: 0,
            rescoreTokens: [],
            proposedHints: [],
            budgetMax,
            reason: 'all_partial_tokens_covered_by_baseline',
            note: 'Partial response tokens already present in original hints/message — no new retrieval needed.',
        };
    }

    return {
        outcome: 'attempted_empty', // caller flips to attempted_added when retry returns facts
        attempted: true,
        partialResponseLength,
        initialFactCount,
        addedFactCount: 0,
        rescoreTokens,
        proposedHints,
        budgetMax,
        reason: 'mid_turn_partial_response_has_novel_signal',
        note: `Mid-turn partial response surfaced ${rescoreTokens.length} novel token(s) and ${proposedHints.length} proposed hint(s). Planning one bounded retry.`,
    };
}
