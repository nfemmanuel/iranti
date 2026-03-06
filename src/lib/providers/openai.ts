import { LLMProvider, LLMMessage, LLMResponse, CompleteOptions } from '../llm';

interface OpenAIChatResponse {
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
        this.model = process.env.OPENAI_MODEL ?? 'gpt-5-mini';
        this.baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';

        if (!this.apiKey) {
            throw new Error('OPENAI_API_KEY is not set');
        }
    }

    private shouldUseResponsesApi(model: string): boolean {
        const m = model.toLowerCase();
        return m.startsWith('gpt-5') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4');
    }

    private formatResponsesInput(messages: LLMMessage[]) {
        return messages.map((m) => ({
            role: m.role,
            content: [
                {
                    type: m.role === 'assistant' ? 'output_text' : 'input_text',
                    text: m.content,
                },
            ],
        }));
    }

    private extractResponsesText(data: any): string {
        if (typeof data?.output_text === 'string' && data.output_text.length > 0) {
            return data.output_text;
        }

        const chunks: string[] = [];
        const outputs = Array.isArray(data?.output) ? data.output : [];
        for (const out of outputs) {
            const content = Array.isArray(out?.content) ? out.content : [];
            for (const item of content) {
                if (typeof item?.text === 'string' && (item.type === 'output_text' || item.type === 'text')) {
                    chunks.push(item.text);
                }
            }
        }
        return chunks.join('\n').trim();
    }

    private async parseErrorResponse(response: Response): Promise<never> {
        const raw = await response.text();
        const body = raw && raw.length > 0 ? ` - ${raw.slice(0, 600)}` : '';
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}${body}`);
    }

    async complete(messages: LLMMessage[], options?: CompleteOptions): Promise<LLMResponse> {
        const model = options?.model ?? this.model;
        const useResponsesApi = this.shouldUseResponsesApi(model);
        const endpoint = useResponsesApi ? '/responses' : '/chat/completions';
        const payload = useResponsesApi
            ? {
                model,
                input: this.formatResponsesInput(messages),
                max_output_tokens: options?.maxTokens ?? 1024,
            }
            : {
                model,
                messages: messages.map((m) => ({ role: m.role, content: m.content })),
                max_tokens: options?.maxTokens ?? 1024,
            };

        const response = await fetch(`${this.baseUrl}${endpoint}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            await this.parseErrorResponse(response);
        }

        const data = await response.json() as OpenAIChatResponse | any;
        const text = useResponsesApi
            ? this.extractResponsesText(data)
            : (data as OpenAIChatResponse).choices[0]?.message?.content ?? '';

        return {
            text,
            model,
            provider: 'openai',
        };
    }
}

export default new OpenAIProvider();
