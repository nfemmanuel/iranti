// src/staff/archivistReasoning.ts
//
// B7 S5 — Archivist reasoning budget.
//
// Adds a deterministic "reasoning pass" over a snapshot of knowledge entries
// that emits PROPOSALS (compress, demote, flag_drift) for the Resolutionist
// to consider. Never mutates knowledge directly. Never calls an LLM. Pure
// function over a snapshot — safe to run in the Archivist scan loop and
// fully testable without a database.
//
// Proposals are inert until a Resolutionist acts on them. They land on the
// staff event bus as `actionType: 'reasoning_proposal_emitted'` and are
// included in the ArchivistReport so the caller can ship them as-is.
//
// Shape:
//   planArchivistReasoningPass({ candidates, now, reasoningBudget })
//     → { proposals, budgetUsed, note }

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Minimal snapshot of a knowledge entry required for reasoning. The Archivist
 * runtime maps its Prisma rows to this shape before calling the helper so the
 * helper itself is database-free and fully unit-testable.
 */
export interface ArchivistReasoningCandidate {
    id: string | number;
    entityType: string;
    entityId: string;
    key: string;
    confidence: number;
    source: string;
    lastAccessedAt: Date | string | null;
    updatedAt: Date | string | null;
    createdAt: Date | string | null;
    summary?: string | null;
    valueSummary?: string | null;
    stability?: number | null;
}

export type ArchivistReasoningAction =
    | 'compress'
    | 'demote'
    | 'flag_drift'
    | 'review_stale';

export interface ArchivistReasoningProposal {
    action: ArchivistReasoningAction;
    /** One or more candidate ids this proposal targets. */
    targetIds: (string | number)[];
    /** Human-readable entityKey fingerprint for the first target. */
    primaryEntityKey: string;
    reason: string;
    /** 0-100 — the helper's confidence in the proposal. */
    confidence: number;
    /**
     * Snapshot metadata that downstream consumers (Resolutionist, observability)
     * can use to inspect the cluster without re-querying the database.
     */
    snapshot: {
        targetCount: number;
        minConfidence: number;
        maxConfidence: number;
        oldestLastAccessedAt: string | null;
        newestLastAccessedAt: string | null;
    };
}

export interface ArchivistReasoningPassOutput {
    proposals: ArchivistReasoningProposal[];
    budgetUsed: number;
    budgetMax: number;
    note: string;
    /** Reason the pass either ran, was skipped, or was capped. */
    outcome:
        | 'no_candidates'
        | 'no_proposals'
        | 'proposals_emitted'
        | 'budget_capped'
        | 'budget_zero';
}

export interface PlanArchivistReasoningPassInput {
    candidates: ArchivistReasoningCandidate[];
    /** Max number of proposals the pass is allowed to emit in one cycle. */
    reasoningBudget: number;
    /** Defaults to new Date(). Pass a fixed value in tests for determinism. */
    now?: Date;
    /** Low-confidence review threshold (default 55). */
    reviewConfidenceThreshold?: number;
    /** Days without access after which a fact is flagged for stale review. */
    staleAccessDays?: number;
    /** Minimum cluster size to propose compression. */
    compressMinClusterSize?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const ARCHIVIST_REASONING_DEFAULT_BUDGET = 5;
export const ARCHIVIST_REVIEW_CONFIDENCE_THRESHOLD = 55;
export const ARCHIVIST_STALE_ACCESS_DAYS = 21;
export const ARCHIVIST_COMPRESS_MIN_CLUSTER_SIZE = 3;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toDate(value: Date | string | null | undefined): Date | null {
    if (!value) return null;
    if (value instanceof Date) return value;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
}

function daysBetween(later: Date, earlier: Date): number {
    return Math.max(0, (later.getTime() - earlier.getTime()) / 86_400_000);
}

function fingerprintKey(candidate: ArchivistReasoningCandidate): string {
    return `${candidate.entityType}/${candidate.entityId}/${candidate.key}`;
}

function clusterKey(candidate: ArchivistReasoningCandidate): string {
    return `${candidate.entityType}/${candidate.entityId}/${candidate.key}`;
}

function buildSnapshot(candidates: ArchivistReasoningCandidate[]): ArchivistReasoningProposal['snapshot'] {
    const confidences = candidates.map((c) => c.confidence);
    const accessDates = candidates
        .map((c) => toDate(c.lastAccessedAt) ?? toDate(c.updatedAt) ?? toDate(c.createdAt))
        .filter((d): d is Date => d !== null)
        .sort((a, b) => a.getTime() - b.getTime());

    return {
        targetCount: candidates.length,
        minConfidence: Math.min(...confidences),
        maxConfidence: Math.max(...confidences),
        oldestLastAccessedAt: accessDates[0]?.toISOString() ?? null,
        newestLastAccessedAt: accessDates[accessDates.length - 1]?.toISOString() ?? null,
    };
}

// ─── planArchivistReasoningPass ──────────────────────────────────────────────

/**
 * Pure function. Examines a candidate snapshot and emits a bounded list of
 * reasoning PROPOSALS. Never calls an LLM. Never mutates. Deterministic for
 * a given input. Safe to unit-test.
 *
 * Proposal rules (in priority order):
 *  1. compress  — ≥ compressMinClusterSize candidates share the same
 *                 entityType/entityId/key cluster (duplicates to collapse).
 *  2. flag_drift — a cluster has high variance (> 30) in confidence, suggesting
 *                 repeated re-writes that disagree with each other.
 *  3. demote    — a single candidate sits below reviewConfidenceThreshold
 *                 AND has not been accessed for staleAccessDays.
 *  4. review_stale — a candidate has not been accessed for ≥ 2× staleAccessDays
 *                 regardless of confidence.
 */
export function planArchivistReasoningPass(
    input: PlanArchivistReasoningPassInput,
): ArchivistReasoningPassOutput {
    const {
        candidates,
        reasoningBudget,
        now = new Date(),
        reviewConfidenceThreshold = ARCHIVIST_REVIEW_CONFIDENCE_THRESHOLD,
        staleAccessDays = ARCHIVIST_STALE_ACCESS_DAYS,
        compressMinClusterSize = ARCHIVIST_COMPRESS_MIN_CLUSTER_SIZE,
    } = input;

    const budgetMax = Math.max(0, Math.floor(reasoningBudget));

    if (budgetMax === 0) {
        return {
            proposals: [],
            budgetUsed: 0,
            budgetMax: 0,
            note: 'Reasoning budget is zero; pass skipped.',
            outcome: 'budget_zero',
        };
    }

    if (candidates.length === 0) {
        return {
            proposals: [],
            budgetUsed: 0,
            budgetMax,
            note: 'No candidates supplied to reasoning pass.',
            outcome: 'no_candidates',
        };
    }

    const proposals: ArchivistReasoningProposal[] = [];
    const consumedIds = new Set<string | number>();

    // ── Rule 1: compress clusters ─────────────────────────────────────────────
    const clusters = new Map<string, ArchivistReasoningCandidate[]>();
    for (const candidate of candidates) {
        const key = clusterKey(candidate);
        const bucket = clusters.get(key) ?? [];
        bucket.push(candidate);
        clusters.set(key, bucket);
    }

    const clusterEntries = Array.from(clusters.entries())
        .filter(([, bucket]) => bucket.length >= compressMinClusterSize)
        .sort((a, b) => b[1].length - a[1].length);

    for (const [, bucket] of clusterEntries) {
        if (proposals.length >= budgetMax) break;
        const snapshot = buildSnapshot(bucket);
        proposals.push({
            action: 'compress',
            targetIds: bucket.map((c) => c.id),
            primaryEntityKey: fingerprintKey(bucket[0]),
            reason: `Cluster of ${bucket.length} duplicate entries at ${fingerprintKey(bucket[0])} can be compressed.`,
            confidence: Math.min(95, 60 + bucket.length * 5),
            snapshot,
        });
        for (const c of bucket) consumedIds.add(c.id);
    }

    // ── Rule 2: flag drift on high-variance clusters ──────────────────────────
    if (proposals.length < budgetMax) {
        for (const [, bucket] of clusters.entries()) {
            if (proposals.length >= budgetMax) break;
            if (bucket.length < 2) continue;
            if (bucket.every((c) => consumedIds.has(c.id))) continue;
            const confidences = bucket.map((c) => c.confidence);
            const minConf = Math.min(...confidences);
            const maxConf = Math.max(...confidences);
            const spread = maxConf - minConf;
            if (spread <= 30) continue;
            const snapshot = buildSnapshot(bucket);
            proposals.push({
                action: 'flag_drift',
                targetIds: bucket.map((c) => c.id),
                primaryEntityKey: fingerprintKey(bucket[0]),
                reason: `Confidence spread ${spread} across ${bucket.length} entries at ${fingerprintKey(bucket[0])} suggests drift.`,
                confidence: Math.min(90, 50 + spread),
                snapshot,
            });
            for (const c of bucket) consumedIds.add(c.id);
        }
    }

    // ── Rule 3: demote stale low-confidence singles ───────────────────────────
    if (proposals.length < budgetMax) {
        for (const candidate of candidates) {
            if (proposals.length >= budgetMax) break;
            if (consumedIds.has(candidate.id)) continue;
            if (candidate.confidence >= reviewConfidenceThreshold) continue;
            const accessAt = toDate(candidate.lastAccessedAt) ?? toDate(candidate.updatedAt) ?? toDate(candidate.createdAt);
            if (!accessAt) continue;
            const ageDays = daysBetween(now, accessAt);
            if (ageDays < staleAccessDays) continue;
            const snapshot = buildSnapshot([candidate]);
            proposals.push({
                action: 'demote',
                targetIds: [candidate.id],
                primaryEntityKey: fingerprintKey(candidate),
                reason: `Confidence ${candidate.confidence} below ${reviewConfidenceThreshold} and last accessed ${Math.round(ageDays)}d ago — propose demote.`,
                confidence: Math.min(80, 40 + Math.round(ageDays / 2)),
                snapshot,
            });
            consumedIds.add(candidate.id);
        }
    }

    // ── Rule 4: review_stale on very-old single facts ─────────────────────────
    if (proposals.length < budgetMax) {
        const veryStaleDays = staleAccessDays * 2;
        for (const candidate of candidates) {
            if (proposals.length >= budgetMax) break;
            if (consumedIds.has(candidate.id)) continue;
            const accessAt = toDate(candidate.lastAccessedAt) ?? toDate(candidate.updatedAt) ?? toDate(candidate.createdAt);
            if (!accessAt) continue;
            const ageDays = daysBetween(now, accessAt);
            if (ageDays < veryStaleDays) continue;
            const snapshot = buildSnapshot([candidate]);
            proposals.push({
                action: 'review_stale',
                targetIds: [candidate.id],
                primaryEntityKey: fingerprintKey(candidate),
                reason: `Last accessed ${Math.round(ageDays)}d ago (≥ ${veryStaleDays}d) — propose stale review.`,
                confidence: Math.min(75, 35 + Math.round(ageDays / 3)),
                snapshot,
            });
            consumedIds.add(candidate.id);
        }
    }

    const budgetUsed = proposals.length;
    const capped = budgetUsed === budgetMax && candidates.length > budgetUsed;

    let outcome: ArchivistReasoningPassOutput['outcome'];
    if (budgetUsed === 0) {
        outcome = 'no_proposals';
    } else if (capped) {
        outcome = 'budget_capped';
    } else {
        outcome = 'proposals_emitted';
    }

    return {
        proposals,
        budgetUsed,
        budgetMax,
        note:
            budgetUsed === 0
                ? `Reasoning pass scanned ${candidates.length} candidate(s) and emitted 0 proposals.`
                : `Reasoning pass emitted ${budgetUsed}/${budgetMax} proposal(s) over ${candidates.length} candidate(s).`,
        outcome,
    };
}
