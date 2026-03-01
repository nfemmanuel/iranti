import { prisma } from '../library/client';
import { Prisma } from '../generated/prisma/client';

// ─── Constants ───────────────────────────────────────────────────────────────

const RELIABILITY_ENTITY_TYPE = 'system';
const RELIABILITY_ENTITY_ID = 'librarian';
const RELIABILITY_KEY = 'source_reliability';
const DEFAULT_SCORE = 0.5;
const MIN_SCORE = 0.1;
const MAX_SCORE = 1.0;
const WIN_DELTA = 0.03;       // Score increase when source wins
const LOSS_DELTA = 0.02;      // Score decrease when source loses
const HUMAN_DELTA = 0.08;     // Larger adjustment when human overrides
const DECAY_RATE = 0.005;     // Slow decay toward neutral per update cycle

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReliabilityMap {
    [source: string]: number;
}

interface ReliabilityStore {
    scores: ReliabilityMap;
    lastUpdated: string;
    totalResolutions: number;
}

// ─── Read ────────────────────────────────────────────────────────────────────

export async function getReliabilityScores(): Promise<ReliabilityMap> {
    const entry = await prisma.knowledgeEntry.findUnique({
        where: {
            entityType_entityId_key: {
                entityType: RELIABILITY_ENTITY_TYPE,
                entityId: RELIABILITY_ENTITY_ID,
                key: RELIABILITY_KEY,
            },
        },
    });

    if (!entry) return {};

    const store = entry.valueRaw as unknown as ReliabilityStore;
    return store.scores ?? {};
}

export function getScore(scores: ReliabilityMap, source: string): number {
    return scores[source] ?? DEFAULT_SCORE;
}

// ─── Update ──────────────────────────────────────────────────────────────────

export async function recordResolution(
    winnerSource: string,
    loserSource: string,
    humanOverride: boolean = false
): Promise<void> {
    const scores = await getReliabilityScores();
    const delta = humanOverride ? HUMAN_DELTA : WIN_DELTA;
    const lossDelta = humanOverride ? HUMAN_DELTA : LOSS_DELTA;

    // Apply decay to all existing scores first
    for (const source of Object.keys(scores)) {
        scores[source] = decayTowardNeutral(scores[source]);
    }

    // Update winner
    const winnerCurrent = getScore(scores, winnerSource);
    scores[winnerSource] = clamp(winnerCurrent + delta);

    // Update loser
    const loserCurrent = getScore(scores, loserSource);
    scores[loserSource] = clamp(loserCurrent - lossDelta);

    await persistScores(scores);
}

// ─── Weighted Confidence ─────────────────────────────────────────────────────

export function weightedConfidence(
    confidence: number,
    source: string,
    scores: ReliabilityMap
): number {
    const reliability = getScore(scores, source);
    // Blend: 70% raw confidence, 30% reliability-adjusted
    return Math.round(confidence * 0.7 + confidence * reliability * 0.3);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clamp(value: number): number {
    return Math.min(MAX_SCORE, Math.max(MIN_SCORE, Math.round(value * 1000) / 1000));
}

function decayTowardNeutral(score: number): number {
    return clamp(score + (DEFAULT_SCORE - score) * DECAY_RATE);
}

async function persistScores(scores: ReliabilityMap): Promise<void> {
    const resolutionCount = Object.values(scores).reduce((sum, score) => {
        // Count how many times this source has been in a resolution (rough heuristic)
        return sum + Math.round(Math.abs(score - DEFAULT_SCORE) / WIN_DELTA);
    }, 0);
    
    const store: ReliabilityStore = {
        scores,
        lastUpdated: new Date().toISOString(),
        totalResolutions: resolutionCount,
    };

    await prisma.knowledgeEntry.upsert({
        where: {
            entityType_entityId_key: {
                entityType: RELIABILITY_ENTITY_TYPE,
                entityId: RELIABILITY_ENTITY_ID,
                key: RELIABILITY_KEY,
            },
        },
        update: {
            valueRaw: store as unknown as Prisma.InputJsonValue,
            valueSummary: `Source reliability scores for ${Object.keys(scores).length} sources`,
            updatedAt: new Date(),
        },
        create: {
            entityType: RELIABILITY_ENTITY_TYPE,
            entityId: RELIABILITY_ENTITY_ID,
            key: RELIABILITY_KEY,
            valueRaw: store as unknown as Prisma.InputJsonValue,
            valueSummary: `Source reliability scores for ${Object.keys(scores).length} sources`,
            confidence: 100,
            source: 'system',
            createdBy: 'librarian',
            isProtected: true,
            conflictLog: [],
        },
    });
}
