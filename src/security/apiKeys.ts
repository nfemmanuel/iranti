import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { getDb } from '../library/client';
import { Prisma } from '../generated/prisma/client';

const REGISTRY_ENTITY_TYPE = 'system';
const REGISTRY_ENTITY_ID = 'auth';
const REGISTRY_KEY = 'api_keys';
const REGISTRY_SOURCE = 'system';
const REGISTRY_CREATED_BY = 'system';
const CACHE_TTL_MS = 5000;

export interface ApiKeyRecord {
    keyId: string;
    owner: string;
    secretHash: string;
    scopes: string[];
    isActive: boolean;
    createdAt: string;
    revokedAt?: string | null;
    description?: string;
}

interface ApiKeyRegistry {
    version: number;
    keys: ApiKeyRecord[];
}

type AuthMode = 'legacy_env' | 'legacy_list' | 'registry';

export interface ApiKeyValidationResult {
    ok: boolean;
    mode?: AuthMode;
    keyId?: string;
    owner?: string;
    scopes?: string[];
    status?: 401 | 500;
    error?: string;
}

let cachedRegistry: ApiKeyRegistry | null = null;
let cacheLoadedAtMs = 0;

function sanitizeKeyId(input: string): string {
    return input.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
}

function keyPepper(): string {
    return process.env.IRANTI_API_KEY_PEPPER ?? '';
}

export function hashApiKeySecret(secret: string): string {
    return createHash('sha256').update(`${secret}${keyPepper()}`).digest('hex');
}

export function generateApiKeySecret(length: number = 32): string {
    // base64url avoids slash/plus, works well in headers and env files.
    return randomBytes(length).toString('base64url');
}

export function formatApiKeyToken(keyId: string, secret: string): string {
    return `${sanitizeKeyId(keyId)}.${secret}`;
}

export function parseApiKeyToken(token: string): { keyId: string; secret: string } | null {
    const trimmed = token.trim();
    const firstDot = trimmed.indexOf('.');
    if (firstDot <= 0 || firstDot >= trimmed.length - 1) return null;

    const keyIdRaw = trimmed.slice(0, firstDot);
    const secret = trimmed.slice(firstDot + 1);
    const keyId = sanitizeKeyId(keyIdRaw);

    if (!keyId || !secret) return null;
    return { keyId, secret };
}

function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
}

function parseLegacyList(): string[] {
    const raw = process.env.IRANTI_API_KEYS ?? '';
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

function normalizeRegistry(raw: unknown): ApiKeyRegistry {
    if (!raw || typeof raw !== 'object') {
        return { version: 1, keys: [] };
    }

    const maybe = raw as Partial<ApiKeyRegistry>;
    const keys = Array.isArray(maybe.keys) ? maybe.keys : [];
    const normalized: ApiKeyRecord[] = [];

    for (const key of keys) {
        if (!key || typeof key !== 'object') continue;
        const record = key as Partial<ApiKeyRecord>;
        if (!record.keyId || !record.secretHash || !record.owner) continue;
        normalized.push({
            keyId: sanitizeKeyId(String(record.keyId)),
            owner: String(record.owner),
            secretHash: String(record.secretHash),
            scopes: Array.isArray(record.scopes) ? record.scopes.map((s) => String(s)) : [],
            isActive: record.isActive !== false,
            createdAt: record.createdAt ? String(record.createdAt) : new Date().toISOString(),
            revokedAt: record.revokedAt ? String(record.revokedAt) : null,
            description: record.description ? String(record.description) : undefined,
        });
    }

    return {
        version: typeof maybe.version === 'number' ? maybe.version : 1,
        keys: normalized,
    };
}

export function invalidateApiKeyCache(): void {
    cachedRegistry = null;
    cacheLoadedAtMs = 0;
}

export async function loadApiKeyRegistry(forceRefresh: boolean = false): Promise<ApiKeyRegistry> {
    const now = Date.now();
    if (!forceRefresh && cachedRegistry && now - cacheLoadedAtMs < CACHE_TTL_MS) {
        return cachedRegistry;
    }

    const entry = await getDb().knowledgeEntry.findUnique({
        where: {
            entityType_entityId_key: {
                entityType: REGISTRY_ENTITY_TYPE,
                entityId: REGISTRY_ENTITY_ID,
                key: REGISTRY_KEY,
            },
        },
    });

    const registry = entry ? normalizeRegistry(entry.valueRaw) : { version: 1, keys: [] };
    cachedRegistry = registry;
    cacheLoadedAtMs = now;
    return registry;
}

export async function saveApiKeyRegistry(registry: ApiKeyRegistry): Promise<void> {
    const normalized = normalizeRegistry(registry);
    await getDb().knowledgeEntry.upsert({
        where: {
            entityType_entityId_key: {
                entityType: REGISTRY_ENTITY_TYPE,
                entityId: REGISTRY_ENTITY_ID,
                key: REGISTRY_KEY,
            },
        },
        update: {
            valueRaw: normalized as unknown as Prisma.InputJsonValue,
            valueSummary: `API key registry (${normalized.keys.length} keys)`,
            updatedAt: new Date(),
            source: REGISTRY_SOURCE,
            createdBy: REGISTRY_CREATED_BY,
            isProtected: true,
        },
        create: {
            entityType: REGISTRY_ENTITY_TYPE,
            entityId: REGISTRY_ENTITY_ID,
            key: REGISTRY_KEY,
            valueRaw: normalized as unknown as Prisma.InputJsonValue,
            valueSummary: `API key registry (${normalized.keys.length} keys)`,
            confidence: 100,
            source: REGISTRY_SOURCE,
            createdBy: REGISTRY_CREATED_BY,
            isProtected: true,
            conflictLog: [],
        },
    });
    invalidateApiKeyCache();
}

export async function createOrRotateApiKey(input: {
    keyId: string;
    owner: string;
    scopes?: string[];
    description?: string;
}): Promise<{ token: string; record: ApiKeyRecord }> {
    const keyId = sanitizeKeyId(input.keyId);
    if (!keyId) {
        throw new Error('keyId is required (letters, numbers, "_" and "-" supported).');
    }
    if (!input.owner || input.owner.trim().length === 0) {
        throw new Error('owner is required.');
    }

    const scopes = Array.isArray(input.scopes) ? input.scopes.map((s) => s.trim()).filter(Boolean) : [];
    const secret = generateApiKeySecret();
    const secretHash = hashApiKeySecret(secret);
    const now = new Date().toISOString();

    const registry = await loadApiKeyRegistry(true);
    const record: ApiKeyRecord = {
        keyId,
        owner: input.owner.trim(),
        secretHash,
        scopes,
        isActive: true,
        createdAt: now,
        revokedAt: null,
        description: input.description?.trim() || undefined,
    };

    const withoutExisting = registry.keys.filter((k) => k.keyId !== keyId);
    withoutExisting.push(record);
    await saveApiKeyRegistry({ ...registry, keys: withoutExisting });

    return {
        token: formatApiKeyToken(keyId, secret),
        record,
    };
}

export async function revokeApiKey(keyIdRaw: string): Promise<boolean> {
    const keyId = sanitizeKeyId(keyIdRaw);
    if (!keyId) throw new Error('keyId is required.');

    const registry = await loadApiKeyRegistry(true);
    const target = registry.keys.find((k) => k.keyId === keyId);
    if (!target) return false;

    target.isActive = false;
    target.revokedAt = new Date().toISOString();
    await saveApiKeyRegistry(registry);
    return true;
}

export async function listApiKeys(): Promise<ApiKeyRecord[]> {
    const registry = await loadApiKeyRegistry(true);
    return registry.keys
        .slice()
        .sort((a, b) => a.keyId.localeCompare(b.keyId));
}

export async function validateApiKey(providedKey: string | undefined): Promise<ApiKeyValidationResult> {
    const legacy = process.env.IRANTI_API_KEY?.trim();
    const legacyList = parseLegacyList();

    if (!legacy && legacyList.length === 0) {
        try {
            const registry = await loadApiKeyRegistry();
            if (registry.keys.length === 0) {
                return {
                    ok: false,
                    status: 500,
                    error: 'No API keys are configured. Set IRANTI_API_KEY or create registry keys.',
                };
            }
        } catch {
            return {
                ok: false,
                status: 500,
                error: 'API key validation failed. Check DB and key registry configuration.',
            };
        }
    }

    if (!providedKey || providedKey.trim().length === 0) {
        return {
            ok: false,
            status: 401,
            error: 'Unauthorized. Provide a valid X-Iranti-Key header.',
        };
    }

    const provided = providedKey.trim();
    if (legacy && provided === legacy) {
        return { ok: true, mode: 'legacy_env', keyId: 'legacy_env', owner: 'legacy_env', scopes: ['*'] };
    }

    if (legacyList.length > 0 && legacyList.includes(provided)) {
        return { ok: true, mode: 'legacy_list', keyId: 'legacy_list', owner: 'legacy_list', scopes: ['*'] };
    }

    const parsed = parseApiKeyToken(provided);
    if (!parsed) {
        return {
            ok: false,
            status: 401,
            error: 'Unauthorized. Provide a valid X-Iranti-Key header.',
        };
    }

    try {
        const registry = await loadApiKeyRegistry();
        const key = registry.keys.find((k) => k.keyId === parsed.keyId);
        if (!key || !key.isActive) {
            return {
                ok: false,
                status: 401,
                error: 'Unauthorized. Provide a valid X-Iranti-Key header.',
            };
        }

        const providedHash = hashApiKeySecret(parsed.secret);
        if (!safeEqual(providedHash, key.secretHash)) {
            return {
                ok: false,
                status: 401,
                error: 'Unauthorized. Provide a valid X-Iranti-Key header.',
            };
        }

        return {
            ok: true,
            mode: 'registry',
            keyId: key.keyId,
            owner: key.owner,
            scopes: key.scopes,
        };
    } catch {
        return {
            ok: false,
            status: 500,
            error: 'API key validation failed. Check DB and key registry configuration.',
        };
    }
}
