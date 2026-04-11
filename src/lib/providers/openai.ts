/**
 * OpenAI LLM provider for Iranti.
 *
 * Implements the LLMProvider interface for OpenAI models. Automatically selects
 * between the Chat Completions API (legacy models) and the Responses API
 * (GPT-5+, o1, o3, o4) based on the requested model name.
 *
 * Configuration env vars:
 *   OPENAI_API_KEY   — required
 *   OPENAI_MODEL     — default model (default: gpt-5-mini)
 *   OPENAI_BASE_URL  — override endpoint for custom deployments (default: https://api.openai.com/v1)
 */

import { LLMProvider, LLMMessage, LLMResponse, CompleteOptions, normalizeProviderApiError } from '../llm';

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

    private extractResponsesText(data: unknown): string {
        const record = data as Record<string, unknown>;
        if (typeof record?.output_text === 'string' && (record.output_text as string).length > 0) {
            return record.output_text as string;
        }

        const chunks: string[] = [];
        const outputs = Array.isArray(record?.output) ? (record.output as unknown[]) : [];
        for (const out of outputs) {
            const outRecord = out as Record<string, unknown>;
            const content = Array.isArray(outRecord?.content) ? (outRecord.content as unknown[]) : [];
            for (const item of content) {
                const itemRecord = item as Record<string, unknown>;
                if (typeof itemRecord?.text === 'string' && (itemRecord.type === 'output_text' || itemRecord.type === 'text')) {
                    chunks.push(itemRecord.text as string);
                }
            }
        }
        return chunks.join('\n').trim();
    }

    private async parseErrorResponse(response: Response): Promise<never> {
        const raw = await response.text();
        throw normalizeProviderApiError('openai', response.status, response.statusText, raw);
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

        const data = await response.json() as unknown;
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
