import { LLMProvider, LLMMessage, LLMResponse, CompleteOptions, normalizeProviderCaughtError } from '../llm';
import Anthropic from '@anthropic-ai/sdk';

class ClaudeProvider implements LLMProvider {
    private client: Anthropic;
    private model: string;

    constructor() {
        const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
        if (!apiKey) {
            throw new Error('ANTHROPIC_API_KEY is not set');
        }

        this.model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4';
        const baseURL = process.env.ANTHROPIC_BASE_URL?.trim();
        this.client = new Anthropic({
            apiKey,
            ...(baseURL ? { baseURL } : {}),
        });
    }

    async complete(messages: LLMMessage[], options?: CompleteOptions): Promise<LLMResponse> {
        const model = options?.model ?? this.model;
        const maxTokens = options?.maxTokens ?? 1024;
        const claudeMessages = messages.map((message) => ({
            role: message.role,
            content: message.content,
        }));

        let response;
        try {
            response = await this.client.messages.create({
                model,
                max_tokens: maxTokens,
                messages: claudeMessages,
            });
        } catch (error) {
            throw normalizeProviderCaughtError('claude', error);
        }

        const text = response.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n')
            .trim();

        return {
            text,
            model,
            provider: 'claude',
        };
    }
}

export default new ClaudeProvider();
