import { LLMProvider, LLMMessage, LLMResponse, CompleteOptions, normalizeProviderApiError } from '../llm';

interface GeminiResponse {
    candidates?: Array<{
        content?: {
            parts?: Array<{ text?: string }>;
        };
    }>;
}

class GeminiProvider implements LLMProvider {
    private apiKey: string;
    private model: string;

    constructor() {
        this.apiKey = process.env.GEMINI_API_KEY ?? '';
        this.model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

        if (!this.apiKey) {
            throw new Error('GEMINI_API_KEY is not set in environment variables.');
        }
    }

    async complete(messages: LLMMessage[], options?: CompleteOptions): Promise<LLMResponse> {
        const model = options?.model ?? this.model;
        const maxTokens = options?.maxTokens ?? 512;
        
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: messages.map((m) => ({
                        role: m.role === 'assistant' ? 'model' : 'user',
                        parts: [{ text: m.content }],
                    })),
                    generationConfig: {
                        maxOutputTokens: maxTokens,
                    },
                }),
            }
        );

        if (!response.ok) {
            const raw = await response.text();
            throw normalizeProviderApiError('gemini', response.status, response.statusText, raw);
        }

        const data = await response.json() as GeminiResponse;
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

        return {
            text: text.trim(),
            model: model,
            provider: 'gemini',
        };
    }
}

export default new GeminiProvider();
