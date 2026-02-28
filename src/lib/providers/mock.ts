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

        // Simulate chunking / fact extraction
        if (lastMessage.includes('extract every distinct') || lastMessage.includes('atomic facts')) {
            return {
                text: '[{"key":"affiliation","value":{"institution":"Carnegie Mellon University"},"summary":"Affiliated with Carnegie Mellon University"},{"key":"publication_count","value":{"count":31},"summary":"Has published 31 papers"},{"key":"previous_employer","value":{"institution":"Google DeepMind","from":2019,"to":2022},"summary":"Previously worked at Google DeepMind from 2019 to 2022"},{"key":"research_focus","value":{"primary":"reinforcement learning","secondary":"robotics"},"summary":"Primary research focus is reinforcement learning with secondary interest in robotics"}]',
                model: 'mock',
                provider: 'mock',
            };
        }

        // Simulate conflict resolution reasoning
        if (lastMessage.includes('keep_existing') || lastMessage.includes('genuinely contradictory')) {
            return {
                text: 'KEEP_EXISTING: The existing entry has a more established source and the confidence difference is minimal.',
                model: 'mock',
                provider: 'mock',
            };
        }

        // Simulate conflict resolution
        if (lastMessage.includes('conflict') || lastMessage.includes('contradict')) {
            return {
                text: 'KEEP_EXISTING: The existing entry has a more established source and the confidence difference is minimal.',
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