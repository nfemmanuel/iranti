/**
 * Feedback collection module for the iranti CLI.
 *
 * Surfaces satisfaction signals via the `iranti feedback` command:
 * single-keypress rating, optional free-text comment, anonymous persistent
 * UUID, local throttle, and offline fallback queue. No DB required — relies
 * only on .iranti/ local files and the telemetry endpoint.
 *
 * Passive usage signals (session-stats.json) are read here so that Phase 3
 * (milestone nudges in iranti_handshake) has rich data without any active
 * user action. The MCP server writes that file; this module only reads it.
 *
 * Exported types are also used by the MCP nudge system (Phase 3) which reads
 * SessionStats and calls recordMilestoneNudgeSeen() to prevent repeat nudges.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import https from 'https';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { randomUUID } from 'crypto';

// ── Public types ─────────────────────────────────────────────────────────────

export type FeedbackType = 'bug' | 'praise' | 'suggestion' | 'general';

export type FeedbackPayload = {
    feedbackId: string;
    rating: number;
    comment: string | null;
    type: FeedbackType;
    version: string;
    os: string;
    arch: string;
    nodeVersion: string;
    sessionCount: number | null;
    factCount: number | null;
    instanceId: string;
    milestoneContext: string | null;
    submittedAt: string;
};

/** Passive usage stats written by the MCP server at each session. */
export type SessionStats = {
    totalSessions: number;
    totalWrites: number;
    totalAttends: number;
    totalValueDeliveries: number;
    uniqueHosts: string[];
    firstSessionAt: string;
    lastSessionAt: string;
    feedbackMilestonesSeen: string[];
};

export type FeedbackRunOptions = {
    rating?: number;
    comment?: string;
    type?: FeedbackType;
    dryRun?: boolean;
    offline?: boolean;
    milestoneContext?: string | null;
    factCount?: number | null;
    version: string;
};

// ── Internal types ────────────────────────────────────────────────────────────

type ThrottleRecord = {
    count: number;
    lastRating: number;
    lastSentAt: string;
};

type PendingFeedback = FeedbackPayload & { retryable: true };

// ── Constants ─────────────────────────────────────────────────────────────────

const ENDPOINT = 'https://api.iranti.dev/feedback';
const TIMEOUT_MS = 5_000;
const THROTTLE_DAYS = 7;
const BUG_THROTTLE_DAYS = 1;

const RATING_LABELS: Record<number, string> = {
    1: 'Great',
    2: 'OK',
    3: 'Not great',
    4: 'Good',
    5: 'Excellent',
};

// ── File path helpers ─────────────────────────────────────────────────────────

/** Resolve the .iranti/ directory. Prefer cwd/.iranti if it exists. */
function resolveIrantiDir(): string {
    const local = path.join(process.cwd(), '.iranti');
    return fs.existsSync(local) ? local : path.join(os.homedir(), '.iranti');
}

async function ensureDir(dir: string): Promise<void> {
    await fsp.mkdir(dir, { recursive: true });
}

// ── Instance ID ───────────────────────────────────────────────────────────────

/**
 * Return the persistent anonymous instance UUID, creating it if absent.
 * Stored at .iranti/instance-id. Never contains PII.
 */
async function getOrCreateInstanceId(irantiDir: string): Promise<string> {
    const file = path.join(irantiDir, 'instance-id');
    try {
        return (await fsp.readFile(file, 'utf8')).trim();
    } catch {
        const id = randomUUID();
        await ensureDir(irantiDir);
        await fsp.writeFile(file, id, 'utf8');
        return id;
    }
}

// ── Session stats (passive signal) ───────────────────────────────────────────

/** Read passive usage stats accumulated by the MCP server. Returns null if absent. */
export async function readSessionStats(irantiDir: string): Promise<SessionStats | null> {
    try {
        const raw = await fsp.readFile(path.join(irantiDir, 'session-stats.json'), 'utf8');
        return JSON.parse(raw) as SessionStats;
    } catch {
        return null;
    }
}

/**
 * Record that a milestone nudge key was shown so it doesn't repeat.
 * Used by the MCP nudge system (Phase 3).
 */
export async function recordMilestoneNudgeSeen(irantiDir: string, milestoneKey: string): Promise<void> {
    const file = path.join(irantiDir, 'session-stats.json');
    const stats = (await readSessionStats(irantiDir)) ?? ({} as Partial<SessionStats>);
    const seen = stats.feedbackMilestonesSeen ?? [];
    if (!seen.includes(milestoneKey)) {
        seen.push(milestoneKey);
        const updated: SessionStats = {
            totalSessions: stats.totalSessions ?? 0,
            totalWrites: stats.totalWrites ?? 0,
            totalAttends: stats.totalAttends ?? 0,
            totalValueDeliveries: stats.totalValueDeliveries ?? 0,
            uniqueHosts: stats.uniqueHosts ?? [],
            firstSessionAt: stats.firstSessionAt ?? new Date().toISOString(),
            lastSessionAt: stats.lastSessionAt ?? new Date().toISOString(),
            feedbackMilestonesSeen: seen,
        };
        await ensureDir(irantiDir);
        await fsp.writeFile(file, JSON.stringify(updated, null, 2) + '\n', 'utf8');
    }
}

// ── Throttle ──────────────────────────────────────────────────────────────────

async function isThrottled(irantiDir: string, type: FeedbackType): Promise<boolean> {
    try {
        const raw = await fsp.readFile(path.join(irantiDir, 'feedback-sent.json'), 'utf8');
        const record = JSON.parse(raw) as ThrottleRecord;
        const lastSent = new Date(record.lastSentAt).getTime();
        const cooldownDays = type === 'bug' ? BUG_THROTTLE_DAYS : THROTTLE_DAYS;
        return Date.now() - lastSent < cooldownDays * 86_400_000;
    } catch {
        return false;
    }
}

async function recordSent(irantiDir: string, rating: number): Promise<void> {
    const file = path.join(irantiDir, 'feedback-sent.json');
    let existing: Partial<ThrottleRecord> = {};
    try {
        existing = JSON.parse(await fsp.readFile(file, 'utf8')) as ThrottleRecord;
    } catch { /* ok */ }
    const updated: ThrottleRecord = {
        count: (existing.count ?? 0) + 1,
        lastRating: rating,
        lastSentAt: new Date().toISOString(),
    };
    await ensureDir(irantiDir);
    await fsp.writeFile(file, JSON.stringify(updated, null, 2) + '\n', 'utf8');
}

// ── Offline queue ─────────────────────────────────────────────────────────────

async function writePending(irantiDir: string, payload: FeedbackPayload): Promise<void> {
    const file = path.join(irantiDir, 'pending-feedback.json');
    let pending: PendingFeedback[] = [];
    try {
        pending = JSON.parse(await fsp.readFile(file, 'utf8')) as PendingFeedback[];
    } catch { /* ok */ }
    pending.push({ ...payload, retryable: true });
    await ensureDir(irantiDir);
    await fsp.writeFile(file, JSON.stringify(pending, null, 2) + '\n', 'utf8');
}

// ── HTTP submission ───────────────────────────────────────────────────────────

function postFeedback(payload: FeedbackPayload): Promise<void> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const url = new URL(ENDPOINT);
        const req = https.request(
            {
                hostname: url.hostname,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
                timeout: TIMEOUT_MS,
            },
            (res) => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    resolve();
                } else {
                    reject(new Error(`HTTP ${res.statusCode}`));
                }
                res.resume();
            },
        );
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ── Interactive prompts ───────────────────────────────────────────────────────

/**
 * Read a single keypress without requiring Enter. Uses raw mode.
 * Returns the key pressed, or throws 'ctrl_c' / 'not_tty'.
 */
function readSingleKey(): Promise<string> {
    return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        if (!stdin.isTTY) {
            reject(new Error('not_tty'));
            return;
        }
        const wasRaw = (stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw ?? false;
        try {
            stdin.setRawMode(true);
        } catch {
            reject(new Error('not_tty'));
            return;
        }
        stdin.resume();
        stdin.setEncoding('utf8');

        const onData = (key: string) => {
            stdin.removeListener('data', onData);
            stdin.pause();
            try { stdin.setRawMode(wasRaw); } catch { /* ok */ }
            if (key === '\u0003') reject(new Error('ctrl_c'));
            else resolve(key);
        };
        stdin.on('data', onData);
    });
}

/**
 * Show the rating prompt and wait for a single keypress (1/2/3).
 * Returns the chosen rating or null on cancellation/invalid input.
 */
async function promptRating(): Promise<number | null> {
    process.stdout.write('\n  How\'s Iranti working for you?\n\n');
    process.stdout.write('    \uD83D\uDE0A Great (1)   \uD83D\uDE10 OK (2)   \uD83D\uDE1E Not great (3)\n\n');
    process.stdout.write('  Press 1, 2, or 3: ');

    let key: string;
    try {
        key = await readSingleKey();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'ctrl_c') process.stdout.write('\n');
        return null;
    }

    if (!['1', '2', '3'].includes(key)) {
        process.stdout.write('\n  (invalid key — type 1, 2, or 3)\n');
        return null;
    }

    process.stdout.write(`${key}\n`);
    return Number(key);
}

/**
 * Prompt for an optional free-text comment. Enter submits, empty string skips.
 */
async function promptComment(): Promise<string | null> {
    process.stdout.write('\n  Anything specific? (Enter to skip)\n  > ');
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: process.stdout.isTTY,
        });
        rl.question('', (answer) => {
            rl.close();
            const trimmed = answer.trim();
            resolve(trimmed.length > 0 ? trimmed : null);
        });
    });
}

// ── Main entrypoint ───────────────────────────────────────────────────────────

/**
 * Run the full feedback collection flow.
 *
 * Respects user's time: throttled by default (7 days), bugs by 1 day.
 * If the endpoint is unreachable, saves to .iranti/pending-feedback.json
 * for silent retry on the next run.
 */
export async function runFeedbackCommand(opts: FeedbackRunOptions): Promise<void> {
    const irantiDir = resolveIrantiDir();
    const type: FeedbackType = opts.type ?? 'general';

    if (!opts.dryRun && !opts.offline) {
        if (await isThrottled(irantiDir, type)) {
            const days = type === 'bug' ? BUG_THROTTLE_DAYS : THROTTLE_DAYS;
            console.log(`  Feedback already submitted recently. You can send again after ${days} day${days === 1 ? '' : 's'}.`);
            if (type !== 'bug') console.log('  To report a bug sooner: iranti feedback --type bug');
            return;
        }
    }

    let rating: number;
    if (opts.rating !== undefined) {
        rating = opts.rating;
    } else {
        const interactive = await promptRating();
        if (interactive === null) return;
        rating = interactive;
    }

    let comment: string | null;
    if (opts.comment !== undefined) {
        comment = opts.comment;
    } else {
        comment = await promptComment();
    }

    const stats = await readSessionStats(irantiDir);
    const instanceId = await getOrCreateInstanceId(irantiDir);

    const payload: FeedbackPayload = {
        feedbackId: randomUUID(),
        rating,
        comment,
        type,
        version: opts.version,
        os: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        sessionCount: stats?.totalSessions ?? null,
        factCount: opts.factCount ?? null,
        instanceId,
        milestoneContext: opts.milestoneContext ?? null,
        submittedAt: new Date().toISOString(),
    };

    if (opts.dryRun) {
        console.log('\n  [dry-run] Payload that would be sent:\n');
        console.log(JSON.stringify(payload, null, 2));
        return;
    }

    if (opts.offline) {
        await writePending(irantiDir, payload);
        console.log('\n  Saved locally \u2014 will retry next time.');
        return;
    }

    try {
        await postFeedback(payload);
        await recordSent(irantiDir, rating);
        const label = RATING_LABELS[rating] ?? String(rating);
        process.stdout.write(`\n  \u2713 Sent (${label}). Thanks for helping shape Iranti.\n\n`);
    } catch {
        await writePending(irantiDir, payload);
        process.stdout.write('\n  Saved locally \u2014 will retry next time.\n\n');
    }
}
