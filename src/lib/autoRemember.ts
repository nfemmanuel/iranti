type IrantiQueryClient = {
    query(entity: string, key: string): Promise<{ found: boolean; value?: unknown }>;
    write(input: {
        entity: string;
        key: string;
        value: unknown;
        summary: string;
        confidence: number;
        source: string;
        agent: string;
        properties?: Record<string, unknown>;
    }): Promise<unknown>;
};

import { getStaffEventEmitter } from './staffEventRegistry';
import { buildSemanticFactTags } from './semanticFactTags';

type DurableMemoryClass =
    | 'preference'
    | 'profile'
    | 'decision'
    | 'next_step'
    | 'blocker'
    | 'owner'
    | 'current_step'
    | 'open_risks'
    | 'artifact'
    | 'file_change'
    | 'action_log'
    | 'failed_path'
    | 'alternative_route';

type ExtractedMemoryFact = {
    scope: 'personal' | 'project';
    key: string;
    value: unknown;
    summary: string;
    durableClass: DurableMemoryClass;
};

type AutoRememberResult = {
    enabled: boolean;
    entity?: string;
    extracted: number;
    written: number;
    skipped: Array<{ key: string; reason: string }>;
};

export type MandatoryRecallDecision = {
    required: boolean;
    scope: 'personal' | 'project' | null;
    key?: string;
    reason?: string;
};

export type BackfillChatRole = 'user' | 'assistant' | 'unknown';

export type BackfillChatMessage = {
    role: BackfillChatRole;
    text: string;
};

export const USER_PROMPT_AUTO_REMEMBER_SOURCE = 'UserPromptAutoRemember';

const PERSONAL_MEMORY_KEYS = new Set([
    'name',
    'email',
    'phone',
    'address',
    'city',
    'country',
    'home_city',
    'hometown',
    'likes',
    'height',
]);

export function canonicalizeMemoryKey(text: string): string {
    return normalizeKey(text)
        .replace(/favourite/g, 'favorite')
        .replace(/colour/g, 'color');
}

function normalizeKey(text: string): string {
    return text
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function normalizePrompt(prompt: string): string {
    return prompt.trim().replace(/\s+/g, ' ');
}

function normalizeEntity(entity: string | null | undefined): string | undefined {
    const trimmed = entity?.trim();
    return trimmed && trimmed.includes('/') ? trimmed : undefined;
}

export function isPersonalEntityType(entityType: string): boolean {
    const normalized = entityType.trim().toLowerCase();
    return normalized === 'user' || normalized === 'person';
}

function isQuestionLike(prompt: string): boolean {
    const trimmed = prompt.trim();
    if (!trimmed) return false;
    if (trimmed.endsWith('?')) return true;
    return /^(what|when|where|who|why|how|do|did|does|can|could|should|would|is|are|am|was|were)\b/i.test(trimmed);
}

function buildTextFact(key: string, value: string, scope: 'personal' | 'project' = 'personal'): ExtractedMemoryFact {
    const cleanKey = canonicalizeMemoryKey(key);
    const cleanValue = value.trim();
    return {
        scope,
        key: cleanKey,
        value: { text: cleanValue },
        summary: `${cleanKey.replace(/_/g, ' ')} is ${cleanValue}`,
        durableClass: cleanKey.startsWith('favorite_') ? 'preference' : 'profile',
    };
}

function dedupeStrings(values: string[]): string[] {
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed) continue;
        const normalized = trimmed.toLowerCase();
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        deduped.push(trimmed);
    }
    return deduped;
}

function dedupeObjects<T>(values: T[]): T[] {
    const seen = new Set<string>();
    const deduped: T[] = [];
    for (const value of values) {
        const identity = JSON.stringify(value);
        if (seen.has(identity)) continue;
        seen.add(identity);
        deduped.push(value);
    }
    return deduped;
}

function normalizeListItems(raw: string): string[] {
    return raw
        .split(/(?:,|;|\band\b)/i)
        .map((item) => item.trim())
        .filter(Boolean);
}

function trimSummary(text: string, max = 220): string {
    const normalized = text.trim();
    if (normalized.length <= max) return normalized;
    return `${normalized.slice(0, max - 3).trimEnd()}...`;
}

function readStringArray(value: unknown, preferredKey: string): string[] {
    if (Array.isArray(value)) {
        return value.map((item) => String(item ?? '').trim()).filter(Boolean);
    }
    if (typeof value !== 'object' || value === null) return [];
    const record = value as Record<string, unknown>;
    const direct = record[preferredKey];
    if (Array.isArray(direct)) {
        return direct.map((item) => String(item ?? '').trim()).filter(Boolean);
    }
    if (Array.isArray(record.items)) {
        return record.items.map((item) => String(item ?? '').trim()).filter(Boolean);
    }
    return [];
}

function readFileChangeItems(value: unknown): Array<Record<string, unknown>> {
    if (typeof value !== 'object' || value === null) return [];
    const record = value as Record<string, unknown>;
    const items = Array.isArray(record.items) ? record.items : [];
    return items.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null);
}

function readActionItems(value: unknown): Array<Record<string, unknown>> {
    if (typeof value !== 'object' || value === null) return [];
    const record = value as Record<string, unknown>;
    const items = Array.isArray(record.items) ? record.items : [];
    return items.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null);
}

function mergeFactValue(key: string, existing: unknown, incoming: unknown): unknown {
    if (key === 'open_risks') {
        return { items: dedupeStrings([...readStringArray(existing, 'items'), ...readStringArray(incoming, 'items')]) };
    }
    if (key === 'important_artifacts') {
        return { items: dedupeStrings([...readStringArray(existing, 'items'), ...readStringArray(incoming, 'items'), ...readStringArray(existing, 'files'), ...readStringArray(incoming, 'files')]) };
    }
    if (key === 'failed_paths' || key === 'alternative_routes') {
        return { items: dedupeStrings([...readStringArray(existing, 'items'), ...readStringArray(incoming, 'items')]) };
    }
    if (key === 'recent_file_changes') {
        return { items: dedupeObjects([...readFileChangeItems(existing), ...readFileChangeItems(incoming)]) };
    }
    if (key === 'recent_actions') {
        return { items: dedupeObjects([...readActionItems(existing), ...readActionItems(incoming)]) };
    }
    return incoming;
}

function summarizeMergedFact(key: string, value: unknown, fallback: string): string {
    if (key === 'open_risks') {
        const items = readStringArray(value, 'items');
        return items.length > 0 ? trimSummary(`open risks include ${items.join('; ')}`) : fallback;
    }
    if (key === 'important_artifacts') {
        const items = readStringArray(value, 'items');
        return items.length > 0 ? trimSummary(`important artifacts include ${items.join('; ')}`) : fallback;
    }
    if (key === 'failed_paths') {
        const items = readStringArray(value, 'items');
        return items.length > 0 ? trimSummary(`failed paths include ${items.join('; ')}`) : fallback;
    }
    if (key === 'alternative_routes') {
        const items = readStringArray(value, 'items');
        return items.length > 0 ? trimSummary(`alternative routes include ${items.join('; ')}`) : fallback;
    }
    if (key === 'recent_file_changes') {
        const items = readFileChangeItems(value).map((item) => {
            const action = String(item.action ?? 'updated').trim();
            const path = String(item.path ?? '').trim();
            const toPath = String(item.toPath ?? '').trim();
            const purpose = String(item.purpose ?? '').trim();
            if (!path) return '';
            if (toPath) return `${action} ${path} -> ${toPath}${purpose ? ` (${purpose})` : ''}`;
            return `${action} ${path}${purpose ? ` (${purpose})` : ''}`;
        }).filter(Boolean);
        return items.length > 0 ? trimSummary(`recent file changes include ${items.join('; ')}`) : fallback;
    }
    if (key === 'recent_actions') {
        const items = readActionItems(value).map((item) => {
            const kind = String(item.kind ?? 'action').trim();
            const summary = String(item.summary ?? '').trim();
            const status = String(item.status ?? '').trim();
            if (!summary) return '';
            return status ? `[${status}] ${kind}: ${summary}` : `${kind}: ${summary}`;
        }).filter(Boolean);
        return items.length > 0 ? trimSummary(`recent actions include ${items.join('; ')}`) : fallback;
    }
    return fallback;
}

function buildFactProperties(fact: ExtractedMemoryFact, phase: 'user_prompt' | 'assistant_response' | 'backfill'): Record<string, unknown> {
    const mergeStrategy = ['open_risks', 'important_artifacts', 'recent_file_changes', 'recent_actions', 'failed_paths', 'alternative_routes'].includes(fact.key)
        ? 'append_dedupe'
        : 'replace';
    return {
        memoryScope: fact.scope,
        capturePhase: phase,
        durableClass: fact.durableClass,
        canonicalKey: fact.key,
        mergeStrategy,
        ...buildSemanticFactTags({
            memoryScope: fact.scope,
            durableClass: fact.durableClass,
            mergeStrategy,
        }),
    };
}

function extractProjectOperationalFacts(text: string): ExtractedMemoryFact[] {
    const facts: ExtractedMemoryFact[] = [];

    const decisionMatch = text.match(/^we decided(?: that)? (.+)$/i);
    if (decisionMatch) {
        facts.push({
            scope: 'project',
            key: 'decision',
            value: { text: decisionMatch[1].trim() },
            summary: `decision is ${decisionMatch[1].trim()}`,
            durableClass: 'decision',
        });
    }

    const nextStepMatch = text.match(/^(?:the )?next step is (.+)$/i);
    if (nextStepMatch) {
        facts.push({
            scope: 'project',
            key: 'next_step',
            value: { instruction: nextStepMatch[1].trim() },
            summary: `next step is ${nextStepMatch[1].trim()}`,
            durableClass: 'next_step',
        });
    }

    const currentStepMatch = text.match(/^(?:the )?current step is (.+)$/i);
    if (currentStepMatch) {
        facts.push({
            scope: 'project',
            key: 'current_step',
            value: { text: currentStepMatch[1].trim() },
            summary: `current step is ${currentStepMatch[1].trim()}`,
            durableClass: 'current_step',
        });
    }

    const blockerMatch = text.match(/^(?:the )?blocker is (.+)$/i);
    if (blockerMatch) {
        facts.push({
            scope: 'project',
            key: 'blocker',
            value: { text: blockerMatch[1].trim() },
            summary: `blocker is ${blockerMatch[1].trim()}`,
            durableClass: 'blocker',
        });
    }

    const ownerMatch = text.match(/^(?:the )?current owner is (.+)$/i);
    if (ownerMatch) {
        facts.push({
            scope: 'project',
            key: 'current_owner',
            value: { text: ownerMatch[1].trim() },
            summary: `current owner is ${ownerMatch[1].trim()}`,
            durableClass: 'owner',
        });
    }

    const openRisksMatch = text.match(/^(?:the )?(?:open risks?|risks?) (?:are|include) (.+)$/i);
    if (openRisksMatch) {
        const items = dedupeStrings(normalizeListItems(openRisksMatch[1]));
        if (items.length > 0) {
            facts.push({
                scope: 'project',
                key: 'open_risks',
                value: { items },
                summary: trimSummary(`open risks include ${items.join('; ')}`),
                durableClass: 'open_risks',
            });
        }
    }

    const artifactsMatch = text.match(/^(?:important )?artifacts? (?:are|include) (.+)$/i);
    if (artifactsMatch) {
        const items = dedupeStrings(normalizeListItems(artifactsMatch[1]));
        if (items.length > 0) {
            facts.push({
                scope: 'project',
                key: 'important_artifacts',
                value: { items },
                summary: trimSummary(`important artifacts include ${items.join('; ')}`),
                durableClass: 'artifact',
            });
        }
    }

    const failedPathMatch = text.match(/^(?:the )?failed path (?:is|was) (.+)$/i);
    if (failedPathMatch) {
        const items = dedupeStrings(normalizeListItems(failedPathMatch[1]));
        if (items.length > 0) {
            facts.push({
                scope: 'project',
                key: 'failed_paths',
                value: { items },
                summary: trimSummary(`failed paths include ${items.join('; ')}`),
                durableClass: 'failed_path',
            });
        }
    }

    const alternativeRouteMatch = text.match(/^(?:the )?alternative route (?:is|was) (.+)$/i);
    if (alternativeRouteMatch) {
        const items = dedupeStrings(normalizeListItems(alternativeRouteMatch[1]));
        if (items.length > 0) {
            facts.push({
                scope: 'project',
                key: 'alternative_routes',
                value: { items },
                summary: trimSummary(`alternative routes include ${items.join('; ')}`),
                durableClass: 'alternative_route',
            });
        }
    }

    const createdFileMatch = text.match(/^file created (\S+)(?: for (.+))?$/i);
    if (createdFileMatch) {
        facts.push({
            scope: 'project',
            key: 'recent_file_changes',
            value: { items: [{ action: 'created', path: createdFileMatch[1].trim(), purpose: createdFileMatch[2]?.trim() || undefined }] },
            summary: trimSummary(`recent file changes include created ${createdFileMatch[1].trim()}${createdFileMatch[2]?.trim() ? ` (${createdFileMatch[2].trim()})` : ''}`),
            durableClass: 'file_change',
        });
    }

    const movedFileMatch = text.match(/^file moved (\S+) to (\S+)(?: for (.+))?$/i);
    if (movedFileMatch) {
        facts.push({
            scope: 'project',
            key: 'recent_file_changes',
            value: { items: [{ action: 'moved', path: movedFileMatch[1].trim(), toPath: movedFileMatch[2].trim(), purpose: movedFileMatch[3]?.trim() || undefined }] },
            summary: trimSummary(`recent file changes include moved ${movedFileMatch[1].trim()} to ${movedFileMatch[2].trim()}${movedFileMatch[3]?.trim() ? ` (${movedFileMatch[3].trim()})` : ''}`),
            durableClass: 'file_change',
        });
    }

    const renamedFileMatch = text.match(/^file renamed (\S+) to (\S+)(?: for (.+))?$/i);
    if (renamedFileMatch) {
        facts.push({
            scope: 'project',
            key: 'recent_file_changes',
            value: { items: [{ action: 'renamed', path: renamedFileMatch[1].trim(), toPath: renamedFileMatch[2].trim(), purpose: renamedFileMatch[3]?.trim() || undefined }] },
            summary: trimSummary(`recent file changes include renamed ${renamedFileMatch[1].trim()} to ${renamedFileMatch[2].trim()}${renamedFileMatch[3]?.trim() ? ` (${renamedFileMatch[3].trim()})` : ''}`),
            durableClass: 'file_change',
        });
    }

    const deletedFileMatch = text.match(/^file deleted (\S+)(?: because (.+))?$/i);
    if (deletedFileMatch) {
        facts.push({
            scope: 'project',
            key: 'recent_file_changes',
            value: { items: [{ action: 'deleted', path: deletedFileMatch[1].trim(), purpose: deletedFileMatch[2]?.trim() || undefined }] },
            summary: trimSummary(`recent file changes include deleted ${deletedFileMatch[1].trim()}${deletedFileMatch[2]?.trim() ? ` (${deletedFileMatch[2].trim()})` : ''}`),
            durableClass: 'file_change',
        });
    }

    const commandRanMatch = text.match(/^command ran (.+)$/i);
    if (commandRanMatch) {
        const target = commandRanMatch[1].trim();
        facts.push({
            scope: 'project',
            key: 'recent_actions',
            value: { items: [{ kind: 'command', summary: `ran ${target}`, status: 'completed', target }] },
            summary: trimSummary(`recent actions include [completed] command: ran ${target}`),
            durableClass: 'action_log',
        });
    }

    const commandFailedMatch = text.match(/^command failed (.+)$/i);
    if (commandFailedMatch) {
        const target = commandFailedMatch[1].trim();
        facts.push({
            scope: 'project',
            key: 'recent_actions',
            value: { items: [{ kind: 'command', summary: `failed ${target}`, status: 'failed', target }] },
            summary: trimSummary(`recent actions include [failed] command: failed ${target}`),
            durableClass: 'action_log',
        });
    }

    const testPassedMatch = text.match(/^test passed (.+)$/i);
    if (testPassedMatch) {
        const target = testPassedMatch[1].trim();
        facts.push({
            scope: 'project',
            key: 'recent_actions',
            value: { items: [{ kind: 'test', summary: `passed ${target}`, status: 'passed', target }] },
            summary: trimSummary(`recent actions include [passed] test: passed ${target}`),
            durableClass: 'action_log',
        });
    }

    const testFailedMatch = text.match(/^test failed (.+)$/i);
    if (testFailedMatch) {
        const target = testFailedMatch[1].trim();
        facts.push({
            scope: 'project',
            key: 'recent_actions',
            value: { items: [{ kind: 'test', summary: `failed ${target}`, status: 'failed', target }] },
            summary: trimSummary(`recent actions include [failed] test: failed ${target}`),
            durableClass: 'action_log',
        });
    }

    const validationPassedMatch = text.match(/^validation passed (.+)$/i);
    if (validationPassedMatch) {
        const target = validationPassedMatch[1].trim();
        facts.push({
            scope: 'project',
            key: 'recent_actions',
            value: { items: [{ kind: 'validation', summary: `passed ${target}`, status: 'passed', target }] },
            summary: trimSummary(`recent actions include [passed] validation: passed ${target}`),
            durableClass: 'action_log',
        });
    }

    const validationFailedMatch = text.match(/^validation failed (.+)$/i);
    if (validationFailedMatch) {
        const target = validationFailedMatch[1].trim();
        facts.push({
            scope: 'project',
            key: 'recent_actions',
            value: { items: [{ kind: 'validation', summary: `failed ${target}`, status: 'failed', target }] },
            summary: trimSummary(`recent actions include [failed] validation: failed ${target}`),
            durableClass: 'action_log',
        });
    }

    const searchRanMatch = text.match(/^search ran (.+)$/i);
    if (searchRanMatch) {
        const target = searchRanMatch[1].trim();
        facts.push({
            scope: 'project',
            key: 'recent_actions',
            value: { items: [{ kind: 'search', summary: `ran ${target}`, status: 'completed', target }] },
            summary: trimSummary(`recent actions include [completed] search: ran ${target}`),
            durableClass: 'action_log',
        });
    }

    return facts;
}

export function isAutoRememberEnabled(): boolean {
    const raw = process.env.IRANTI_AUTO_REMEMBER?.trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function stripDeclarativeLeadIns(text: string): string {
    let value = text.trim();
    const patterns = [
        /^(?:hey|hi|hello|yo)\s*,?\s*/i,
        /^(?:so|okay|ok|alright|well|right|btw|by the way)\s*,?\s*/i,
        /^(?:actually|correction:|correction|for the record)\s*,?\s*/i,
    ];

    let changed = true;
    while (changed) {
        changed = false;
        for (const pattern of patterns) {
            const next = value.replace(pattern, '');
            if (next !== value) {
                value = next.trim();
                changed = true;
            }
        }
    }

    return value;
}

export function getPersonalMemoryEntity(explicit?: string | null): string {
    return normalizeEntity(explicit)
        ?? normalizeEntity(process.env.IRANTI_PERSONAL_MEMORY_ENTITY)
        ?? 'user/main';
}

export function getPersonalRecallEntities(explicit?: string | null): string[] {
    const canonical = getPersonalMemoryEntity(explicit);
    const entities = new Set<string>([canonical]);

    const [entityType, entityId] = canonical.split('/', 2);
    if (!entityType || !entityId || !isPersonalEntityType(entityType)) {
        return Array.from(entities);
    }

    if ((entityType === 'user' && entityId === 'main') || (entityType === 'person' && entityId === 'user')) {
        entities.add('user/main');
        entities.add('person/user');
        return Array.from(entities);
    }

    entities.add(`${entityType === 'user' ? 'person' : 'user'}/${entityId}`);
    return Array.from(entities);
}

export function getProjectMemoryEntity(explicit?: string | null): string | undefined {
    return normalizeEntity(explicit)
        ?? normalizeEntity(process.env.IRANTI_MEMORY_ENTITY);
}

export function resolvePersonalWriteTarget(params: {
    entity: string;
    key: string;
    personalEntity?: string | null;
}): {
    entity: string;
    rerouted: boolean;
    originalEntity?: string;
} {
    const requested = normalizeEntity(params.entity) ?? params.entity.trim();
    const canonicalPersonalEntity = getPersonalMemoryEntity(params.personalEntity);
    const normalizedKey = canonicalizeMemoryKey(params.key);

    if (!requested.includes('/') || !canonicalPersonalEntity.includes('/')) {
        return { entity: requested, rerouted: false };
    }

    const [requestedType] = requested.split('/', 1);
    const [canonicalType] = canonicalPersonalEntity.split('/', 1);
    if (!isPersonalMemoryKey(normalizedKey) || !isPersonalEntityType(requestedType) || !isPersonalEntityType(canonicalType)) {
        return { entity: requested, rerouted: false };
    }

    if (requested === canonicalPersonalEntity) {
        return { entity: requested, rerouted: false };
    }

    return {
        entity: canonicalPersonalEntity,
        rerouted: true,
        originalEntity: requested,
    };
}

export function classifyMemoryScope(message: string): 'personal' | 'project' | null {
    const normalized = normalizePrompt(message).toLowerCase();
    if (!normalized) return null;

    if (/\b(next step|current step|blocker|decision|current owner|open risks?|artifacts?|failed path|alternative route|file (?:created|moved|renamed|deleted))\b/.test(normalized)) {
        return 'project';
    }
    // Only classify as personal when the message explicitly asks about personal profile data.
    // Generic first-person pronouns ("I'm trying", "let me check") should NOT trigger personal scope.
    if (
        /\bwhat(?:'s| is| was)?\s+my\b/.test(normalized) ||
        /\bwho\s+am\s+i\b/.test(normalized) ||
        /\bwhat\s+(?:do\s+you\s+)?(?:know|remember)\s+about\s+me\b/.test(normalized) ||
        /\b(?:remember|forget)\s+(?:that\s+)?(?:my|i)\b/.test(normalized) ||
        /\bmy\s+(?:name|email|phone|address|city|country|home|height|favou?rite|prefer\w*)\b/.test(normalized)
    ) {
        return 'personal';
    }
    if (/\b(our|we)\b/.test(normalized)) {
        return 'project';
    }
    return null;
}

export function isPersonalMemoryKey(key: string): boolean {
    const normalized = canonicalizeMemoryKey(key);
    return normalized.startsWith('favorite_') || PERSONAL_MEMORY_KEYS.has(normalized);
}

export function detectMandatoryRecall(message: string): MandatoryRecallDecision {
    const normalized = normalizePrompt(message).toLowerCase();
    if (!normalized || normalized.startsWith('/')) {
        return { required: false, scope: null };
    }

    const favoriteMatch = normalized.match(/\bwhat(?:'s| is| was)?\s+my\s+favou?rite\s+([a-z0-9_\-\s]+)\b/i);
    if (favoriteMatch) {
        return {
            required: true,
            scope: 'personal',
            key: canonicalizeMemoryKey(`favorite_${favoriteMatch[1]}`),
            reason: 'favorite_recall_prompt',
        };
    }

    const myFieldMatch = normalized.match(/\bwhat(?:'s| is| was)?\s+my\s+([a-z0-9_\-\s]+)\b/i);
    if (myFieldMatch) {
        return {
            required: true,
            scope: 'personal',
            key: canonicalizeMemoryKey(myFieldMatch[1]),
            reason: 'personal_recall_prompt',
        };
    }

    if (/\bhow tall am i\b/i.test(normalized) || /\bwhat(?:'s| is)? my height\b/i.test(normalized)) {
        return {
            required: true,
            scope: 'personal',
            key: 'height',
            reason: 'personal_height_recall_prompt',
        };
    }

    if (/\b(?:what|remind me)(?:[^.?!]*)\bnext step\b/i.test(normalized)) {
        return {
            required: true,
            scope: 'project',
            key: 'next_step',
            reason: 'project_next_step_recall',
        };
    }

    if (/\b(?:what|remind me)(?:[^.?!]*)\bblocker\b/i.test(normalized)) {
        return {
            required: true,
            scope: 'project',
            key: 'blocker',
            reason: 'project_blocker_recall',
        };
    }

    if (/\bwhat did we decide\b/i.test(normalized) || /\b(?:what|remind me)(?:[^.?!]*)\bdecision\b/i.test(normalized)) {
        return {
            required: true,
            scope: 'project',
            key: 'decision',
            reason: 'project_decision_recall',
        };
    }

    if (/\b(?:who(?:'s| is)?\s+(?:the|our)\s+current owner|who owns (?:this|that|it))\b/i.test(normalized)) {
        return {
            required: true,
            scope: 'project',
            key: 'current_owner',
            reason: 'project_owner_recall',
        };
    }

    if (/\b(?:what|remind me)(?:[^.?!]*)\bcurrent step\b/i.test(normalized)) {
        return {
            required: true,
            scope: 'project',
            key: 'current_step',
            reason: 'project_current_step_recall',
        };
    }

    if (/\b(?:what|which|remind me)(?:[^.?!]*)\bopen risks?\b/i.test(normalized)) {
        return {
            required: true,
            scope: 'project',
            key: 'open_risks',
            reason: 'project_open_risks_recall',
        };
    }

    if (/\b(?:what|which|remind me)(?:[^.?!]*)\b(?:important )?artifacts?\b/i.test(normalized)) {
        return {
            required: true,
            scope: 'project',
            key: 'important_artifacts',
            reason: 'project_artifacts_recall',
        };
    }

    return { required: false, scope: null };
}

export function extractExplicitPromptMemory(prompt: string): ExtractedMemoryFact[] {
    const raw = normalizePrompt(prompt);
    if (!raw || raw.startsWith('/')) return [];
    if (isQuestionLike(raw)) return [];

    const lower = raw.toLowerCase();
    const stripped = stripDeclarativeLeadIns(lower);

    const facts: ExtractedMemoryFact[] = [];

    const favoriteMatch = stripped.match(/^my favou?rite ([a-z0-9_\-\s]+?) is (.+)$/i);
    if (favoriteMatch) {
        facts.push(buildTextFact(`favorite_${favoriteMatch[1]}`, favoriteMatch[2]));
    }

    const myFieldMatch = stripped.match(/^my ([a-z0-9_\-\s]+?) is (.+)$/i);
    if (myFieldMatch && !facts.some((fact) => {
        const fieldKey = canonicalizeMemoryKey(myFieldMatch[1]);
        return fact.key === fieldKey || fact.key === canonicalizeMemoryKey(`favorite_${myFieldMatch[1]}`);
    })) {
        facts.push(buildTextFact(myFieldMatch[1], myFieldMatch[2]));
    }

    const homeCityMatch = stripped.match(/^i live in (.+)$/i);
    if (homeCityMatch) {
        facts.push(buildTextFact('home_city', homeCityMatch[1]));
    }

    const hometownMatch = stripped.match(/^i(?:'m| am) from (.+)$/i);
    if (hometownMatch) {
        facts.push(buildTextFact('hometown', hometownMatch[1]));
    }

    const preferenceMatch = stripped.match(/^i (?:like|love|prefer) (.+)$/i);
    if (preferenceMatch) {
        facts.push(buildTextFact('likes', preferenceMatch[1]));
    }

    facts.push(...extractProjectOperationalFacts(stripped));

    const deduped = new Map<string, ExtractedMemoryFact>();
    for (const fact of facts) {
        if (!fact.key || fact.summary.length > 220) continue;
        deduped.set(fact.key, fact);
    }

    return Array.from(deduped.values());
}

export function extractExplicitAssistantMemory(response: string): ExtractedMemoryFact[] {
    const raw = normalizePrompt(response);
    if (!raw) return [];

    const lower = raw.toLowerCase();
    const facts: ExtractedMemoryFact[] = [];

    const yourFavoriteMatch = lower.match(/^your favou?rite ([a-z0-9_\-\s]+?) is (.+)$/i);
    if (yourFavoriteMatch) {
        facts.push(buildTextFact(`favorite_${yourFavoriteMatch[1]}`, yourFavoriteMatch[2]));
    }

    const yourFieldMatch = lower.match(/^your ([a-z0-9_\-\s]+?) is (.+)$/i);
    if (yourFieldMatch && !facts.some((fact) => {
        const fieldKey = canonicalizeMemoryKey(yourFieldMatch[1]);
        return fact.key === fieldKey || fact.key === canonicalizeMemoryKey(`favorite_${yourFieldMatch[1]}`);
    })) {
        facts.push(buildTextFact(yourFieldMatch[1], yourFieldMatch[2]));
    }

    facts.push(...extractProjectOperationalFacts(lower));

    const deduped = new Map<string, ExtractedMemoryFact>();
    for (const fact of facts) {
        if (!fact.key || fact.summary.length > 220) continue;
        deduped.set(fact.key, fact);
    }

    return Array.from(deduped.values());
}

const ARTIFACT_MIN_LENGTH = 200;
const ARTIFACT_MAX_PER_RESPONSE = 3;

function looksLikeFrontmatter(content: string): boolean {
    const firstNonEmpty = content.split('\n').find((line) => line.trim().length > 0);
    if (!firstNonEmpty) return false;
    return /^[a-zA-Z_][a-zA-Z0-9_]*\s*:/.test(firstNonEmpty.trim());
}

function extractArtifactTitle(content: string): string {
    const firstLine = content.split('\n').find((line) => line.trim().length > 0) ?? '';
    return firstLine.replace(/^[#*]+\s*/, '').replace(/\*+$/g, '').replace(/\*+/g, '').trim();
}

export function extractResponseArtifacts(response: string): ExtractedMemoryFact[] {
    if (!response || response.length < ARTIFACT_MIN_LENGTH) return [];

    const facts: ExtractedMemoryFact[] = [];
    const blockPattern = /(?:^|\n)---\s*\n([\s\S]+?)\n---\s*(?:\n|$)/g;
    let match: RegExpExecArray | null;

    while ((match = blockPattern.exec(response)) !== null) {
        if (facts.length >= ARTIFACT_MAX_PER_RESPONSE) break;

        const content = match[1].trim();
        if (content.length < ARTIFACT_MIN_LENGTH) continue;
        if (looksLikeFrontmatter(content)) continue;

        const title = extractArtifactTitle(content);
        if (!title) continue;

        const key = `generated_${canonicalizeMemoryKey(title.slice(0, 60))}`;

        facts.push({
            scope: 'project',
            key,
            value: { content, generatedAt: new Date().toISOString() },
            summary: trimSummary(`Generated content: ${title}`),
            durableClass: 'artifact',
        });
    }

    return facts;
}

function comparableValue(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

async function persistExtractedFacts(params: {
    iranti: IrantiQueryClient;
    facts: ExtractedMemoryFact[];
    agent: string;
    source: string;
    phase: 'user_prompt' | 'assistant_response' | 'backfill';
    confidence: number;
    entity?: string | null;
    projectEntity?: string | null;
    personalEntity?: string | null;
    ledgerContext?: {
        source?: string;
        host?: string | null;
    };
}): Promise<AutoRememberResult> {
    const {
        iranti,
        facts,
        agent,
        source,
        phase,
        confidence,
        entity,
        projectEntity,
        personalEntity,
        ledgerContext,
    } = params;

    const skipped: Array<{ key: string; reason: string }> = [];
    let written = 0;
    const writtenEntities = new Set<string>();

    for (const fact of facts) {
        const targetEntity = fact.scope === 'personal'
            ? getPersonalMemoryEntity(personalEntity)
            : getProjectMemoryEntity(projectEntity ?? entity);
        if (!targetEntity) {
            skipped.push({ key: fact.key, reason: 'missing_entity' });
            continue;
        }

        const existing: { found: boolean; value?: unknown } = await iranti.query(targetEntity, fact.key).catch(() => ({ found: false }));
        const mergedValue = existing.found ? mergeFactValue(fact.key, existing.value, fact.value) : fact.value;
        const mergedSummary = summarizeMergedFact(fact.key, mergedValue, fact.summary);

        if (existing.found && comparableValue(existing.value) === comparableValue(mergedValue)) {
            skipped.push({ key: fact.key, reason: 'unchanged' });
            continue;
        }

        const writeSource = phase === 'user_prompt' && fact.scope === 'personal'
            ? USER_PROMPT_AUTO_REMEMBER_SOURCE
            : source;

        await iranti.write({
            entity: targetEntity,
            key: fact.key,
            value: mergedValue,
            summary: mergedSummary,
            confidence,
            source: writeSource,
            agent,
            properties: buildFactProperties(fact, phase),
        });
        if (phase === 'assistant_response') {
            getStaffEventEmitter().emit({
                staffComponent: 'Attendant',
                actionType: 'summary_written',
                agentId: agent,
                source: ledgerContext?.source?.trim() || source,
                entityType: targetEntity.split('/', 2)[0],
                entityId: targetEntity.split('/', 2)[1],
                key: fact.key,
                reason: 'strict_assistant_summary_persisted',
                level: 'audit',
                metadata: {
                    memoryScope: fact.scope,
                    durableClass: fact.durableClass,
                    capturePhase: phase,
                    ...(ledgerContext?.host ? { host: ledgerContext.host } : {}),
                },
            });
        }
        written += 1;
        writtenEntities.add(targetEntity);
    }

    return {
        enabled: true,
        entity: writtenEntities.size === 1 ? Array.from(writtenEntities)[0] : undefined,
        extracted: facts.length,
        written,
        skipped,
    };
}

export async function autoRememberPromptFacts(params: {
    iranti: IrantiQueryClient;
    prompt: string;
    agent: string;
    source: string;
    entity?: string | null;
    projectEntity?: string | null;
    personalEntity?: string | null;
    confidence?: number;
    ledgerContext?: {
        source?: string;
        host?: string | null;
    };
}): Promise<AutoRememberResult> {
    const {
        iranti,
        prompt,
        agent,
        source,
        entity,
        projectEntity,
        personalEntity,
        confidence = 96,
        ledgerContext,
    } = params;

    if (!isAutoRememberEnabled()) {
        return {
            enabled: false,
            extracted: 0,
            written: 0,
            skipped: [],
        };
    }

    const facts = extractExplicitPromptMemory(prompt);
    return persistExtractedFacts({
        iranti,
        facts,
        agent,
        source,
        phase: 'user_prompt',
        confidence,
        entity,
        projectEntity,
        personalEntity,
        ledgerContext,
    });
}

export async function autoRememberAssistantFacts(params: {
    iranti: IrantiQueryClient;
    response: string;
    agent: string;
    source: string;
    entity?: string | null;
    projectEntity?: string | null;
    personalEntity?: string | null;
    confidence?: number;
    ledgerContext?: {
        source?: string;
        host?: string | null;
    };
}): Promise<AutoRememberResult> {
    const {
        iranti,
        response,
        agent,
        source,
        entity,
        projectEntity,
        personalEntity,
        confidence = 90,
        ledgerContext,
    } = params;

    if (!isAutoRememberEnabled()) {
        return {
            enabled: false,
            extracted: 0,
            written: 0,
            skipped: [],
        };
    }

    const facts = extractExplicitAssistantMemory(response);
    return persistExtractedFacts({
        iranti,
        facts,
        agent,
        source,
        phase: 'assistant_response',
        confidence,
        entity,
        projectEntity,
        personalEntity,
        ledgerContext,
    });
}

export async function rememberAssistantResponseFacts(params: {
    iranti: IrantiQueryClient;
    response: string;
    agent: string;
    source: string;
    entity?: string | null;
    projectEntity?: string | null;
    personalEntity?: string | null;
    confidence?: number;
    ledgerContext?: {
        source?: string;
        host?: string | null;
    };
}): Promise<AutoRememberResult> {
    const {
        iranti,
        response,
        agent,
        source,
        entity,
        projectEntity,
        personalEntity,
        confidence = 90,
        ledgerContext,
    } = params;

    const facts = [
        ...extractExplicitAssistantMemory(response),
        ...extractResponseArtifacts(response),
    ];

    return persistExtractedFacts({
        iranti,
        facts,
        agent,
        source,
        phase: 'assistant_response',
        confidence,
        entity,
        projectEntity,
        personalEntity,
        ledgerContext,
    });
}

export function parseBackfillChatTranscript(content: string): BackfillChatMessage[] {
    const normalized = content.replace(/\r\n/g, '\n');
    const jsonlMessages = parseJsonlBackfillMessages(normalized);
    if (jsonlMessages.length > 0) {
        return jsonlMessages;
    }
    const lines = normalized.split('\n');
    const messages: BackfillChatMessage[] = [];
    let current: BackfillChatMessage | null = null;

    const flush = (): void => {
        if (!current) return;
        const text = current.text.trim();
        if (text) {
            messages.push({
                role: current.role,
                text,
            });
        }
        current = null;
    };

    const detectRole = (line: string): BackfillChatMessage | null => {
        const match = line.match(/^\s*(user|human|assistant|claude|codex|system)\s*:\s*(.*)$/i);
        if (!match) return null;
        const label = (match[1] ?? '').toLowerCase();
        const text = (match[2] ?? '').trim();
        if (label === 'user' || label === 'human') {
            return { role: 'user', text };
        }
        if (label === 'assistant' || label === 'claude' || label === 'codex') {
            return { role: 'assistant', text };
        }
        return { role: 'unknown', text };
    };

    for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        const detected = detectRole(line);
        if (detected) {
            flush();
            current = detected;
            continue;
        }

        if (!current) {
            if (!line.trim()) continue;
            current = {
                role: 'unknown',
                text: line,
            };
            continue;
        }

        if (!line.trim()) {
            flush();
            continue;
        }

        current.text = `${current.text}\n${line}`;
    }

    flush();
    return messages;
}

function parseJsonlBackfillMessages(content: string): BackfillChatMessage[] {
    const messages: BackfillChatMessage[] = [];
    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line.startsWith('{')) continue;
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const message = parseJsonlBackfillMessage(parsed);
            if (message) {
                messages.push(message);
            }
        } catch {
            return [];
        }
    }
    return messages;
}

function parseJsonlBackfillMessage(record: Record<string, unknown>): BackfillChatMessage | null {
    const directCodexText = typeof record.text === 'string' ? record.text.trim() : '';
    if (directCodexText) {
        return {
            role: 'user',
            text: directCodexText,
        };
    }

    if (record.type !== 'user' && record.type !== 'assistant') {
        return null;
    }

    const message = isRecord(record.message) ? record.message : null;
    const role = record.type === 'assistant' ? 'assistant' : 'user';
    const text = extractJsonlMessageText(message, role);
    if (!text) {
        return null;
    }

    return {
        role,
        text,
    };
}

function extractJsonlMessageText(message: Record<string, unknown> | null, fallbackRole: 'user' | 'assistant'): string {
    if (!message) return '';
    const role = typeof message.role === 'string' ? message.role : fallbackRole;
    const content = message.content;
    if (typeof content === 'string') {
        return content.trim();
    }
    if (!Array.isArray(content)) {
        return '';
    }

    const parts: string[] = [];
    for (const item of content) {
        if (!isRecord(item)) continue;
        const type = typeof item.type === 'string' ? item.type : '';
        if (type === 'text' && typeof item.text === 'string') {
            parts.push(item.text.trim());
        }
    }
    return parts.filter(Boolean).join('\n').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export async function backfillChatHistory(params: {
    iranti: IrantiQueryClient;
    content: string;
    agent: string;
    source: string;
    entity?: string | null;
    projectEntity?: string | null;
    personalEntity?: string | null;
    confidence?: number;
}): Promise<AutoRememberResult & { messagesParsed: number }> {
    const {
        iranti,
        content,
        agent,
        source,
        entity,
        projectEntity,
        personalEntity,
        confidence = 94,
    } = params;

    const messages = parseBackfillChatTranscript(content);
    const facts: ExtractedMemoryFact[] = [];
    for (const message of messages) {
        if (message.role === 'user') {
            facts.push(...extractExplicitPromptMemory(message.text));
            continue;
        }
        if (message.role === 'assistant') {
            facts.push(...extractExplicitAssistantMemory(message.text));
            continue;
        }
        facts.push(...extractExplicitPromptMemory(message.text));
        facts.push(...extractExplicitAssistantMemory(message.text));
    }

    const result = await persistExtractedFacts({
        iranti,
        facts,
        agent,
        source,
        phase: 'backfill',
        confidence,
        entity,
        projectEntity,
        personalEntity,
    });

    return {
        ...result,
        messagesParsed: messages.length,
    };
}
