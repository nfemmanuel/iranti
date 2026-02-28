import { LLMProvider, LLMMessage, LLMResponse } from '../llm';

class ClaudeProvider implements LLMProvider {
    async complete(_messages: LLMMessage[], _maxTokens: number = 512): Promise<LLMResponse> {
        throw new Error('Claude provider not yet configured. Set LLM_PROVIDER=gemini or add ANTHROPIC_API_KEY.');
    }
}

export default new ClaudeProvider();