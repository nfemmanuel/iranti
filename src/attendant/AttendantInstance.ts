import { route } from '../lib/router';
import { queryEntry, findEntriesByEntity } from '../library/queries';
import { getRelatedDeep } from '../library/relationships';
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

        // Step 1 — extract entity mentions from context
        const entityResponse = await route('extraction', [
            {
                role: 'user',
                content: `Extract all entity references from this text.
An entity is a person, organization, project, technology, or named concept.

Return ONLY a JSON array of strings in format "entityType/entityId".
Use snake_case for entityId. Infer entityType from context.
Examples: "researcher/jane_smith", "company/openai", "project/iranti"

If no clear entities, return: []

Text:
${input.currentContext.substring(0, 3000)}`,
            },
        ], 512);

        let entitiesDetected: string[] = [];
        try {
            const clean = entityResponse.text.replace(/```json|```/g, '').trim();
            const parsed = JSON.parse(clean);
            if (Array.isArray(parsed)) {
                entitiesDetected = parsed.filter((e) => typeof e === 'string' && e.includes('/'));
            }
        } catch {
            // extraction failed — return empty result gracefully
            timeEnd('attendant.observe_ms', t0);
            return { facts: [], entitiesDetected: [], alreadyPresent: 0, totalFound: 0 };
        }

        if (entitiesDetected.length === 0) {
            timeEnd('attendant.observe_ms', t0);
            return { facts: [], entitiesDetected: [], alreadyPresent: 0, totalFound: 0 };
        }

        // Step 2 — query Library for facts about detected entities (with key prioritization)
        const policy = await getConflictPolicy();
        const maxEntities = policy.maxEntitiesPerObserve ?? 5;
        const maxKeysPerEntity = policy.maxKeysPerEntity ?? 5;
        const allFacts: FactInjection[] = [];

        for (const entity of entitiesDetected.slice(0, maxEntities)) {
            const parts = entity.split('/');
            if (parts.length < 2) continue;
            const entityType = parts[0];
            const entityId = parts.slice(1).join('/');

            try {
                const allEntries = await findEntriesByEntity(entityType, entityId);
                
                // Priority keys first
                const priorityKeys = policy.observeKeyPriority?.[entityType] ?? [];
                const priorityEntries = allEntries.filter(e => priorityKeys.includes(e.key));
                const remainingEntries = allEntries
                    .filter(e => !priorityKeys.includes(e.key))
                    .sort((a, b) => b.confidence - a.confidence);
                
                const selectedEntries = [...priorityEntries, ...remainingEntries].slice(0, maxKeysPerEntity);
                
                for (const entry of selectedEntries) {
                    allFacts.push({
                        entityKey: `${entityType}/${entityId}/${entry.key}`,
                        summary: entry.valueSummary,
                        value: entry.valueRaw,
                        confidence: entry.confidence,
                        source: entry.source,
                    });
                }
            } catch {
                continue;
            }
        }

        // Step 3 — filter out facts already present in context
        const contextLower = input.currentContext.toLowerCase();
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
            entitiesDetected,
            alreadyPresent,
            totalFound: allFacts.length,
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
                createdBy: 'Attendant',
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
