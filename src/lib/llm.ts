// ─── Provider Interface ──────────────────────────────────────────────────────

export interface LLMMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface LLMResponse {
    text: string;
    model: string;
    provider: string;
}

export interface LLMProvider {
    complete(messages: LLMMessage[], maxTokens?: number): Promise<LLMResponse>;
}

// ─── Provider Registry ───────────────────────────────────────────────────────

const PROVIDERS: Record<string, () => Promise<LLMProvider>> = {
    mock: () => import('./providers/mock').then((m) => m.default),
    gemini: () => import('./providers/gemini').then((m) => m.default),
    claude: () => import('./providers/claude').then((m) => m.default),
    openai: () => import('./providers/openai').then((m) => m.default),
    groq: () => import('./providers/groq').then((m) => m.default),
    mistral: () => import('./providers/mistral').then((m) => m.default),
    ollama: () => import('./providers/ollama').then((m) => m.default),
};

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
        return providerCache.get(name)!;
    }
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
    maxTokens?: number,
    preferredProvider?: string
): Promise<LLMResponse & { providerUsed: string }> {
    const chain = preferredProvider 
        ? [preferredProvider, ...getFallbackChain().filter(p => p !== preferredProvider)]
        : getFallbackChain();
    const errors: string[] = [];

    for (const providerName of chain) {
        try {
            let provider = providerCache.get(providerName);
            if (!provider) {
                provider = await loadProvider(providerName);
                providerCache.set(providerName, provider);
            }
            const response = await provider.complete(messages, maxTokens);
            
            // Log fallback usage if not primary
            if (providerName !== chain[0]) {
                console.warn(`  [router] Primary provider failed. Used fallback: ${providerName}`);
            }

            return { ...response, providerUsed: providerName };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            errors.push(`${providerName}: ${message}`);
            continue;
        }
    }

    throw new Error(`All providers failed:\n${errors.join('\n')}`);
}

// ─── Convenience ─────────────────────────────────────────────────────────────

export async function complete(
    messages: LLMMessage[],
    maxTokens?: number
): Promise<LLMResponse> {
    return completeWithFallback(messages, maxTokens);
}