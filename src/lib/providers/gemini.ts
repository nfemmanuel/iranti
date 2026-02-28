import { LLMProvider, LLMMessage, LLMResponse } from '../llm';

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
        this.model = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash';

        if (!this.apiKey) {
            throw new Error('GEMINI_API_KEY is not set in environment variables.');
        }
    }

    async complete(messages: LLMMessage[], maxTokens: number = 512): Promise<LLMResponse> {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
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
            throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as GeminiResponse;
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

        return {
            text: text.trim(),
            model: this.model,
            provider: 'gemini',
        };
    }
}

export default new GeminiProvider();