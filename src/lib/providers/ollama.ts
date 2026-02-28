import { LLMProvider, LLMMessage, LLMResponse } from '../llm';

interface OllamaResponse {
    message: {
        content: string;
    };
    model: string;
}

class OllamaProvider implements LLMProvider {
    private model: string;
    private baseUrl: string;

    constructor() {
        this.model = process.env.OLLAMA_MODEL ?? 'llama3.2';
        this.baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
    }

    async complete(messages: LLMMessage[], maxTokens: number = 1024): Promise<LLMResponse> {
        const response = await fetch(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: this.model,
                messages: messages.map((m) => ({ role: m.role, content: m.content })),
                stream: false,
                options: {
                    num_predict: maxTokens,
                },
            }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Ollama error ${response.status}: ${error}. Is Ollama running at ${this.baseUrl}?`);
        }

        const data = await response.json() as OllamaResponse;
        const text = data.message?.content ?? '';

        return {
            text,
            model: data.model,
            provider: 'ollama',
        };
    }
}

export default new OllamaProvider();
