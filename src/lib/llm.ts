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

const providers: Record<string, () => Promise<LLMProvider>> = {
    mock: () => import('./providers/mock').then((m) => m.default),
    gemini: () => import('./providers/gemini').then((m) => m.default),
    claude: () => import('./providers/claude').then((m) => m.default),
};

// ─── Active Provider ─────────────────────────────────────────────────────────

let activeProvider: LLMProvider | null = null;

export async function getLLM(): Promise<LLMProvider> {
    if (activeProvider) return activeProvider;

    const providerName = process.env.LLM_PROVIDER ?? 'gemini';
    const loader = providers[providerName];

    if (!loader) {
        throw new Error(`Unknown LLM provider: ${providerName}. Valid options: ${Object.keys(providers).join(', ')}`);
    }

    activeProvider = await loader();
    return activeProvider;
}

// ─── Convenience ─────────────────────────────────────────────────────────────

export async function complete(
    messages: LLMMessage[],
    maxTokens?: number
): Promise<LLMResponse> {
    const llm = await getLLM();
    return llm.complete(messages, maxTokens);
}