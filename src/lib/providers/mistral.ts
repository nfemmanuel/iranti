import { LLMProvider, LLMMessage, LLMResponse, CompleteOptions, normalizeProviderApiError } from '../llm';

interface MistralResponse {
    choices: Array<{
        message: {
            content: string;
        };
    }>;
    model: string;
}

class MistralProvider implements LLMProvider {
    private apiKey: string;
    private model: string;

    constructor() {
        this.apiKey = process.env.MISTRAL_API_KEY ?? '';
        this.model = process.env.MISTRAL_MODEL ?? 'mistral-small-latest';

        if (!this.apiKey) {
            throw new Error('MISTRAL_API_KEY is not set');
        }
    }

    async complete(messages: LLMMessage[], options?: CompleteOptions): Promise<LLMResponse> {
        const maxTokens = options?.maxTokens ?? 1024;
        const model = options?.model ?? this.model;
        const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model,
                messages: messages.map((m) => ({ role: m.role, content: m.content })),
                max_tokens: maxTokens,
            }),
        });

        if (!response.ok) {
            const raw = await response.text();
            throw normalizeProviderApiError('mistral', response.status, response.statusText, raw);
        }

        const data = await response.json() as MistralResponse;
        const text = data.choices[0]?.message?.content ?? '';

        return {
            text,
            model: data.model,
            provider: 'mistral',
        };
    }
}

export default new MistralProvider();
