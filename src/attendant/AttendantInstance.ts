import { route } from '../lib/router';
import { queryEntry, findEntriesByEntity } from '../library/queries';
import { getRelatedDeep } from '../library/relationships';
import { parseEntityString, resolveEntity } from '../library/entity-resolution';
import { getDb } from '../library/client';
import { Prisma } from '../generated/prisma/client';
import { EntryQuery, QueryResult } from '../types';
import { timeStart, timeEnd } from '../lib/metrics';
import { getConflictPolicy } from '../librarian/getPolicy';

// ─── Constants ───────────────────────────────────────────────────────────────

const ATTENDANT_RULES_QUERY: EntryQuery = {
    entityType: 'system',
    entityId: 'attendant',
    key: 'operating_rules',
};
const CONTEXT_RECOVERY_THRESHOLD = 20;  // LLM calls before context recovery
const ENTITY_DETECTION_WINDOW_CHARS = 1500;
const MIN_ENTITY_CONFIDENCE = 0.75;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentContext {
    task: string;
    recentMessages: string[];
}

export interface WorkingMemoryEntry {
    entityKey: string;       // format: entityType/entityId/key
    summary: string;
    confidence: number;
    source: string;
    lastUpdated: string;
}

export interface WorkingMemoryBrief {
    agentId: string;
    operatingRules: string;
    inferredTaskType: string;
    workingMemory: WorkingMemoryEntry[];
    sessionStarted: string;
    briefGeneratedAt: string;
    contextCallCount: number;
}

// ─── Observe Types ────────────────────────────────────────────────────────────

export interface ObserveInput {
    currentContext: string;
    maxFacts?: number;          // default 5 — don't overwhelm context
    entityHints?: string[];     // deterministic canonical entities from caller
}

export interface FactInjection {
    entityKey: string;          // entityType/entityId/key
    summary: string;
    value: unknown;
    confidence: number;
    source: string;
}

export interface ObserveResult {
    facts: FactInjection[];           // inject these into context
    entitiesDetected: string[];       // entities found in context
    alreadyPresent: number;           // facts skipped (already in context)
    totalFound: number;               // total facts found before filtering
    entitiesResolved?: Array<{
        name: string;
        input: string;
        canonicalEntity: string;
        confidence: number;
        matchedBy: 'exact' | 'alias' | 'created' | 'hint';
    }>;
    debug?: {
        skipped?: 'empty_context';
        contextLength: number;
        detectionWindowChars: number;
        detectedCandidates: number;
        keptCandidates: number;
        hintsProvided?: number;
        hintsResolved?: number;
        dropped: Array<{ name: string; reason: string }>;
    };
}

type EntityCandidate = {
    type: string;
    name: string;
    id_guess: string;
    confidence: number;
    evidence: string;
    start?: number;
    end?: number;
};

function heuristicEntityId(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function extractFallbackCandidates(text: string): EntityCandidate[] {
    const candidates: EntityCandidate[] = [];
    const seen = new Set<string>();

    // Explicit typed entities, e.g. project/atlas_2026
    const typedRegex = /\b([a-z][a-z0-9_]*)\/([A-Za-z0-9][A-Za-z0-9_\-]{1,80})\b/g;
    for (const match of text.matchAll(typedRegex)) {
        const type = match[1];
        const idGuess = heuristicEntityId(match[2]);
        if (!idGuess) continue;
        const evidence = match[0];
        const key = `${type}/${idGuess}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
            type,
            name: idGuess.replace(/_/g, ' '),
            id_guess: idGuess,
            confidence: 0.8,
            evidence,
            start: typeof match.index === 'number' ? match.index : undefined,
            end: typeof match.index === 'number' ? match.index + evidence.length : undefined,
        });
    }

    // Named project mentions, e.g. "Project Atlas 2026"
    const projectRegex = /\bProject\s+([A-Z0-9][A-Za-z0-9_\-]*(?:\s+[A-Z0-9][A-Za-z0-9_\-]*){0,4})\b/g;
    for (const match of text.matchAll(projectRegex)) {
        const name = `Project ${match[1]}`.trim();
        const normalized = heuristicEntityId(match[1]);
        const idGuess = normalized ? `project_${normalized}` : '';
        if (!idGuess) continue;
        const key = `project/${idGuess}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
            type: 'project',
            name,
            id_guess: idGuess,
            confidence: 0.78,
            evidence: name,
            start: typeof match.index === 'number' ? match.index : undefined,
            end: typeof match.index === 'number' ? match.index + name.length : undefined,
        });
    }

    // Capitalized multi-word names fallback, e.g. "Atlas Initiative"
    const titleCaseRegex = /\b([A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*){1,3})\b/g;
    for (const match of text.matchAll(titleCaseRegex)) {
        const name = match[1].trim();
        const normalized = heuristicEntityId(name);
        if (!normalized) continue;
        const idGuess = `project_${normalized}`;
        const key = `project/${idGuess}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
            type: 'project',
            name,
            id_guess: idGuess,
            confidence: 0.75,
            evidence: name,
            start: typeof match.index === 'number' ? match.index : undefined,
            end: typeof match.index === 'number' ? match.index + name.length : undefined,
        });
    }

    return candidates;
}

// ─── AttendantInstance ───────────────────────────────────────────────────────

export class AttendantInstance {
    private agentId: string;
    private brief: WorkingMemoryBrief | null = null;
    private contextCallCount: number = 0;
    private sessionStarted: string = new Date().toISOString();

    constructor(agentId: string) {
        this.agentId = agentId;
    }

    // ── Handshake ────────────────────────────────────────────────────────────

    async handshake(context: AgentContext): Promise<WorkingMemoryBrief> {
        const t0 = timeStart();
        // Try to resume from persisted state first
        const persisted = await this.loadPersistedState();

        // Load operating rules from Staff Namespace
        const operatingRules = await this.loadOperatingRules();

        // Infer task type
        const inferredTaskType = await this.inferTask(context);

        // Load knowledge — agent entries + related entities
        const workingMemory = await this.buildWorkingMemory(inferredTaskType);

        this.brief = {
            agentId: this.agentId,
            operatingRules,
            inferredTaskType,
            workingMemory,
            sessionStarted: persisted?.sessionStarted ?? this.sessionStarted,
            briefGeneratedAt: new Date().toISOString(),
            contextCallCount: this.contextCallCount,
        };

        await this.persistState();
        timeEnd('attendant.handshake_ms', t0);
        return this.brief;
    }

    // ── Reconvene ────────────────────────────────────────────────────────────

    async reconvene(context: AgentContext): Promise<WorkingMemoryBrief> {
        const t0 = timeStart();
        if (!this.brief) {
            const result = await this.handshake(context);
            timeEnd('attendant.reconvene_ms', t0);
            return result;
        }

        const newTaskType = await this.inferTask(context);

        // Task hasn't shifted — update timestamp only
        if (newTaskType.toLowerCase() === this.brief.inferredTaskType.toLowerCase()) {
            this.brief = {
                ...this.brief,
                briefGeneratedAt: new Date().toISOString(),
                contextCallCount: this.contextCallCount,
            };
            await this.persistState();
            timeEnd('attendant.reconvene_ms', t0);
            return this.brief;
        }

        // Task has shifted — rebuild working memory
        const workingMemory = await this.buildWorkingMemory(newTaskType);
        this.brief = {
            ...this.brief,
            inferredTaskType: newTaskType,
            workingMemory,
            briefGeneratedAt: new Date().toISOString(),
            contextCallCount: this.contextCallCount,
        };

        await this.persistState();
        timeEnd('attendant.reconvene_ms', t0);
        return this.brief;
    }

    // ── Context Update (fast, in-memory) ─────────────────────────────────────

    updateWorkingMemory(entry: WorkingMemoryEntry): void {
        if (!this.brief) return;

        const existing = this.brief.workingMemory.findIndex(
            (e) => e.entityKey === entry.entityKey
        );

        if (existing >= 0) {
            // Keep higher confidence entry
            if (entry.confidence >= this.brief.workingMemory[existing].confidence) {
                this.brief.workingMemory[existing] = entry;
            }
        } else {
            this.brief.workingMemory.push(entry);
        }
    }

    // ── Context Recovery ─────────────────────────────────────────────────────

    async onContextLow(): Promise<void> {
        const rulesResult: QueryResult = await queryEntry(ATTENDANT_RULES_QUERY);
        const operatingRules = rulesResult.found && rulesResult.entry
            ? rulesResult.entry.valueSummary
            : 'No operating rules found.';

        if (this.brief) {
            this.brief.operatingRules = operatingRules;
            this.brief.contextCallCount = 0;
        }

        this.contextCallCount = 0;
        await this.persistState();
    }

    // ── Getters ──────────────────────────────────────────────────────────────

    getBrief(): WorkingMemoryBrief | null {
        return this.brief;
    }

    getAgentId(): string {
        return this.agentId;
    }

    // ── Context Window Observation ────────────────────────────────────────────

    async observe(input: ObserveInput): Promise<ObserveResult> {
        const t0 = timeStart();
        const maxFacts = input.maxFacts ?? 5;
        const currentContext = input.currentContext ?? '';
        const entityHints = Array.isArray(input.entityHints)
            ? input.entityHints.filter((hint) => typeof hint === 'string' && hint.trim().length > 0)
            : [];

        if (currentContext.trim().length === 0 && entityHints.length === 0) {
            timeEnd('attendant.observe_ms', t0);
            return {
                facts: [],
                entitiesDetected: [],
                alreadyPresent: 0,
                totalFound: 0,
                entitiesResolved: [],
                debug: {
                    skipped: 'empty_context',
                    contextLength: 0,
                    detectionWindowChars: 0,
                    detectedCandidates: 0,
                    keptCandidates: 0,
                    hintsProvided: 0,
                    hintsResolved: 0,
                    dropped: [],
                },
            };
        }

        const detectionWindow = currentContext.length <= ENTITY_DETECTION_WINDOW_CHARS
            ? currentContext
            : currentContext.slice(-ENTITY_DETECTION_WINDOW_CHARS);
        const droppedCandidates: Array<{ name: string; reason: string }> = [];

        // Step 1 — extract entity mentions from context (if any text is available)
        let parsedCandidates: EntityCandidate[] = [];
        if (detectionWindow.trim().length > 0) {
            const entityResponse = await route('extraction', [
                {
                    role: 'user',
                    content: `Extract explicitly named entities from the text.
An entity can be a person, organization, project, technology, or named concept.

Return ONLY valid JSON as an array of objects in this exact shape:
[
  {
    "type": "project",
    "name": "Project Atlas",
    "id_guess": "project_atlas",
    "confidence": 0.92,
    "evidence": "Project Atlas",
    "start": 123,
    "end": 136
  }
]

Rules:
- Only include entities explicitly named in the provided text.
- Do not infer or carry over entities not present in the text.
- If uncertain, omit.
- If none are present, return [].

Text:
${detectionWindow}`,
                },
            ], 512);

            try {
                const clean = entityResponse.text.replace(/```json|```/g, '').trim();
                const parsed = JSON.parse(clean);
                if (Array.isArray(parsed)) {
                    for (const item of parsed) {
                        if (typeof item === 'string') {
                            const raw = item.trim();
                            if (!raw) continue;

                            if (raw.includes('/')) {
                                const [type, ...rest] = raw.split('/');
                                const idGuess = heuristicEntityId(rest.join('/'));
                                if (!type || !idGuess) continue;
                                parsedCandidates.push({
                                    type,
                                    name: idGuess.replace(/_/g, ' '),
                                    id_guess: idGuess,
                                    confidence: 0.9,
                                    evidence: raw,
                                });
                            } else {
                                const idGuess = heuristicEntityId(raw);
                                if (!idGuess) continue;
                                parsedCandidates.push({
                                    type: 'project',
                                    name: raw,
                                    id_guess: `project_${idGuess}`,
                                    confidence: 0.76,
                                    evidence: raw,
                                });
                            }
                            continue;
                        }

                        if (!item || typeof item !== 'object') continue;
                        const candidate = item as Partial<EntityCandidate>;
                        if (
                            typeof candidate.type === 'string' &&
                            typeof candidate.name === 'string' &&
                            typeof candidate.id_guess === 'string' &&
                            typeof candidate.confidence === 'number' &&
                            typeof candidate.evidence === 'string'
                        ) {
                            parsedCandidates.push({
                                type: candidate.type,
                                name: candidate.name,
                                id_guess: candidate.id_guess,
                                confidence: candidate.confidence,
                                evidence: candidate.evidence,
                                start: candidate.start,
                                end: candidate.end,
                            });
                        }
                    }
                }
            } catch {
                droppedCandidates.push({ name: 'parse_error', reason: 'invalid_json' });
            }

            if (parsedCandidates.length === 0) {
                parsedCandidates = extractFallbackCandidates(detectionWindow);
                if (parsedCandidates.length > 0) {
                    droppedCandidates.push({ name: 'fallback_extraction', reason: 'heuristic_used' });
                }
            }
        }

        const gatedCandidates: EntityCandidate[] = [];
        for (const candidate of parsedCandidates) {
            if (candidate.confidence < MIN_ENTITY_CONFIDENCE) {
                droppedCandidates.push({ name: candidate.name, reason: 'low_confidence' });
                continue;
            }
            const evidenceLower = candidate.evidence.toLowerCase().trim();
            if (!evidenceLower || !detectionWindow.toLowerCase().includes(evidenceLower)) {
                droppedCandidates.push({ name: candidate.name, reason: 'missing_evidence' });
                continue;
            }
            gatedCandidates.push(candidate);
        }

        if (gatedCandidates.length === 0 && entityHints.length === 0) {
            timeEnd('attendant.observe_ms', t0);
            return {
                facts: [],
                entitiesDetected: [],
                alreadyPresent: 0,
                totalFound: 0,
                entitiesResolved: [],
                debug: {
                    contextLength: currentContext.length,
                    detectionWindowChars: detectionWindow.length,
                    detectedCandidates: parsedCandidates.length,
                    keptCandidates: 0,
                    hintsProvided: entityHints.length,
                    hintsResolved: 0,
                    dropped: droppedCandidates,
                },
            };
        }

        // Step 2 — resolve hints and candidates to canonical entities, then query Library
        const policy = await getConflictPolicy();
        const maxEntities = policy.maxEntitiesPerObserve ?? 5;
        const maxKeysPerEntity = policy.maxKeysPerEntity ?? 5;
        const allFacts: FactInjection[] = [];
        const entitiesResolved: ObserveResult['entitiesResolved'] = [];
        const entitiesDetected = new Set<string>();
        const resolvedEntities = new Map<string, {
            entityType: string;
            entityId: string;
            canonicalEntity: string;
            name: string;
            input: string;
            confidence: number;
            matchedBy: 'exact' | 'alias' | 'created' | 'hint';
        }>();

        for (const hint of entityHints) {
            try {
                const parsedHint = parseEntityString(hint);
                const resolved = await resolveEntity({
                    entityType: parsedHint.entityType,
                    entityId: parsedHint.entityId,
                    rawName: hint,
                    aliases: [hint, parsedHint.entityId],
                    source: 'observe_hint',
                    confidence: 100,
                    createIfMissing: false,
                });

                if (!resolvedEntities.has(resolved.canonicalEntity)) {
                    resolvedEntities.set(resolved.canonicalEntity, {
                        entityType: resolved.entityType,
                        entityId: resolved.entityId,
                        canonicalEntity: resolved.canonicalEntity,
                        name: parsedHint.entityId.replace(/_/g, ' '),
                        input: hint,
                        confidence: 1,
                        matchedBy: 'hint',
                    });
                }
            } catch {
                droppedCandidates.push({ name: hint, reason: 'invalid_or_unresolved_hint' });
                continue;
            }
        }

        for (const candidate of gatedCandidates.slice(0, maxEntities)) {
            const fallbackEntity = `${candidate.type}/${candidate.id_guess}`;

            try {
                const resolved = await resolveEntity({
                    entityType: candidate.type,
                    entityId: candidate.id_guess,
                    rawName: candidate.name,
                    aliases: [
                        candidate.name,
                        candidate.evidence,
                        fallbackEntity,
                    ],
                    source: 'observe',
                    confidence: Math.round(candidate.confidence * 100),
                    createIfMissing: false,
                });

                if (!resolvedEntities.has(resolved.canonicalEntity)) {
                    resolvedEntities.set(resolved.canonicalEntity, {
                        entityType: resolved.entityType,
                        entityId: resolved.entityId,
                        canonicalEntity: resolved.canonicalEntity,
                        name: candidate.name,
                        input: fallbackEntity,
                        confidence: candidate.confidence,
                        matchedBy: resolved.matchedBy,
                    });
                }
            } catch {
                droppedCandidates.push({ name: candidate.name, reason: 'unresolved' });
                continue;
            }
        }

        for (const resolvedInfo of Array.from(resolvedEntities.values()).slice(0, maxEntities)) {
            entitiesDetected.add(resolvedInfo.canonicalEntity);
            entitiesResolved?.push({
                name: resolvedInfo.name,
                input: resolvedInfo.input,
                canonicalEntity: resolvedInfo.canonicalEntity,
                confidence: resolvedInfo.confidence,
                matchedBy: resolvedInfo.matchedBy,
            });

            const allEntries = await findEntriesByEntity(resolvedInfo.entityType, resolvedInfo.entityId);

            // Priority keys first
            const priorityKeys = policy.observeKeyPriority?.[resolvedInfo.entityType] ?? [];
            const priorityEntries = allEntries.filter((e) => priorityKeys.includes(e.key));
            const remainingEntries = allEntries
                .filter((e) => !priorityKeys.includes(e.key))
                .sort((a, b) => b.confidence - a.confidence);

            const selectedEntries = [...priorityEntries, ...remainingEntries].slice(0, maxKeysPerEntity);

            for (const entry of selectedEntries) {
                allFacts.push({
                    entityKey: `${resolvedInfo.entityType}/${resolvedInfo.entityId}/${entry.key}`,
                    summary: entry.valueSummary,
                    value: entry.valueRaw,
                    confidence: entry.confidence,
                    source: entry.source,
                });
            }
        }

        // Step 3 — filter out facts already present in context
        const contextLower = currentContext.toLowerCase();
        let alreadyPresent = 0;
        const newFacts: FactInjection[] = [];

        for (const fact of allFacts) {
            // Check if summary key words appear in context
            const summaryWords = fact.summary.toLowerCase().split(' ').filter((w) => w.length > 4);
            const alreadyInContext = summaryWords.length > 0 &&
                summaryWords.filter((w) => contextLower.includes(w)).length >= Math.ceil(summaryWords.length * 0.6);

            if (alreadyInContext) {
                alreadyPresent++;
            } else {
                newFacts.push(fact);
            }
        }

        // Step 4 — return top facts by confidence
        const topFacts = newFacts
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, maxFacts);

        timeEnd('attendant.observe_ms', t0);
        return {
            facts: topFacts,
            entitiesDetected: Array.from(entitiesDetected),
            alreadyPresent,
            totalFound: allFacts.length,
            entitiesResolved,
            debug: {
                contextLength: currentContext.length,
                detectionWindowChars: detectionWindow.length,
                detectedCandidates: parsedCandidates.length,
                keptCandidates: gatedCandidates.length,
                hintsProvided: entityHints.length,
                hintsResolved: entitiesResolved?.filter((e) => e.matchedBy === 'hint').length ?? 0,
                dropped: droppedCandidates,
            },
        };
    }

    // ── Private ──────────────────────────────────────────────────────────────

    private async inferTask(context: AgentContext): Promise<string> {
        this.contextCallCount++;
        if (this.contextCallCount >= CONTEXT_RECOVERY_THRESHOLD) {
            await this.onContextLow();
        }

        const response = await route('task_inference', [
            {
                role: 'user',
                content: `You are analyzing what an AI agent is currently working on.

Agent ID: ${this.agentId}
Task description: ${context.task}
Recent messages:
${context.recentMessages.map((m, i) => `${i + 1}. ${m}`).join('\n')}

In one short sentence, describe the specific type of task this agent is currently performing.
Be specific and concrete.`,
            },
        ], 256);

        return response.text;
    }

    private async loadOperatingRules(): Promise<string> {
        const rulesResult: QueryResult = await queryEntry(ATTENDANT_RULES_QUERY);
        return rulesResult.found && rulesResult.entry
            ? rulesResult.entry.valueSummary
            : 'No operating rules found.';
    }

    private async buildWorkingMemory(taskType: string): Promise<WorkingMemoryEntry[]> {
        this.contextCallCount++;

        // Fetch agent entries + related entity entries
        const agentEntries = await findEntriesByEntity('agent', this.agentId);
        const relatedEntities = await getRelatedDeep('agent', this.agentId, 2);
        const relatedEntries = await Promise.all(
            relatedEntities.map((r) => findEntriesByEntity(r.entityType, r.entityId))
        );

        const allEntries = [...agentEntries, ...relatedEntries.flat()];

        if (allEntries.length === 0) return [];

        const entryInputs = allEntries.map((e) => ({
            key: `${e.entityType}/${e.entityId}/${e.key}`,
            valueSummary: e.valueSummary,
            confidence: e.confidence,
            source: e.source,
        }));

        // Filter to relevant entries for current task
        const response = await route('relevance_filtering', [
            {
                role: 'user',
                content: `You are deciding what knowledge an AI agent needs for its current task.

Agent task: ${taskType}

Available knowledge entries:
${entryInputs.map((e, i) => `${i + 1}. [${e.key}] ${e.valueSummary} (confidence: ${e.confidence})`).join('\n')}

Return only the numbers of entries that are directly relevant to the current task.
Format: comma-separated numbers only. Example: 1,3,5
If nothing is relevant, return: none`,
            },
        ], 128);

        if (response.text.trim() === 'none') return [];

        const indices = response.text
            .split(',')
            .map((s) => parseInt(s.trim()) - 1)
            .filter((i) => i >= 0 && i < entryInputs.length);

        return indices.map((i) => ({
            entityKey: entryInputs[i].key,
            summary: entryInputs[i].valueSummary,
            confidence: entryInputs[i].confidence,
            source: entryInputs[i].source,
            lastUpdated: new Date().toISOString(),
        }));
    }

    private async persistState(): Promise<void> {
        if (!this.brief) return;

        await getDb().knowledgeEntry.upsert({
            where: {
                entityType_entityId_key: {
                    entityType: 'agent',
                    entityId: this.agentId,
                    key: 'attendant_state',
                },
            },
            update: {
                valueRaw: this.brief as unknown as Prisma.InputJsonValue,
                valueSummary: `Attendant state for ${this.agentId}`,
                updatedAt: new Date(),
            },
            create: {
                entityType: 'agent',
                entityId: this.agentId,
                key: 'attendant_state',
                valueRaw: this.brief as unknown as Prisma.InputJsonValue,
                valueSummary: `Attendant state for ${this.agentId}`,
                confidence: 100,
                source: 'attendant',
                createdBy: 'attendant',
                isProtected: false,
                conflictLog: [],
            },
        });
    }

    private async loadPersistedState(): Promise<WorkingMemoryBrief | null> {
        const entry = await getDb().knowledgeEntry.findUnique({
            where: {
                entityType_entityId_key: {
                    entityType: 'agent',
                    entityId: this.agentId,
                    key: 'attendant_state',
                },
            },
        });

        if (!entry) return null;

        const state = entry.valueRaw as unknown as WorkingMemoryBrief;
        this.sessionStarted = state.sessionStarted;
        this.contextCallCount = state.contextCallCount ?? 0;
        this.brief = state;
        return state;
    }
}
