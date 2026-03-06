import { LLMMessage, LLMResponse, completeWithFallback } from './llm';

// Task Types

export type TaskType =
    | 'classification'      // Simple yes/no or category decisions
    | 'relevance_filtering' // Deciding what knowledge is relevant
    | 'conflict_resolution' // Reasoning about contradicting facts
    | 'summarization'       // Compressing knowledge for working memory
    | 'task_inference'      // Inferring what an agent is doing
    | 'extraction';         // Extracting structured facts from text

// Model Profiles

interface ModelProfile {
    provider: string;
    model: string;
    reason: string;
}

const ROUTER_PROVIDER = process.env.LLM_PROVIDER ?? 'mock';

function defaultModelForProvider(taskType: TaskType, provider: string): string {
    switch (provider) {
        case 'openai':
            return taskType === 'conflict_resolution' ? 'gpt-5' : 'gpt-5-mini';
        case 'groq':
            return 'meta-llama/llama-4-scout-17b-16e-instruct';
        case 'mistral':
            return 'mistral-small-latest';
        case 'ollama':
            return 'llama3.2';
        case 'claude':
            return taskType === 'conflict_resolution' ? 'claude-sonnet-4' : 'claude-3-5-haiku-latest';
        case 'mock':
            return 'mock';
        case 'gemini':
        default:
            return taskType === 'conflict_resolution' ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
    }
}

function isLikelyCompatible(provider: string, model: string): boolean {
    const m = model.toLowerCase();
    if (provider === 'mock') return true;
    if (provider === 'openai') return !(m.startsWith('gemini') || m.startsWith('claude') || m.startsWith('mistral') || m.startsWith('llama'));
    if (provider === 'gemini') return !m.startsWith('gpt') && !m.startsWith('claude') && !m.startsWith('mistral') && !m.startsWith('llama');
    if (provider === 'claude') return m.startsWith('claude');
    if (provider === 'mistral') return m.startsWith('mistral');
    return true;
}

function modelForTask(taskType: TaskType, envVarName: string): string {
    const override = process.env[envVarName];
    if (override && override.trim().length > 0) {
        const model = override.trim();
        if (isLikelyCompatible(ROUTER_PROVIDER, model)) {
            return model;
        }
        const fallback = defaultModelForProvider(taskType, ROUTER_PROVIDER);
        console.warn(
            `[router] Ignoring incompatible ${envVarName}="${model}" for provider "${ROUTER_PROVIDER}". ` +
            `Using "${fallback}" instead.`
        );
        return fallback;
    }
    return defaultModelForProvider(taskType, ROUTER_PROVIDER);
}

// Maps task types to routed models.
// Override any task model via env (for example CONFLICT_MODEL=...).
const MODEL_PROFILES: Record<TaskType, ModelProfile> = {
    classification: {
        provider: ROUTER_PROVIDER,
        model: modelForTask('classification', 'CLASSIFICATION_MODEL'),
        reason: 'Fast and cheap - classification does not need deep reasoning',
    },
    relevance_filtering: {
        provider: ROUTER_PROVIDER,
        model: modelForTask('relevance_filtering', 'RELEVANCE_MODEL'),
        reason: 'Fast enough for filtering, does not need full reasoning capacity',
    },
    conflict_resolution: {
        provider: ROUTER_PROVIDER,
        model: modelForTask('conflict_resolution', 'CONFLICT_MODEL'),
        reason: 'Conflict resolution requires careful reasoning about sources and credibility',
    },
    summarization: {
        provider: ROUTER_PROVIDER,
        model: modelForTask('summarization', 'SUMMARIZATION_MODEL'),
        reason: 'Summarization is well within fast model capabilities',
    },
    task_inference: {
        provider: ROUTER_PROVIDER,
        model: modelForTask('task_inference', 'TASK_INFERENCE_MODEL'),
        reason: 'Task inference is a lightweight classification task',
    },
    extraction: {
        provider: ROUTER_PROVIDER,
        model: modelForTask('extraction', 'EXTRACTION_MODEL'),
        reason: 'Extraction needs structured output capability, fast model is sufficient',
    },
};

// Router

export async function route(
    taskType: TaskType,
    messages: LLMMessage[],
    maxTokens?: number
): Promise<LLMResponse & { taskType: TaskType; modelProfile: ModelProfile; providerUsed: string }> {
    const profile = MODEL_PROFILES[taskType];
    const response = await completeWithFallback(messages, {
        preferredProvider: profile.provider,
        model: profile.model,
        maxTokens,
    });

    return {
        ...response,
        taskType,
        modelProfile: profile,
        providerUsed: response.providerUsed,
    };
}

// Profile Inspector

export function getModelProfile(taskType: TaskType): ModelProfile {
    return MODEL_PROFILES[taskType];
}

export function getAllProfiles(): Record<TaskType, ModelProfile> {
    return MODEL_PROFILES;
}
