import { LLMProvider, LLMMessage, LLMResponse } from '../llm';

interface OpenAIResponse {
    choices: Array<{
        message: {
            content: string;
        };
    }>;
    model: string;
}

class OpenAIProvider implements LLMProvider {
    private apiKey: string;
    private model: string;
    private baseUrl: string;

    constructor() {
        this.apiKey = process.env.OPENAI_API_KEY ?? '';
        this.model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
        this.baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';

        if (!this.apiKey) {
            throw new Error('OPENAI_API_KEY is not set');
        }
    }

    async complete(messages: LLMMessage[], maxTokens: number = 1024): Promise<LLMResponse> {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: this.model,
                messages: messages.map((m) => ({ role: m.role, content: m.content })),
                max_tokens: maxTokens,
            }),
        });

        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as OpenAIResponse;
        const text = data.choices[0]?.message?.content ?? '';

        return {
            text,
            model: data.model,
            provider: 'openai',
        };
    }
}

export default new OpenAIProvider();
