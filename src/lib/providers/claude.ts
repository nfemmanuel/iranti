import { LLMProvider, LLMMessage, LLMResponse, CompleteOptions } from '../llm';

class ClaudeProvider implements LLMProvider {
    async complete(_messages: LLMMessage[], options?: CompleteOptions): Promise<LLMResponse> {
        throw new Error('Claude provider not yet configured. Set LLM_PROVIDER=gemini or add ANTHROPIC_API_KEY.');
    }
}

export default new ClaudeProvider();
