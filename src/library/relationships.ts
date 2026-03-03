import { getDb } from './client';
import { Prisma } from '../generated/prisma/client';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RelationshipInput {
    fromType: string;
    fromId: string;
    relationshipType: string;
    toType: string;
    toId: string;
    createdBy: string;
    properties?: Record<string, unknown>;
}

export interface Relationship {
    fromType: string;
    fromId: string;
    relationshipType: string;
    toType: string;
    toId: string;
    properties: Record<string, unknown>;
    createdAt: Date;
}

export interface RelatedEntity {
    entityType: string;
    entityId: string;
    relationshipType: string;
    direction: 'outbound' | 'inbound';
    properties: Record<string, unknown>;
}

// ─── Write ───────────────────────────────────────────────────────────────────

export async function createRelationship(input: RelationshipInput): Promise<Relationship> {
    const result = await getDb().entityRelationship.upsert({
        where: {
            fromType_fromId_relationshipType_toType_toId: {
                fromType: input.fromType,
                fromId: input.fromId,
                relationshipType: input.relationshipType,
                toType: input.toType,
                toId: input.toId,
            },
        },
        update: {
            properties: (input.properties ?? {}) as Prisma.InputJsonValue,
        },
        create: {
            fromType: input.fromType,
            fromId: input.fromId,
            relationshipType: input.relationshipType,
            toType: input.toType,
            toId: input.toId,
            createdBy: input.createdBy,
            properties: (input.properties ?? {}) as Prisma.InputJsonValue,
        },
    });

    return {
        ...result,
        properties: (result.properties ?? {}) as Record<string, unknown>,
    };
}

// ─── Read ────────────────────────────────────────────────────────────────────

export async function getRelated(
    entityType: string,
    entityId: string
): Promise<RelatedEntity[]> {
    const [outbound, inbound] = await Promise.all([
        getDb().entityRelationship.findMany({
            where: { fromType: entityType, fromId: entityId },
        }),
        getDb().entityRelationship.findMany({
            where: { toType: entityType, toId: entityId },
        }),
    ]);

    const results: RelatedEntity[] = [
        ...outbound.map((r: any) => ({
            entityType: r.toType,
            entityId: r.toId,
            relationshipType: r.relationshipType,
            direction: 'outbound' as const,
            properties: (r.properties ?? {}) as Record<string, unknown>,
        })),
        ...inbound.map((r: any) => ({
            entityType: r.fromType,
            entityId: r.fromId,
            relationshipType: r.relationshipType,
            direction: 'inbound' as const,
            properties: (r.properties ?? {}) as Record<string, unknown>,
        })),
    ];

    return results;
}

export async function getRelatedDeep(
    entityType: string,
    entityId: string,
    depth: number = 2
): Promise<RelatedEntity[]> {
    const visited = new Set<string>();
    const allRelated: RelatedEntity[] = [];

    async function traverse(type: string, id: string, currentDepth: number): Promise<void> {
        const key = `${type}/${id}`;
        if (visited.has(key) || currentDepth === 0) return;
        visited.add(key);

        const related = await getRelated(type, id);
        for (const r of related) {
            allRelated.push(r);
            await traverse(r.entityType, r.entityId, currentDepth - 1);
        }
    }

    await traverse(entityType, entityId, depth);
    return allRelated;
}

// ─── Delete ──────────────────────────────────────────────────────────────────

export async function deleteRelationship(
    fromType: string,
    fromId: string,
    relationshipType: string,
    toType: string,
    toId: string
): Promise<void> {
    await getDb().entityRelationship.delete({
        where: {
            fromType_fromId_relationshipType_toType_toId: {
                fromType,
                fromId,
                relationshipType,
                toType,
                toId,
            },
        },
    });
}