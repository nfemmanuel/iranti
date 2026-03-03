import { LLMProvider, LLMMessage, LLMResponse, CompleteOptions } from '../llm';

interface GroqResponse {
    choices: Array<{
        message: {
            content: string;
        };
    }>;
    model: string;
}

class GroqProvider implements LLMProvider {
    private apiKey: string;
    private model: string;

    constructor() {
        this.apiKey = process.env.GROQ_API_KEY ?? '';
        this.model = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';

        if (!this.apiKey) {
            throw new Error('GROQ_API_KEY is not set');
        }
    }

    async complete(messages: LLMMessage[], options?: CompleteOptions): Promise<LLMResponse> {
        const maxTokens = options?.maxTokens ?? 1024;
        const model = options?.model ?? this.model;
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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
            throw new Error(`Groq API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as GroqResponse;
        const text = data.choices[0]?.message?.content ?? '';

        return {
            text,
            model: data.model,
            provider: 'groq',
        };
    }
}

export default new GroqProvider();
