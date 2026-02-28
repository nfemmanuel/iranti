import { complete, getLLM, LLMMessage, LLMResponse } from './llm';

// ─── Task Types ──────────────────────────────────────────────────────────────

export type TaskType =
    | 'classification'      // Simple yes/no or category decisions
    | 'relevance_filtering' // Deciding what knowledge is relevant
    | 'conflict_resolution' // Reasoning about contradicting facts
    | 'summarization'       // Compressing knowledge for working memory
    | 'task_inference';     // Inferring what an agent is doing

// ─── Model Profiles ──────────────────────────────────────────────────────────

interface ModelProfile {
    provider: string;
    model: string;
    reason: string;
}

// Maps task types to the best model for that task.
// Override any of these via environment variables.
const MODEL_PROFILES: Record<TaskType, ModelProfile> = {
    classification: {
        provider: process.env.LLM_PROVIDER ?? 'mock',
        model: process.env.CLASSIFICATION_MODEL ?? 'gemini-2.0-flash-001',
        reason: 'Fast and cheap — classification does not need deep reasoning',
    },
    relevance_filtering: {
        provider: process.env.LLM_PROVIDER ?? 'mock',
        model: process.env.RELEVANCE_MODEL ?? 'gemini-2.0-flash-001',
        reason: 'Fast enough for filtering, does not need full reasoning capacity',
    },
    conflict_resolution: {
        provider: process.env.LLM_PROVIDER ?? 'mock',
        model: process.env.CONFLICT_MODEL ?? 'gemini-2.5-pro',
        reason: 'Conflict resolution requires careful reasoning about sources and credibility',
    },
    summarization: {
        provider: process.env.LLM_PROVIDER ?? 'mock',
        model: process.env.SUMMARIZATION_MODEL ?? 'gemini-2.0-flash-001',
        reason: 'Summarization is well within fast model capabilities',
    },
    task_inference: {
        provider: process.env.LLM_PROVIDER ?? 'mock',
        model: process.env.TASK_INFERENCE_MODEL ?? 'gemini-2.0-flash-001',
        reason: 'Task inference is a lightweight classification task',
    },
};

// ─── Router ──────────────────────────────────────────────────────────────────

export async function route(
    taskType: TaskType,
    messages: LLMMessage[],
    maxTokens?: number
): Promise<LLMResponse & { taskType: TaskType; modelProfile: ModelProfile }> {
    const profile = MODEL_PROFILES[taskType];

    // For now, all providers use the same LLM instance.
    // When multi-provider support is needed, instantiate per profile.provider here.
    const response = await complete(messages, maxTokens);

    return {
        ...response,
        taskType,
        modelProfile: profile,
    };
}

// ─── Profile Inspector ───────────────────────────────────────────────────────

export function getModelProfile(taskType: TaskType): ModelProfile {
    return MODEL_PROFILES[taskType];
}

export function getAllProfiles(): Record<TaskType, ModelProfile> {
    return MODEL_PROFILES;
}