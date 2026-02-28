import { complete } from '../lib/llm';
import { queryEntry, findEntriesByEntity } from '../library/queries';
import { EntryQuery, QueryResult } from '../types';

// ─── Constants ───────────────────────────────────────────────────────────────

const ATTENDANT_RULES_QUERY: EntryQuery = {
    entityType: 'system',
    entityId: 'attendant',
    key: 'operating_rules',
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentContext {
    agentId: string;
    taskDescription: string;
    recentMessages: string[];
}

export interface WorkingMemoryBrief {
    agentId: string;
    operatingRules: string;
    relevantKnowledge: Array<{
        key: string;
        summary: string;
        confidence: number;
    }>;
    inferredTaskType: string;
    briefGeneratedAt: string;
}

// ─── Task Inference ──────────────────────────────────────────────────────────

async function inferTaskContext(context: AgentContext): Promise<string> {
    const response = await complete([
        {
            role: 'user',
            content: `You are analyzing what an AI agent is currently working on.

Agent ID: ${context.agentId}
Task description: ${context.taskDescription}
Recent messages:
${context.recentMessages.map((m, i) => `${i + 1}. ${m}`).join('\n')}

In one short sentence, describe the specific type of task this agent is currently performing.
Be specific and concrete. Examples: "Researching academic publication history for a researcher",
"Negotiating a contract with a vendor", "Analyzing market trends for a technology sector".`,
        },
    ], 256);

    return response.text;
}

// ─── Relevance Filtering ─────────────────────────────────────────────────────

async function filterRelevantKnowledge(
    agentId: string,
    inferredTaskType: string,
    allEntries: Array<{ key: string; valueSummary: string; confidence: number }>
): Promise<Array<{ key: string; summary: string; confidence: number }>> {
    if (allEntries.length === 0) return [];

    const response = await complete([
        {
            role: 'user',
            content: `You are deciding what knowledge an AI agent needs for its current task.

Agent task: ${inferredTaskType}

Available knowledge entries:
${allEntries.map((e, i) => `${i + 1}. [${e.key}] ${e.valueSummary} (confidence: ${e.confidence})`).join('\n')}

Return only the numbers of entries that are directly relevant to the current task.
Format: comma-separated numbers only. Example: 1,3,5
If nothing is relevant, return: none`,
        },
    ], 128);

    if (response.text.trim() === 'none') return [];

    const indices = response.text
        .split(',')
        .map((s) => parseInt(s.trim()) - 1)
        .filter((i) => i >= 0 && i < allEntries.length);

    return indices.map((i) => ({
        key: allEntries[i].key,
        summary: allEntries[i].valueSummary,
        confidence: allEntries[i].confidence,
    }));
}

// ─── Handshake ───────────────────────────────────────────────────────────────

export async function handshake(context: AgentContext): Promise<WorkingMemoryBrief> {
    // 1. Fetch Attendant operating rules from Staff Namespace
    const rulesResult: QueryResult = await queryEntry(ATTENDANT_RULES_QUERY);
    const operatingRules = rulesResult.found && rulesResult.entry
        ? rulesResult.entry.valueSummary
        : 'No operating rules found.';

    // 2. Infer what the agent is currently doing
    const inferredTaskType = await inferTaskContext(context);

    // 3. Fetch all knowledge entries for this agent
    const agentEntries = await findEntriesByEntity('agent', context.agentId);
    const entryInputs = agentEntries.map((e) => ({
        key: e.key,
        valueSummary: e.valueSummary,
        confidence: e.confidence,
    }));

    // 4. Filter to only what's relevant for the current task
    const relevantKnowledge = await filterRelevantKnowledge(
        context.agentId,
        inferredTaskType,
        entryInputs
    );

    return {
        agentId: context.agentId,
        operatingRules,
        relevantKnowledge,
        inferredTaskType,
        briefGeneratedAt: new Date().toISOString(),
    };
}

// ─── Reconvene ───────────────────────────────────────────────────────────────

export async function reconvene(
    previousBrief: WorkingMemoryBrief,
    updatedContext: AgentContext
): Promise<WorkingMemoryBrief> {
    const newTaskType = await inferTaskContext(updatedContext);

    if (newTaskType.toLowerCase() === previousBrief.inferredTaskType.toLowerCase()) {
        return {
            ...previousBrief,
            briefGeneratedAt: new Date().toISOString(),
        };
    }

    return handshake(updatedContext);
}