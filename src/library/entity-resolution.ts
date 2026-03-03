import { getDb } from './client';

export type ResolveMatch = 'exact' | 'alias' | 'created';

export interface ResolveEntityInput {
    entityType: string;
    entityId?: string;
    rawName?: string;
    aliases?: string[];
    source?: string;
    confidence?: number;
    createIfMissing?: boolean;
}

export interface ResolveEntityResult {
    entityType: string;
    entityId: string;
    canonicalEntity: string;
    matchedBy: ResolveMatch;
    addedAliases: string[];
}

export interface AddAliasInput {
    canonicalEntity: string;
    alias: string;
    source?: string;
    confidence?: number;
    force?: boolean;
}

export interface EntityAliasRecord {
    alias: string;
    aliasNorm: string;
    source: string;
    confidence: number;
    createdAt: string;
}

const DEFAULT_SOURCE = 'system';
const DEFAULT_CONFIDENCE = 50;

function clampConfidence(confidence: number | undefined): number {
    const value = confidence ?? DEFAULT_CONFIDENCE;
    return Math.max(0, Math.min(100, Math.round(value)));
}

export function parseEntityString(entity: string): { entityType: string; entityId: string } {
    if (!entity || typeof entity !== 'string') {
        throw new Error('Entity must be a non-empty string.');
    }

    const parts = entity.split('/');
    if (parts.length < 2 || !parts[0] || !parts[1]) {
        throw new Error(
            `Invalid entity format: "${entity}". Expected "entityType/entityId" with non-empty values.`
        );
    }

    return {
        entityType: parts[0],
        entityId: parts.slice(1).join('/'),
    };
}

export function normalizeAlias(input: string, entityType: string): string {
    let value = input.trim().toLowerCase();
    if (!value) return '';

    if (value.includes('/')) {
        const [maybeType, ...rest] = value.split('/');
        if (maybeType === entityType.toLowerCase() && rest.length > 0) {
            value = rest.join('/');
        }
    }

    value = value.replace(/[_-]+/g, ' ');
    value = value.replace(/[^a-z0-9\s]/g, ' ');
    value = value.replace(/\s+/g, ' ').trim();

    if (value.startsWith('the ')) {
        value = value.slice(4).trim();
    }

    if (entityType.toLowerCase() === 'project' && value.startsWith('project ')) {
        value = value.slice(8).trim();
    }

    return value;
}

function toCanonicalEntityId(entityType: string, entityId?: string, rawName?: string): string {
    const fromId = entityId ? normalizeAlias(entityId, entityType) : '';
    const fromName = rawName ? normalizeAlias(rawName, entityType) : '';
    const normalized = fromId || fromName || `entity_${Date.now()}`;
    return normalized.replace(/\s+/g, '_');
}

function buildCandidateEntityIds(entityType: string, entityId?: string, rawName?: string): string[] {
    const candidates: string[] = [];
    const seen = new Set<string>();

    const add = (value: string) => {
        const clean = value.trim();
        if (!clean) return;
        if (seen.has(clean)) return;
        seen.add(clean);
        candidates.push(clean);
    };

    const normalizedId = entityId ? normalizeAlias(entityId, entityType) : '';
    const normalizedName = rawName ? normalizeAlias(rawName, entityType) : '';

    const asIds = [normalizedId, normalizedName]
        .filter(Boolean)
        .map((v) => v.replace(/\s+/g, '_'));

    for (const id of asIds) {
        add(id);
        if (entityType.toLowerCase() === 'project') {
            if (!id.startsWith('project_')) add(`project_${id}`);
            if (id.startsWith('project_')) add(id.replace(/^project_/, ''));
        }
    }

    return candidates;
}

function uniqueAliases(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];

    for (const raw of values) {
        const value = raw.trim();
        if (!value) continue;
        const dedupeKey = value.toLowerCase();
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        out.push(value);
    }

    return out;
}

function buildAliasCandidates(input: ResolveEntityInput, canonicalEntity: string): string[] {
    const aliases: string[] = [];

    if (input.rawName) aliases.push(input.rawName);
    if (input.entityId) {
        aliases.push(input.entityId);
        aliases.push(`${input.entityType}/${input.entityId}`);
    }
    if (input.aliases?.length) aliases.push(...input.aliases);
    aliases.push(canonicalEntity);

    return uniqueAliases(aliases);
}

async function ensureEntity(entityType: string, entityId: string, displayName: string): Promise<void> {
    await getDb().entity.upsert({
        where: {
            entityType_entityId: { entityType, entityId },
        },
        update: {
            displayName,
        },
        create: {
            entityType,
            entityId,
            displayName,
        },
    });
}

async function ensureAliases(params: {
    entityType: string;
    canonicalEntityId: string;
    aliases: string[];
    source: string;
    confidence: number;
    force?: boolean;
}): Promise<string[]> {
    const { entityType, canonicalEntityId, aliases, source, confidence, force = false } = params;
    const db = getDb();
    const added: string[] = [];

    for (const alias of aliases) {
        const aliasNorm = normalizeAlias(alias, entityType);
        if (!aliasNorm) continue;

        const existing = await db.entityAlias.findUnique({
            where: {
                entityType_aliasNorm: {
                    entityType,
                    aliasNorm,
                },
            },
        });

        if (!existing) {
            await db.entityAlias.create({
                data: {
                    entityType,
                    aliasNorm,
                    rawAlias: alias.slice(0, 256),
                    canonicalEntityType: entityType,
                    canonicalEntityId,
                    source,
                    confidence,
                },
            });
            added.push(aliasNorm);
            continue;
        }

        const pointsToSame =
            existing.canonicalEntityType === entityType &&
            existing.canonicalEntityId === canonicalEntityId;

        if (!pointsToSame && force) {
            await db.entityAlias.update({
                where: { id: existing.id },
                data: {
                    rawAlias: alias.slice(0, 256),
                    canonicalEntityType: entityType,
                    canonicalEntityId,
                    source,
                    confidence,
                },
            });
            continue;
        }

        if (pointsToSame) {
            await db.entityAlias.update({
                where: { id: existing.id },
                data: {
                    rawAlias: alias.slice(0, 256),
                    source,
                    confidence,
                },
            });
        }
    }

    return added;
}

export async function resolveEntity(input: ResolveEntityInput): Promise<ResolveEntityResult> {
    if (!input.entityType?.trim()) {
        throw new Error('entityType is required for resolution.');
    }

    const entityType = input.entityType.trim();
    const source = input.source ?? DEFAULT_SOURCE;
    const confidence = clampConfidence(input.confidence);
    const createIfMissing = input.createIfMissing ?? true;
    const canonicalEntityIdGuess = toCanonicalEntityId(entityType, input.entityId, input.rawName);
    const candidateEntityIds = buildCandidateEntityIds(entityType, input.entityId, input.rawName);
    const canonicalEntityGuess = `${entityType}/${canonicalEntityIdGuess}`;
    const aliases = buildAliasCandidates(input, canonicalEntityGuess);
    const aliasNorms = uniqueAliases(
        aliases
            .map((alias) => normalizeAlias(alias, entityType))
            .filter((alias) => alias.length > 0)
    );

    const db = getDb();

    if (aliasNorms.length > 0) {
        const matchedAlias = await db.entityAlias.findFirst({
            where: {
                entityType,
                aliasNorm: { in: aliasNorms },
            },
            orderBy: { id: 'asc' },
        });

        if (matchedAlias) {
            const canonicalEntity = `${matchedAlias.canonicalEntityType}/${matchedAlias.canonicalEntityId}`;
            await ensureEntity(
                matchedAlias.canonicalEntityType,
                matchedAlias.canonicalEntityId,
                input.rawName?.trim() || matchedAlias.canonicalEntityId
            );
            const addedAliases = await ensureAliases({
                entityType: matchedAlias.canonicalEntityType,
                canonicalEntityId: matchedAlias.canonicalEntityId,
                aliases,
                source,
                confidence,
            });

            return {
                entityType: matchedAlias.canonicalEntityType,
                entityId: matchedAlias.canonicalEntityId,
                canonicalEntity,
                matchedBy: 'alias',
                addedAliases,
            };
        }
    }

    for (const candidateId of candidateEntityIds) {
        const existingEntity = await db.entity.findUnique({
            where: {
                entityType_entityId: {
                    entityType,
                    entityId: candidateId,
                },
            },
        });

        if (existingEntity) {
            const canonicalEntity = `${entityType}/${candidateId}`;
            const addedAliases = await ensureAliases({
                entityType,
                canonicalEntityId: candidateId,
                aliases,
                source,
                confidence,
            });

            return {
                entityType,
                entityId: candidateId,
                canonicalEntity,
                matchedBy: 'exact',
                addedAliases,
            };
        }
    }

    for (const candidateId of candidateEntityIds) {
        const hasKnowledgeRows = await db.knowledgeEntry.findFirst({
            where: {
                entityType,
                entityId: candidateId,
            },
            select: { id: true },
        });

        if (hasKnowledgeRows) {
            await ensureEntity(entityType, candidateId, input.rawName?.trim() || candidateId);
            const canonicalEntity = `${entityType}/${candidateId}`;
            const addedAliases = await ensureAliases({
                entityType,
                canonicalEntityId: candidateId,
                aliases,
                source,
                confidence,
            });

            return {
                entityType,
                entityId: candidateId,
                canonicalEntity,
                matchedBy: 'exact',
                addedAliases,
            };
        }
    }

    if (!createIfMissing) {
        throw new Error(`Entity not found for resolution: ${entityType}/${input.entityId ?? input.rawName ?? '(unknown)'}`);
    }

    const canonicalEntityId = canonicalEntityIdGuess;
    const canonicalEntity = `${entityType}/${canonicalEntityId}`;
    await ensureEntity(entityType, canonicalEntityId, input.rawName?.trim() || canonicalEntityId);
    const addedAliases = await ensureAliases({
        entityType,
        canonicalEntityId,
        aliases,
        source,
        confidence,
    });

    return {
        entityType,
        entityId: canonicalEntityId,
        canonicalEntity,
        matchedBy: 'created',
        addedAliases,
    };
}

export async function addAlias(input: AddAliasInput): Promise<{ canonicalEntity: string; aliasNormalized: string; created: boolean }> {
    const canonical = parseEntityString(input.canonicalEntity);
    const aliasNormalized = normalizeAlias(input.alias, canonical.entityType);
    if (!aliasNormalized) {
        throw new Error('Alias is empty after normalization.');
    }

    await ensureEntity(canonical.entityType, canonical.entityId, canonical.entityId);

    const added = await ensureAliases({
        entityType: canonical.entityType,
        canonicalEntityId: canonical.entityId,
        aliases: [input.alias],
        source: input.source ?? DEFAULT_SOURCE,
        confidence: clampConfidence(input.confidence),
        force: input.force ?? false,
    });

    return {
        canonicalEntity: `${canonical.entityType}/${canonical.entityId}`,
        aliasNormalized,
        created: added.includes(aliasNormalized),
    };
}

export async function listAliases(entity: string): Promise<{ canonicalEntity: string; aliases: EntityAliasRecord[] }> {
    const parsed = parseEntityString(entity);
    const rows = await getDb().entityAlias.findMany({
        where: {
            canonicalEntityType: parsed.entityType,
            canonicalEntityId: parsed.entityId,
        },
        orderBy: { createdAt: 'asc' },
    });

    return {
        canonicalEntity: `${parsed.entityType}/${parsed.entityId}`,
        aliases: rows.map((row) => ({
            alias: row.rawAlias,
            aliasNorm: row.aliasNorm,
            source: row.source,
            confidence: row.confidence,
            createdAt: row.createdAt.toISOString(),
        })),
    };
}
