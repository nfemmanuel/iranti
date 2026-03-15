import { KnowledgeEntry } from '../generated/prisma/client';
import { findEntriesByEntity, findEntry } from '../library/queries';
import { EntryInput } from '../types';

type ContextualConflict = {
    matchedEntries: KnowledgeEntry[];
    reason: string;
};

type RelationshipRow = {
    fromType: string;
    fromId: string;
    relationshipType: string;
    toType: string;
    toId: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value as Record<string, unknown>;
}

function readString(value: unknown, key: string): string | null {
    const record = asRecord(value);
    const raw = record?.[key];
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

function readNumber(value: unknown, key: string): number | null {
    const record = asRecord(value);
    const raw = record?.[key];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function parseEntityRef(value: unknown): { entityType: string; entityId: string } | null {
    if (typeof value !== 'string') {
        return null;
    }
    const slash = value.indexOf('/');
    if (slash <= 0 || slash === value.length - 1) {
        return null;
    }
    return {
        entityType: value.slice(0, slash),
        entityId: value.slice(slash + 1),
    };
}

function parseIsoDate(value: unknown, key: string): Date | null {
    const iso = readString(value, key);
    if (!iso) return null;
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function hasState(value: unknown, expected: string): boolean {
    const state = readString(value, 'state');
    return state === expected;
}

function sameEntityConflict(candidate: EntryInput, sibling: KnowledgeEntry): string | null {
    const candidateValue = candidate.valueRaw;
    const siblingValue = sibling.valueRaw;

    if (
        candidate.key === 'launch_date'
        && sibling.key === 'status'
        && hasState(siblingValue, 'launched')
    ) {
        const launchDate = parseIsoDate(candidateValue, 'iso');
        if (launchDate && launchDate.getTime() > Date.now()) {
            return `Incoming ${candidate.key} conflicts with existing ${sibling.key}: launched entities should not have a future launch date.`;
        }
    }

    if (
        candidate.key === 'status'
        && sibling.key === 'launch_date'
        && hasState(candidateValue, 'launched')
    ) {
        const launchDate = parseIsoDate(siblingValue, 'iso');
        if (launchDate && launchDate.getTime() > Date.now()) {
            return `Incoming ${candidate.key} conflicts with existing ${sibling.key}: launched entities should not have a future launch date.`;
        }
    }

    if (
        candidate.key === 'remaining_tasks'
        && sibling.key === 'status'
        && hasState(siblingValue, 'completed')
    ) {
        const remaining = readNumber(candidateValue, 'count');
        if (remaining !== null && remaining > 0) {
            return `Incoming ${candidate.key} conflicts with existing ${sibling.key}: completed entities should not have remaining tasks.`;
        }
    }

    if (
        candidate.key === 'status'
        && sibling.key === 'remaining_tasks'
        && hasState(candidateValue, 'completed')
    ) {
        const remaining = readNumber(siblingValue, 'count');
        if (remaining !== null && remaining > 0) {
            return `Incoming ${candidate.key} conflicts with existing ${sibling.key}: completed entities should not have remaining tasks.`;
        }
    }

    if (
        candidate.key === 'hiring_status'
        && sibling.key === 'headcount'
        && hasState(candidateValue, 'actively_hiring')
    ) {
        const count = readNumber(siblingValue, 'count');
        if (count === 0) {
            return `Incoming ${candidate.key} conflicts with existing ${sibling.key}: actively hiring should not coexist with zero headcount without review.`;
        }
    }

    if (
        candidate.key === 'headcount'
        && sibling.key === 'hiring_status'
        && hasState(siblingValue, 'actively_hiring')
    ) {
        const count = readNumber(candidateValue, 'count');
        if (count === 0) {
            return `Incoming ${candidate.key} conflicts with existing ${sibling.key}: actively hiring should not coexist with zero headcount without review.`;
        }
    }

    if (
        candidate.key === 'procurement_status'
        && sibling.key === 'budget_status'
        && hasState(candidateValue, 'approved')
        && hasState(siblingValue, 'frozen')
    ) {
        return `Incoming ${candidate.key} conflicts with existing ${sibling.key}: procurement approval contradicts a frozen budget.`;
    }

    if (
        candidate.key === 'budget_status'
        && sibling.key === 'procurement_status'
        && hasState(candidateValue, 'frozen')
        && hasState(siblingValue, 'approved')
    ) {
        return `Incoming ${candidate.key} conflicts with existing ${sibling.key}: frozen budget contradicts approved procurement.`;
    }

    return null;
}

async function getRelationshipsForEntity(entityType: string, entityId: string, tx: any): Promise<RelationshipRow[]> {
    const [outbound, inbound] = await Promise.all([
        tx.entityRelationship.findMany({
            where: { fromType: entityType, fromId: entityId },
        }),
        tx.entityRelationship.findMany({
            where: { toType: entityType, toId: entityId },
        }),
    ]);

    return [...outbound, ...inbound] as RelationshipRow[];
}

async function relationshipConflict(candidate: EntryInput, tx: any): Promise<ContextualConflict | null> {
    if (candidate.key === 'status' && hasState(candidate.valueRaw, 'active') && candidate.entityType === 'team') {
        const relationships = await getRelationshipsForEntity(candidate.entityType, candidate.entityId, tx);
        const membership = relationships.find((row) =>
            row.fromType === candidate.entityType
            && row.fromId === candidate.entityId
            && row.relationshipType === 'MEMBER_OF'
        );

        if (membership) {
            const orgStatus = await findEntry({
                entityType: membership.toType,
                entityId: membership.toId,
                key: 'status',
            }, tx);

            if (orgStatus && hasState(orgStatus.valueRaw, 'dissolved')) {
                return {
                    matchedEntries: [orgStatus],
                    reason: `Incoming ${candidate.key} conflicts with related ${membership.toType}/${membership.toId} status: active teams should not belong to a dissolved organization.`,
                };
            }
        }
    }

    if (candidate.entityType === 'project' && candidate.key === 'lead_status' && hasState(candidate.valueRaw, 'active')) {
        const personRef = parseEntityRef(readString(candidate.valueRaw, 'person'));
        if (personRef) {
            const employment = await findEntry({
                entityType: personRef.entityType,
                entityId: personRef.entityId,
                key: 'employment_status',
            }, tx);
            const relation = await tx.entityRelationship.findFirst({
                where: {
                    fromType: personRef.entityType,
                    fromId: personRef.entityId,
                    relationshipType: 'LEADS',
                    toType: candidate.entityType,
                    toId: candidate.entityId,
                },
            });

            if (relation && employment && (hasState(employment.valueRaw, 'left_company') || hasState(employment.valueRaw, 'departed'))) {
                return {
                    matchedEntries: [employment],
                    reason: `Incoming ${candidate.key} conflicts with related ${personRef.entityType}/${personRef.entityId} employment status: departed people should not remain active project leads.`,
                };
            }
        }
    }

    if (candidate.entityType === 'project' && candidate.key === 'procurement_status' && hasState(candidate.valueRaw, 'approved')) {
        const supplierRef = parseEntityRef(readString(candidate.valueRaw, 'supplier'));
        if (supplierRef) {
            const compliance = await findEntry({
                entityType: supplierRef.entityType,
                entityId: supplierRef.entityId,
                key: 'compliance_status',
            }, tx);
            const relation = await tx.entityRelationship.findFirst({
                where: {
                    fromType: candidate.entityType,
                    fromId: candidate.entityId,
                    relationshipType: 'DEPENDS_ON',
                    toType: supplierRef.entityType,
                    toId: supplierRef.entityId,
                },
            });

            if (relation && compliance && hasState(compliance.valueRaw, 'blacklisted')) {
                return {
                    matchedEntries: [compliance],
                    reason: `Incoming ${candidate.key} conflicts with related ${supplierRef.entityType}/${supplierRef.entityId} compliance status: approved procurement should not rely on a blacklisted supplier.`,
                };
            }
        }
    }

    if (candidate.entityType === 'project' && candidate.key === 'principal_investigator') {
        const researcherRef = parseEntityRef(readString(candidate.valueRaw, 'researcher'));
        if (researcherRef) {
            const employment = await findEntry({
                entityType: researcherRef.entityType,
                entityId: researcherRef.entityId,
                key: 'employment_status',
            }, tx);

            if (employment && hasState(employment.valueRaw, 'departed')) {
                const projectIncoming = await tx.entityRelationship.findMany({
                    where: {
                        toType: candidate.entityType,
                        toId: candidate.entityId,
                        relationshipType: 'LEADS',
                    },
                });

                for (const leadEdge of projectIncoming as RelationshipRow[]) {
                    const membership = await tx.entityRelationship.findFirst({
                        where: {
                            fromType: researcherRef.entityType,
                            fromId: researcherRef.entityId,
                            relationshipType: 'MEMBER_OF',
                            toType: leadEdge.fromType,
                            toId: leadEdge.fromId,
                        },
                    });

                    if (membership) {
                        return {
                            matchedEntries: [employment],
                            reason: `Incoming ${candidate.key} conflicts with related ${researcherRef.entityType}/${researcherRef.entityId} employment status through the lab/project graph: departed researchers should not remain principal investigators.`,
                        };
                    }
                }
            }
        }
    }

    return null;
}

export async function detectContextualConflict(candidate: EntryInput, tx: any): Promise<ContextualConflict | null> {
    const siblingEntries = (await findEntriesByEntity(candidate.entityType, candidate.entityId, tx))
        .filter((entry) => entry.key !== candidate.key);

    for (const sibling of siblingEntries) {
        const reason = sameEntityConflict(candidate, sibling);
        if (reason) {
            return {
                matchedEntries: [sibling],
                reason,
            };
        }
    }

    return relationshipConflict(candidate, tx);
}
