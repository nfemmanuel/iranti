/**
 * Feedback REST route for iranti (`/feedback`).
 *
 * Receives satisfaction signals submitted by the `iranti feedback` CLI command.
 * Unauthenticated — CLI users do not hold API keys. Rate-limited by IP to
 * discourage abuse. Idempotent on `feedbackId` (client UUID) via upsert, so
 * the CLI offline-retry queue can safely replay submissions.
 *
 *  POST /feedback — accept and persist a FeedbackPayload
 */

import { Router, Request, Response } from 'express';
import { getDb } from '../../library/client';
import { FeedbackType } from '../../generated/prisma/client';

export const feedbackRouter: Router = Router();

// ── Validation helpers ────────────────────────────────────────────────────────

const VALID_TYPES = new Set<string>(['bug', 'praise', 'suggestion', 'general']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(v: unknown): v is string {
    return typeof v === 'string' && UUID_RE.test(v);
}

function isValidRating(v: unknown): v is number {
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5;
}

function isValidType(v: unknown): v is FeedbackType {
    return typeof v === 'string' && VALID_TYPES.has(v);
}

function isNonEmptyString(v: unknown): v is string {
    return typeof v === 'string' && v.trim().length > 0;
}

function isValidIsoDate(v: unknown): v is string {
    if (typeof v !== 'string') return false;
    const d = new Date(v);
    return !isNaN(d.getTime());
}

// ── POST /feedback ────────────────────────────────────────────────────────────

feedbackRouter.post('/', async (req: Request, res: Response) => {
    const body = req.body ?? {};

    // Required field validation
    if (!isValidUuid(body.feedbackId)) {
        return res.status(400).json({ error: 'feedbackId must be a valid UUID.' });
    }
    if (!isValidRating(body.rating)) {
        return res.status(400).json({ error: 'rating must be an integer 1–5.' });
    }
    if (!isValidType(body.type)) {
        return res.status(400).json({ error: 'type must be one of: bug, praise, suggestion, general.' });
    }
    if (!isNonEmptyString(body.version)) {
        return res.status(400).json({ error: 'version is required.' });
    }
    if (!isNonEmptyString(body.instanceId)) {
        return res.status(400).json({ error: 'instanceId is required.' });
    }
    if (!isValidIsoDate(body.submittedAt)) {
        return res.status(400).json({ error: 'submittedAt must be a valid ISO 8601 date string.' });
    }

    // Optional field normalisation
    const comment = typeof body.comment === 'string' && body.comment.trim().length > 0
        ? body.comment.trim().slice(0, 2000)   // cap at 2000 chars
        : null;

    const os = isNonEmptyString(body.os) ? String(body.os).slice(0, 64) : 'unknown';
    const arch = isNonEmptyString(body.arch) ? String(body.arch).slice(0, 32) : 'unknown';
    const nodeVersion = isNonEmptyString(body.nodeVersion) ? String(body.nodeVersion).slice(0, 32) : 'unknown';

    const sessionCount = typeof body.sessionCount === 'number' && Number.isFinite(body.sessionCount)
        ? Math.max(0, Math.floor(body.sessionCount))
        : null;

    const factCount = typeof body.factCount === 'number' && Number.isFinite(body.factCount)
        ? Math.max(0, Math.floor(body.factCount))
        : null;

    const milestoneContext = typeof body.milestoneContext === 'string' && body.milestoneContext.trim().length > 0
        ? body.milestoneContext.trim().slice(0, 256)
        : null;

    try {
        const db = getDb();

        // Upsert on feedbackId — safe for the CLI offline-retry queue.
        // On conflict, update mutable fields only (comment, receivedAt) so
        // repeated drain attempts don't corrupt the original submission data.
        await db.feedback.upsert({
            where: { feedbackId: body.feedbackId },
            create: {
                feedbackId: body.feedbackId,
                rating: body.rating,
                comment,
                type: body.type as FeedbackType,
                version: String(body.version).slice(0, 32),
                os,
                arch,
                nodeVersion,
                sessionCount,
                factCount,
                instanceId: String(body.instanceId).slice(0, 64),
                milestoneContext,
                submittedAt: new Date(body.submittedAt),
            },
            update: {
                // Allow comment update in case first attempt sent null
                comment,
                receivedAt: new Date(),
            },
        });

        res.status(200).json({ ok: true });
    } catch (err) {
        console.error('[feedback] insert error:', err);
        res.status(500).json({ error: 'Failed to record feedback.' });
    }
});
