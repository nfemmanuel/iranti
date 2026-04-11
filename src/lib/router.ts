/**
 * LLM task router for Iranti's Librarian and Attendant.
 *
 * Maps each semantic task type (classification, conflict_resolution, etc.) to
 * an appropriate model based on the active LLM_PROVIDER and optional per-task
 * model overrides via env vars (CLASSIFICATION_MODEL, CONFLICT_MODEL, etc.).
 * Provider compatibility is validated before applying an override — incompatible
 * overrides are logged and the default model is used instead.
 *
 * Task routing rationale:
 *   - conflict_resolution → strongest model (requires careful reasoning)
 *   - all other task types → fast/cheap model (classification, filtering, extraction)
 *
 * Key exports:
 *   - route()            — execute an LLM call with the correct model for the task
 *   - getModelProfile()  — inspect which model would be used for a given task
 *   - getAllProfiles()    — full provider/model map for all task types
 *   - TaskType           — union of supported task type strings
 */

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

function getRouterProvider(): string {
    return process.env.LLM_PROVIDER ?? 'mock';
}

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
            return taskType === 'conflict_resolution' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
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
    const routerProvider = getRouterProvider();
    const override = process.env[envVarName];
    if (override && override.trim().length > 0) {
        const model = override.trim();
        if (isLikelyCompatible(routerProvider, model)) {
            return model;
        }
        const fallback = defaultModelForProvider(taskType, routerProvider);
        console.warn(
            `[router] Ignoring incompatible ${envVarName}="${model}" for provider "${routerProvider}". ` +
            `Using "${fallback}" instead.`
        );
        return fallback;
    }
    return defaultModelForProvider(taskType, routerProvider);
}

function buildModelProfiles(): Record<TaskType, ModelProfile> {
    const routerProvider = getRouterProvider();
    return {
        classification: {
            provider: routerProvider,
            model: modelForTask('classification', 'CLASSIFICATION_MODEL'),
            reason: 'Fast and cheap - classification does not need deep reasoning',
        },
        relevance_filtering: {
            provider: routerProvider,
            model: modelForTask('relevance_filtering', 'RELEVANCE_MODEL'),
            reason: 'Fast enough for filtering, does not need full reasoning capacity',
        },
        conflict_resolution: {
            provider: routerProvider,
            model: modelForTask('conflict_resolution', 'CONFLICT_MODEL'),
            reason: 'Conflict resolution requires careful reasoning about sources and credibility',
        },
        summarization: {
            provider: routerProvider,
            model: modelForTask('summarization', 'SUMMARIZATION_MODEL'),
            reason: 'Summarization is well within fast model capabilities',
        },
        task_inference: {
            provider: routerProvider,
            model: modelForTask('task_inference', 'TASK_INFERENCE_MODEL'),
            reason: 'Task inference is a lightweight classification task',
        },
        extraction: {
            provider: routerProvider,
            model: modelForTask('extraction', 'EXTRACTION_MODEL'),
            reason: 'Extraction needs structured output capability, fast model is sufficient',
        },
    };
}

// Router

export async function route(
    taskType: TaskType,
    messages: LLMMessage[],
    maxTokens?: number
): Promise<LLMResponse & { taskType: TaskType; modelProfile: ModelProfile; providerUsed: string }> {
    const profile = buildModelProfiles()[taskType];
    const timeoutMs = taskType === 'conflict_resolution'
        ? resolveTaskTimeoutMs(process.env.IRANTI_CONFLICT_RESOLUTION_TIMEOUT_MS, 10_000)
        : undefined;
    const response = await completeWithFallback(messages, {
        preferredProvider: profile.provider,
        model: profile.model,
        maxTokens,
        timeoutMs,
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
    return buildModelProfiles()[taskType];
}

export function getAllProfiles(): Record<TaskType, ModelProfile> {
    return buildModelProfiles();
}

function resolveTaskTimeoutMs(rawValue: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(rawValue ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
