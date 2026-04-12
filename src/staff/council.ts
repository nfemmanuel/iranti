/**
 * B7 S6 — Cross-Staff consultation (council mode).
 *
 * Pure helper that, given the current Staff member's decision context,
 * proposes which OTHER Staff members should be consulted before finalising.
 * Emits a structured consultation plan — the consultation itself is NOT
 * executed here. Downstream consumers (Librarian conflict path, Attendant
 * relevance filter, Archivist reasoning pass) can choose to act on the plan
 * or record it for observability.
 *
 * Follows the A4/A5 pattern: propose, don't execute. Deterministic, no LLM,
 * no I/O. Fully unit-testable.
 */

import type { StaffComponent } from '../lib/staffEventEmitter';

// ─── Types ───────────────────────────────────────────────────────────────────

export type CouncilConsultationBasis =
    | 'conflict_resolution'
    | 'relevance_check'
    | 'reasoning_proposal_review'
    | 'escalation_context'
    | 'none';

export interface CouncilConsultation {
    from: StaffComponent;
    to: StaffComponent;
    question: string;
    basis: CouncilConsultationBasis;
    /** 0-100 — the helper's confidence that this consultation is useful. */
    confidence: number;
    /** Optional hint the consulted Staff member can use to scope its response. */
    topicHint: string | null;
}

export interface CouncilConsultationPlan {
    consultations: CouncilConsultation[];
    note: string;
    outcome:
        | 'no_context'
        | 'no_consultations'
        | 'consultations_proposed'
        | 'budget_capped';
    budgetMax: number;
}

export interface PlanCouncilConsultationInput {
    /** Which Staff component is asking for help. */
    from: StaffComponent;
    /** Short description of what that Staff member is trying to decide. */
    task: string;
    /** Optional detail fields — the more context, the better the proposals. */
    context?: {
        hasConflict?: boolean;
        conflictEntityKey?: string | null;
        confidenceSpread?: number | null;
        lowConfidenceCount?: number;
        relevanceCheckTopic?: string | null;
        reasoningProposalAction?:
            | 'compress'
            | 'demote'
            | 'flag_drift'
            | 'review_stale'
            | null;
        pendingEscalationKey?: string | null;
    };
    /** Max consultations allowed in this plan (default 2). */
    budget?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const COUNCIL_DEFAULT_BUDGET = 2;
export const COUNCIL_MIN_CONFIDENCE = 50;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shortenTopic(topic: string | null | undefined, maxLen = 60): string | null {
    if (!topic) return null;
    const trimmed = topic.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length <= maxLen) return trimmed;
    return `${trimmed.slice(0, maxLen - 1)}…`;
}

// ─── planCouncilConsultation ─────────────────────────────────────────────────

/**
 * Pure function. Decides whether the calling Staff member should consult one
 * or more peer Staff members before finalising, and — if so — proposes a
 * structured plan. Never calls another Staff member. Never hits I/O.
 *
 * Consultation rules:
 *  - Librarian with a conflict → consult Attendant for relevance,
 *    consult Archivist when the cluster has high confidence spread.
 *  - Attendant doing relevance filtering → consult Librarian for
 *    source-reliability context when a clear topic is present.
 *  - Attendant with low-confidence injection → consult Archivist for stale
 *    review advice.
 *  - Archivist emitting a reasoning proposal → consult Librarian for
 *    conflict history on the targeted cluster.
 *  - Resolutionist with a pending escalation → consult Archivist for
 *    reasoning-proposal context.
 */
export function planCouncilConsultation(
    input: PlanCouncilConsultationInput,
): CouncilConsultationPlan {
    const budgetMax = Math.max(0, Math.floor(input.budget ?? COUNCIL_DEFAULT_BUDGET));
    const taskText = input.task?.trim() ?? '';

    if (budgetMax === 0 || taskText.length === 0) {
        return {
            consultations: [],
            note: 'No consultation context provided.',
            outcome: 'no_context',
            budgetMax,
        };
    }

    const consultations: CouncilConsultation[] = [];
    const { from, context = {} } = input;

    const addConsultation = (c: CouncilConsultation): void => {
        if (consultations.length >= budgetMax) return;
        if (c.to === from) return;
        if (c.confidence < COUNCIL_MIN_CONFIDENCE) return;
        // Deduplicate by from→to pair
        if (consultations.some((existing) => existing.to === c.to && existing.basis === c.basis)) return;
        consultations.push(c);
    };

    // ── Rule set keyed on `from` ──────────────────────────────────────────────

    if (from === 'Librarian') {
        if (context.hasConflict && context.conflictEntityKey) {
            addConsultation({
                from,
                to: 'Attendant',
                question: `Is ${context.conflictEntityKey} currently in-context for the active task? Relevance would break the tie.`,
                basis: 'conflict_resolution',
                confidence: 80,
                topicHint: shortenTopic(context.conflictEntityKey),
            });

            if ((context.confidenceSpread ?? 0) >= 25) {
                addConsultation({
                    from,
                    to: 'Archivist',
                    question: `Any pending reasoning proposals (compress/flag_drift) touching ${context.conflictEntityKey}?`,
                    basis: 'conflict_resolution',
                    confidence: 70,
                    topicHint: shortenTopic(context.conflictEntityKey),
                });
            }
        }
    } else if (from === 'Attendant') {
        if (context.relevanceCheckTopic) {
            addConsultation({
                from,
                to: 'Librarian',
                question: `Any recent source-reliability signals for topic "${context.relevanceCheckTopic}"? Could tighten relevance filter.`,
                basis: 'relevance_check',
                confidence: 65,
                topicHint: shortenTopic(context.relevanceCheckTopic),
            });
        }
        if ((context.lowConfidenceCount ?? 0) >= 3) {
            addConsultation({
                from,
                to: 'Archivist',
                question: `Injection surface has ${context.lowConfidenceCount} low-confidence facts; any stale-review proposals pending?`,
                basis: 'reasoning_proposal_review',
                confidence: 60,
                topicHint: null,
            });
        }
    } else if (from === 'Archivist') {
        if (context.reasoningProposalAction) {
            addConsultation({
                from,
                to: 'Librarian',
                question: `Before I propose ${context.reasoningProposalAction}, any conflict history on the target cluster?`,
                basis: 'reasoning_proposal_review',
                confidence: 70,
                topicHint: context.reasoningProposalAction,
            });
        }
    } else if (from === 'Resolutionist') {
        if (context.pendingEscalationKey) {
            addConsultation({
                from,
                to: 'Archivist',
                question: `Any reasoning proposals touching ${context.pendingEscalationKey} I should fold into the decision?`,
                basis: 'escalation_context',
                confidence: 75,
                topicHint: shortenTopic(context.pendingEscalationKey),
            });
            addConsultation({
                from,
                to: 'Librarian',
                question: `Source reliability snapshot for ${context.pendingEscalationKey}?`,
                basis: 'escalation_context',
                confidence: 65,
                topicHint: shortenTopic(context.pendingEscalationKey),
            });
        }
    }

    const capped =
        consultations.length === budgetMax &&
        // crude check: if ANY rule would have added another entry we'd have hit cap logic.
        // We flag `budget_capped` only when budgetMax is reached AND the from-rule
        // was known to produce more than budgetMax candidates.
        (from === 'Resolutionist' || (from === 'Librarian' && (context.confidenceSpread ?? 0) >= 25));

    let outcome: CouncilConsultationPlan['outcome'];
    if (consultations.length === 0) {
        outcome = 'no_consultations';
    } else if (capped) {
        outcome = 'budget_capped';
    } else {
        outcome = 'consultations_proposed';
    }

    return {
        consultations,
        note:
            consultations.length === 0
                ? `Council pass for ${from} on "${taskText}" produced no consultation proposals.`
                : `Council pass for ${from} proposed ${consultations.length}/${budgetMax} consultation(s).`,
        outcome,
        budgetMax,
    };
}
