import assert from 'node:assert/strict';
import { Iranti } from '../../src/sdk';
import { autoRememberPromptFacts, USER_PROMPT_AUTO_REMEMBER_SOURCE } from '../../src/lib/autoRemember';

function uniqueId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

async function main(): Promise<void> {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error('DATABASE_URL is required for memory lifecycle tests.');
    }

    process.env.LLM_PROVIDER = process.env.LLM_PROVIDER || 'mock';

    const iranti = new Iranti({ connectionString, llmProvider: process.env.LLM_PROVIDER });
    const priorMemoryEntity = process.env.IRANTI_MEMORY_ENTITY;
    const priorPersonalMemoryEntity = process.env.IRANTI_PERSONAL_MEMORY_ENTITY;
    const priorAutoRemember = process.env.IRANTI_AUTO_REMEMBER;

    const agentId = uniqueId('memory_lifecycle_agent');
    await iranti.registerAgent({
        agentId,
        name: 'Memory Lifecycle Agent',
        description: 'Covers mandatory recall and direct user correction behavior.',
        capabilities: ['query', 'observe', 'attend', 'write'],
        model: 'mock',
    });

    try {
        const projectEntity = `project/${uniqueId('lifecycle_project')}`;
        const personalEntity = `user/${uniqueId('lifecycle_user')}`;
        const explicitCorrectionEntity = `user/${uniqueId('explicit_correction_user')}`;

        process.env.IRANTI_MEMORY_ENTITY = projectEntity;
        process.env.IRANTI_PERSONAL_MEMORY_ENTITY = personalEntity;
        process.env.IRANTI_AUTO_REMEMBER = 'true';

        await iranti.write({
            entity: projectEntity,
            key: 'next_step',
            value: { instruction: 'rerun the db validation.' },
            summary: 'next step is rerun the db validation.',
            confidence: 91,
            source: 'memory_lifecycle_seed',
            agent: agentId,
        });

        const nextStepAttend = await iranti.attend({
            agentId,
            currentContext: '',
            latestMessage: 'What is the next step?',
            maxFacts: 5,
        });

        assert.equal(nextStepAttend.shouldInject, true, 'Expected next-step recall prompts to force memory injection.');
        assert.equal(nextStepAttend.decision.explanation, 'project_next_step_recall');
        assert.ok(
            nextStepAttend.facts.some((fact: { entityKey: string }) => fact.entityKey === `${projectEntity}/next_step`),
            'Expected mandatory next-step recall to surface the project next_step fact.'
        );

        await iranti.write({
            entity: personalEntity,
            key: 'favorite_book',
            value: { text: 'the left hand of darkness' },
            summary: 'favorite book is the left hand of darkness',
            confidence: 96,
            source: 'ClaudeCodeHook',
            agent: agentId,
        });

        const promptRemember = await autoRememberPromptFacts({
            iranti,
            prompt: 'Actually, my favorite book is Half of a Yellow Sun.',
            agent: agentId,
            source: 'ClaudeCodeHook',
        });

        assert.equal(promptRemember.written, 1, 'Expected prompt auto-remember correction to persist one updated fact.');

        const correctedPromptFact = await iranti.query(personalEntity, 'favorite_book');
        assert.equal(correctedPromptFact.found, true, 'Expected corrected personal fact to remain queryable.');
        assert.deepEqual(correctedPromptFact.value, { text: 'half of a yellow sun.' });
        assert.equal(correctedPromptFact.source, USER_PROMPT_AUTO_REMEMBER_SOURCE);

        await iranti.write({
            entity: explicitCorrectionEntity,
            key: 'favorite_book',
            value: { text: 'the left hand of darkness' },
            summary: 'favorite book is the left hand of darkness',
            confidence: 96,
            source: 'ClaudeCodeHook',
            agent: agentId,
        });

        const explicitCorrection = await iranti.write({
            entity: explicitCorrectionEntity,
            key: 'favorite_book',
            value: { text: 'half of a yellow sun' },
            summary: 'favorite book is half of a yellow sun',
            confidence: 90,
            source: 'user_stated',
            agent: agentId,
        });

        assert.equal(explicitCorrection.action, 'updated', 'Expected direct user correction to override prior hook-written personal fact.');

        const correctedExplicitFact = await iranti.query(explicitCorrectionEntity, 'favorite_book');
        assert.equal(correctedExplicitFact.found, true, 'Expected explicit user correction fact to remain queryable.');
        assert.deepEqual(correctedExplicitFact.value, { text: 'half of a yellow sun' });
        assert.equal(correctedExplicitFact.source, 'user_stated');

        console.log('memory lifecycle tests passed');
    } finally {
        if (priorMemoryEntity === undefined) {
            delete process.env.IRANTI_MEMORY_ENTITY;
        } else {
            process.env.IRANTI_MEMORY_ENTITY = priorMemoryEntity;
        }

        if (priorPersonalMemoryEntity === undefined) {
            delete process.env.IRANTI_PERSONAL_MEMORY_ENTITY;
        } else {
            process.env.IRANTI_PERSONAL_MEMORY_ENTITY = priorPersonalMemoryEntity;
        }

        if (priorAutoRemember === undefined) {
            delete process.env.IRANTI_AUTO_REMEMBER;
        } else {
            process.env.IRANTI_AUTO_REMEMBER = priorAutoRemember;
        }
    }
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
