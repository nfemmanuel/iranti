/**
 * Issue fact builders for Iranti's structured issue tracking.
 *
 * Constructs normalized fact values and property blocks for `issue_status`
 * durable class entries. Issue facts carry lifecycle state (open/resolved),
 * severity, and semantic tags so retrieval can filter by issue status.
 *
 * The `issueId` is normalized (trim → lowercase → snake_case) when building
 * the canonical key, so callers can pass human-readable IDs like "DB Migration
 * Failing" and receive a stable key like `issue_db_migration_failing`.
 *
 * Key exports:
 *   - buildIssueFactWrite()       — full write payload for iranti_write_issue
 *   - buildIssueFactValue()       — the raw fact value object
 *   - buildIssueFactProperties()  — the properties block with semantic tags
 *   - issueFactKey()              — normalize an issueId to "issue_{token}" key
 */

import { buildSemanticFactTags } from './semanticFactTags';

export type IssueStatus = 'open' | 'resolved';
export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';

export type IssueFactInput = {
    entity: string;
    issueId: string;
    title: string;
    status: IssueStatus;
    summary: string;
    confidence: number;
    source: string;
    agent: string;
    severity?: IssueSeverity;
    details?: unknown;
    discoveredAt?: string;
    resolvedAt?: string;
    resolution?: string;
    tags?: string[];
    validFrom?: Date;
    requestId?: string;
    properties?: Record<string, unknown>;
};

function normalizeIssueToken(value: string): string {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!normalized) {
        throw new Error('issueId must contain at least one alphanumeric character.');
    }
    return normalized;
}

export function issueFactKey(issueId: string): string {
    return `issue_${normalizeIssueToken(issueId)}`;
}

export function buildIssueFactValue(input: IssueFactInput): Record<string, unknown> {
    return {
        issueId: normalizeIssueToken(input.issueId),
        title: input.title.trim(),
        status: input.status,
        severity: input.severity ?? 'medium',
        summary: input.summary.trim(),
        details: input.details ?? null,
        discoveredAt: input.discoveredAt ?? null,
        resolvedAt: input.status === 'resolved' ? (input.resolvedAt ?? null) : null,
        resolution: input.status === 'resolved' ? (input.resolution ?? null) : null,
        tags: Array.from(new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))),
    };
}

export function buildIssueFactProperties(input: IssueFactInput): Record<string, unknown> {
    const issueId = normalizeIssueToken(input.issueId);
    const mergeStrategy = 'replace' as const;
    return {
        memoryScope: 'project',
        capturePhase: 'manual',
        durableClass: 'issue_status',
        canonicalKey: issueFactKey(input.issueId),
        mergeStrategy,
        issueId,
        issueStatus: input.status,
        issueSeverity: input.severity ?? 'medium',
        issueTitle: input.title.trim(),
        ...buildSemanticFactTags({
            memoryScope: 'project',
            durableClass: 'issue_status',
            mergeStrategy,
            extraTags: ['issue', input.status, input.severity ?? 'medium', ...(input.tags ?? [])],
        }),
        ...(input.properties ?? {}),
    };
}

export function buildIssueFactWrite(input: IssueFactInput) {
    return {
        entity: input.entity,
        key: issueFactKey(input.issueId),
        value: buildIssueFactValue(input),
        summary: input.summary.trim(),
        confidence: input.confidence,
        source: input.source,
        agent: input.agent,
        validFrom: input.validFrom,
        requestId: input.requestId,
        properties: buildIssueFactProperties(input),
    };
}
