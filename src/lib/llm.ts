// ─── Provider Interface ──────────────────────────────────────────────────────

import { inc, timeStart, timeEnd } from './metrics';
import { getContext } from './requestContext';

const MAX_LLM_CALLS_PER_REQUEST = 10;

function incrementLLMBudget() {
    const ctx = getContext();
    if (!ctx) {
        return;
    }
    ctx.llmCount += 1;
    if (ctx.llmCount > MAX_LLM_CALLS_PER_REQUEST) {
        throw new Error('LLM call budget exceeded for request.');
    }
}

export interface LLMMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface LLMResponse {
    text: string;
    model: string;
    provider: string;
}

export type CompleteOptions = {
    model?: string;
    maxTokens?: number;
};

export interface LLMProvider {
    complete(messages: LLMMessage[], options?: CompleteOptions): Promise<LLMResponse>;
}

function titleCaseProvider(provider: string): string {
    return provider === 'openai'
        ? 'OpenAI'
        : provider === 'claude'
            ? 'Claude'
            : provider === 'gemini'
                ? 'Gemini'
                : provider === 'groq'
                    ? 'Groq'
                    : provider === 'mistral'
                        ? 'Mistral'
                        : provider === 'ollama'
                            ? 'Ollama'
                            : provider === 'mock'
                                ? 'Mock'
                                : provider;
}

export function normalizeProviderApiError(
    provider: string,
    status: number | undefined,
    statusText: string | undefined,
    rawBody?: string
): Error {
    const title = titleCaseProvider(provider);
    const body = (rawBody ?? '').trim();
    const haystack = `${statusText ?? ''} ${body}`.toLowerCase();

    const quotaExhausted = haystack.includes('insufficient_quota')
        || haystack.includes('quota')
        || haystack.includes('billing')
        || haystack.includes('credit')
        || haystack.includes('resource has been exhausted')
        || haystack.includes('exceeded your current quota');

    if (quotaExhausted) {
        return new Error(`${title} quota or billing limit reached. Add credits, update the API key, or switch providers.`);
    }

    if (status === 429 || haystack.includes('rate limit')) {
        return new Error(`${title} rate limit reached. Retry later or reduce request volume.`);
    }

    const detail = body ? ` - ${body.slice(0, 600)}` : '';
    return new Error(`${title} API error: ${status ?? 'unknown'} ${statusText ?? ''}${detail}`.trim());
}

export function normalizeProviderCaughtError(provider: string, error: unknown): Error {
    if (error instanceof Error) {
        const raw = error.message ?? '';
        const haystack = raw.toLowerCase();
        if (
            haystack.includes('insufficient_quota')
            || haystack.includes('quota')
            || haystack.includes('billing')
            || haystack.includes('credit')
            || haystack.includes('resource has been exhausted')
            || haystack.includes('exceeded your current quota')
        ) {
            return new Error(`${titleCaseProvider(provider)} quota or billing limit reached. Add credits, update the API key, or switch providers.`);
        }
        if (haystack.includes('rate limit') || haystack.includes('429')) {
            return new Error(`${titleCaseProvider(provider)} rate limit reached. Retry later or reduce request volume.`);
        }
        return error;
    }
    return new Error(`${titleCaseProvider(provider)} provider request failed: ${String(error)}`);
}

// ─── Provider Registry ───────────────────────────────────────────────────────

const PROVIDERS: Record<string, () => Promise<LLMProvider>> = {
    mock: () => import('./providers/mock').then((m) => m.default as LLMProvider),
    gemini: () => import('./providers/gemini').then((m) => m.default as LLMProvider),
    claude: () => import('./providers/claude').then((m) => m.default as LLMProvider),
    openai: () => import('./providers/openai').then((m) => m.default as LLMProvider),
    groq: () => import('./providers/groq').then((m) => m.default as LLMProvider),
    mistral: () => import('./providers/mistral').then((m) => m.default as LLMProvider),
    ollama: () => import('./providers/ollama').then((m) => m.default as LLMProvider),
};

export function getSupportedProviders(): string[] {
    return Object.keys(PROVIDERS).sort();
}

// ─── Provider Cache ──────────────────────────────────────────────────────────

const providerCache: Map<string, LLMProvider> = new Map();

export function getLLM(): LLMProvider {
    const primary = process.env.LLM_PROVIDER ?? 'mock';
    const cached = providerCache.get(primary);
    if (cached) return cached;
    throw new Error('Call initProvider() first or use complete() directly');
}

export async function initProvider(name: string): Promise<LLMProvider> {
    if (providerCache.has(name)) {
        inc('llm.cache_hit');
        return providerCache.get(name)!;
    }
    inc('llm.cache_miss');
    const provider = await loadProvider(name);
    providerCache.set(name, provider);
    return provider;
}

// ─── Fallback-Aware Provider ─────────────────────────────────────────────────

function getFallbackChain(): string[] {
    const primary = process.env.LLM_PROVIDER ?? 'mock';
    const fallbackEnv = process.env.LLM_PROVIDER_FALLBACK ?? '';

    const chain = [primary];

    if (fallbackEnv) {
        const fallbacks = fallbackEnv.split(',').map((s) => s.trim()).filter(Boolean);
        for (const f of fallbacks) {
            if (!chain.includes(f)) chain.push(f);
        }
    }

    // Always end with mock as final safety net
    if (!chain.includes('mock')) chain.push('mock');

    return chain;
}

async function loadProvider(name: string): Promise<LLMProvider> {
    const loader = PROVIDERS[name];
    if (!loader) throw new Error(`Unknown provider: ${name}`);
    return loader();
}

export async function completeWithFallback(
    messages: LLMMessage[],
    options?: { preferredProvider?: string; model?: string; maxTokens?: number }
): Promise<LLMResponse & { providerUsed: string }> {
    const chain = options?.preferredProvider 
        ? [options.preferredProvider, ...getFallbackChain().filter(p => p !== options.preferredProvider)]
        : getFallbackChain();
    const errors: string[] = [];

    for (const providerName of chain) {
        try {
            incrementLLMBudget();
            inc('llm.calls');
            const t0 = timeStart();
            
            let provider = providerCache.get(providerName);
            if (!provider) {
                inc('llm.cache_miss');
                provider = await loadProvider(providerName);
                providerCache.set(providerName, provider);
            } else {
                inc('llm.cache_hit');
            }
            
            const response = await provider.complete(messages, {
                model: options?.model,
                maxTokens: options?.maxTokens,
            });
            
            timeEnd('llm.latency_ms', t0);
            
            if (process.env.DEBUG_LLM) {
                console.log(`[LLM] ${providerName} / ${response.model}`);
            }
            
            if (providerName !== chain[0]) {
                console.warn(`  [router] Primary provider failed. Used fallback: ${providerName}`);
            }

            return { ...response, providerUsed: providerName };
        } catch (err) {
            inc('llm.failures');
            const message = err instanceof Error ? err.message : String(err);
            errors.push(`${providerName}: ${message}`);
            continue;
        }
    }

    throw new Error(`All providers failed:\n${errors.join('\n')}`);
}

// ─── Convenience ─────────────────────────────────────────────────────────────

export async function completeRouted(
    messages: LLMMessage[],
    route: { provider: string; model?: string; maxTokens?: number }
): Promise<LLMResponse> {
    incrementLLMBudget();
    let provider = providerCache.get(route.provider);
    if (!provider) {
        provider = await loadProvider(route.provider);
        providerCache.set(route.provider, provider);
    }
    return provider.complete(messages, { model: route.model, maxTokens: route.maxTokens });
}

export async function complete(
    messages: LLMMessage[],
    maxTokens?: number
): Promise<LLMResponse> {
    return completeWithFallback(messages, { maxTokens });
}
