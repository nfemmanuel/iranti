import { LLMProvider, LLMMessage, LLMResponse } from '../llm';

// ─── Mock Provider ───────────────────────────────────────────────────────────
// Simulates LLM responses for local development and testing.
// Swap to a real provider by changing LLM_PROVIDER in .env.

class MockProvider implements LLMProvider {
    async complete(messages: LLMMessage[], _maxTokens?: number): Promise<LLMResponse> {
        const lastMessage = messages[messages.length - 1].content.toLowerCase();

        // Simulate task inference
        if (lastMessage.includes('specific type of task')) {
            return {
                text: 'Researching academic publication history for a researcher',
                model: 'mock',
                provider: 'mock',
            };
        }

        // Simulate relevance filtering
        if (lastMessage.includes('directly relevant')) {
            return {
                text: 'none',
                model: 'mock',
                provider: 'mock',
            };
        }

        // Simulate conflict resolution
        if (lastMessage.includes('conflict') || lastMessage.includes('contradict')) {
            return {
                text: 'Keep the existing entry — it has a more authoritative source.',
                model: 'mock',
                provider: 'mock',
            };
        }

        // Default
        return {
            text: 'Mock response.',
            model: 'mock',
            provider: 'mock',
        };
    }
}

export default new MockProvider();