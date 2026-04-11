/**
 * Ollama LLM provider for Iranti.
 *
 * Implements the LLMProvider interface for locally-served Ollama models. Useful
 * for fully offline / air-gapped deployments or development without API keys.
 * Calls Ollama's /api/chat endpoint with streaming disabled.
 *
 * Configuration env vars:
 *   OLLAMA_MODEL     — default model (default: llama3.2)
 *   OLLAMA_BASE_URL  — Ollama server URL (default: http://localhost:11434)
 */

import { LLMProvider, LLMMessage, LLMResponse, CompleteOptions } from '../llm';

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

    async complete(messages: LLMMessage[], options?: CompleteOptions): Promise<LLMResponse> {
        const maxTokens = options?.maxTokens ?? 1024;
        const model = options?.model ?? this.model;
        const response = await fetch(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
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
