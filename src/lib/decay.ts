/**
 * Memory decay model for Iranti knowledge entries.
 *
 * Implements an Ebbinghaus-inspired forgetting curve: confidence decays
 * exponentially as a function of time since last access and a per-fact
 * stability value. Decay is opt-in (disabled by default) and controlled
 * entirely via IRANTI_DECAY_* environment variables.
 *
 * Key functions:
 *   - getDecayConfig()              — read decay settings from env
 *   - calculateRetention()          — Ebbinghaus retention fraction [0,1]
 *   - calculateDecayedConfidence()  — apply retention to a confidence score
 *   - initialStabilityFromReliability() — seed stability from source reliability
 */

export type DecayConfig = {
    enabled: boolean;
    stabilityBase: number;
    stabilityIncrement: number;
    stabilityMax: number;
    threshold: number;
};

const DEFAULT_DECAY_CONFIG: DecayConfig = {
    enabled: false,
    stabilityBase: 30,
    stabilityIncrement: 5,
    stabilityMax: 365,
    threshold: 10,
};

function readNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;

    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getDecayConfig(): DecayConfig {
    return {
        enabled: String(process.env.IRANTI_DECAY_ENABLED ?? '').toLowerCase() === 'true',
        stabilityBase: readNumber('IRANTI_DECAY_STABILITY_BASE', DEFAULT_DECAY_CONFIG.stabilityBase),
        stabilityIncrement: readNumber('IRANTI_DECAY_STABILITY_INCREMENT', DEFAULT_DECAY_CONFIG.stabilityIncrement),
        stabilityMax: readNumber('IRANTI_DECAY_STABILITY_MAX', DEFAULT_DECAY_CONFIG.stabilityMax),
        threshold: readNumber('IRANTI_DECAY_THRESHOLD', DEFAULT_DECAY_CONFIG.threshold),
    };
}

export function calculateRetention(timeSinceAccessDays: number, stability: number): number {
    const boundedDays = Math.max(0, timeSinceAccessDays);
    const boundedStability = Math.max(1, stability);
    return Math.exp(-(boundedDays / boundedStability));
}

export function calculateDecayedConfidence(
    originalConfidence: number,
    timeSinceAccessDays: number,
    stability: number
): number {
    const retention = calculateRetention(timeSinceAccessDays, stability);
    return Math.max(0, Math.min(100, Math.round(originalConfidence * retention)));
}

// Stability multiplier bounds: reliability 0 → multiplier 0.75 (minimum stable), reliability 1 → multiplier 1.25 (maximum stable).
// A mid-range source (0.5 reliability) maps to a 1.0× multiplier == stabilityBase days.
const STABILITY_MULTIPLIER_BASE = 0.75;
const STABILITY_MULTIPLIER_RANGE = 0.5;

export function initialStabilityFromReliability(reliability: number, config: DecayConfig = getDecayConfig()): number {
    const boundedReliability = Math.max(0.1, Math.min(1, reliability));
    const multiplier = STABILITY_MULTIPLIER_BASE + (boundedReliability * STABILITY_MULTIPLIER_RANGE);
    return Math.min(config.stabilityMax, Math.max(1, Math.round(config.stabilityBase * multiplier * 100) / 100));
}

export function readOriginalConfidence(
    properties: unknown,
    fallbackConfidence: number
): number {
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
        const original = (properties as Record<string, unknown>).originalConfidence;
        if (typeof original === 'number' && Number.isFinite(original)) {
            return Math.max(0, Math.min(100, Math.round(original)));
        }
    }
    return Math.max(0, Math.min(100, Math.round(fallbackConfidence)));
}
