import 'dotenv/config';

// Temporarily override to a provider that will definitely fail
process.env.LLM_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'invalid_key_to_force_failure';
process.env.LLM_PROVIDER_FALLBACK = 'groq,mock';
process.env.GROQ_API_KEY = 'invalid_key_to_force_failure';

import { complete } from '../src/lib/llm';

async function test() {
    console.log('Testing fallback switching...\n');
    console.log('Chain: openai (invalid key) → groq (invalid key) → mock\n');

    const response = await complete([
        {
            role: 'user',
            content: 'What specific type of task is this agent performing: analyzing data',
        },
    ], 256);

    console.log('Response received from:', (response as any).providerUsed);
    console.log('Text:', response.text);
    console.log('\n✓ Fallback chain working correctly');

    process.exit(0);
}

test().catch((err) => {
    console.error('Fallback test failed:', err);
    process.exit(1);
});
