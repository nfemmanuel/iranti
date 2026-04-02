import assert from 'node:assert/strict';
import { Iranti } from '../../src/sdk';
import { autoRememberPromptFacts, USER_PROMPT_AUTO_REMEMBER_SOURCE } from '../../src/lib/autoRemember';
import { findEntry } from '../../src/library/queries';

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
        const correctedPromptEntry = await findEntry({
            entityType: 'user',
            entityId: personalEntity.split('/')[1]!,
            key: 'favorite_book',
        });
        assert.ok(correctedPromptEntry, 'Expected corrected personal fact entry to exist in the knowledge base.');
        const correctedPromptProperties = correctedPromptEntry.properties as Record<string, unknown>;
        assert.equal(correctedPromptProperties.semanticDomain, 'personal');
        assert.equal(correctedPromptProperties.semanticIntent, 'preference_capture');
        assert.equal(correctedPromptProperties.temporalScope, 'long_term');
        assert.deepEqual(correctedPromptProperties.semanticTags, ['personal_memory', 'preference', 'identity', 'singleton_fact']);

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

        await autoRememberPromptFacts({
            iranti,
            prompt: 'The current step is audit the lifecycle and retrieval paths.',
            agent: agentId,
            source: 'ClaudeCodeHook',
        });

        await autoRememberPromptFacts({
            iranti,
            prompt: 'Open risks are stale runtime metadata and duplicate instance state.',
            agent: agentId,
            source: 'ClaudeCodeHook',
        });

        await autoRememberPromptFacts({
            iranti,
            prompt: 'Open risks are stale runtime metadata and host discipline drift.',
            agent: agentId,
            source: 'ClaudeCodeHook',
        });

        await autoRememberPromptFacts({
            iranti,
            prompt: 'Important artifacts are docs/guides/codex.md and docs/guides/claude-code.md.',
            agent: agentId,
            source: 'ClaudeCodeHook',
        });

        await autoRememberPromptFacts({
            iranti,
            prompt: 'Failed path is relying on stale control plane status.',
            agent: agentId,
            source: 'ClaudeCodeHook',
        });

        await autoRememberPromptFacts({
            iranti,
            prompt: 'Alternative route is force a live status probe.',
            agent: agentId,
            source: 'ClaudeCodeHook',
        });

        await autoRememberPromptFacts({
            iranti,
            prompt: 'File created docs/internal/runtime-audit.md for release notes.',
            agent: agentId,
            source: 'ClaudeCodeHook',
        });

        const currentStepFact = await iranti.query(projectEntity, 'current_step');
        assert.equal(currentStepFact.found, true, 'Expected current_step to be persisted as project memory.');
        assert.deepEqual(currentStepFact.value, { text: 'audit the lifecycle and retrieval paths.' });

        const openRisksFact = await iranti.query(projectEntity, 'open_risks');
        assert.equal(openRisksFact.found, true, 'Expected open_risks to be persisted.');
        assert.deepEqual(openRisksFact.value, {
            items: [
                'stale runtime metadata',
                'duplicate instance state.',
                'host discipline drift.',
            ],
        });

        const artifactsFact = await iranti.query(projectEntity, 'important_artifacts');
        assert.equal(artifactsFact.found, true, 'Expected important_artifacts to be persisted.');
        assert.deepEqual(artifactsFact.value, {
            items: ['docs/guides/codex.md', 'docs/guides/claude-code.md.'],
        });

        const fileChangeFact = await iranti.query(projectEntity, 'recent_file_changes');
        assert.equal(fileChangeFact.found, true, 'Expected recent_file_changes to be persisted.');
        assert.deepEqual(fileChangeFact.value, {
            items: [
                {
                    action: 'created',
                    path: 'docs/internal/runtime-audit.md',
                    purpose: 'release notes.',
                },
            ],
        });

        const checkpointedBrief = await iranti.checkpoint({
            agentId,
            task: 'Validate checkpoint durability without explicit recentMessages.',
            checkpoint: {
                currentStep: 'verifying checkpoint fallback when recent messages are omitted',
                nextStep: 'continue the lifecycle validation suite',
                openRisks: ['checkpoint helper should not require recentMessages'],
                entityTargets: [projectEntity],
            },
        } as any);
        assert.equal(checkpointedBrief.sessionCheckpoint?.status, 'active', 'Expected checkpoint() without recentMessages to succeed.');

        const checkpointSummary = await iranti.query(projectEntity, 'checkpoint_summary');
        assert.equal(checkpointSummary.found, true, 'Expected checkpoint_summary breadcrumb to be persisted even without recentMessages.');

        const openRisksEntry = await findEntry({
            entityType: 'project',
            entityId: projectEntity.split('/')[1]!,
            key: 'open_risks',
        });
        assert.ok(openRisksEntry, 'Expected open_risks entry to exist in the knowledge base.');
        const openRisksProperties = openRisksEntry.properties as Record<string, unknown>;
        assert.equal(openRisksProperties.memoryScope, 'project');
        assert.equal(openRisksProperties.capturePhase, 'user_prompt');
        assert.equal(openRisksProperties.durableClass, 'open_risks');
        assert.equal(openRisksProperties.canonicalKey, 'open_risks');
        assert.equal(openRisksProperties.mergeStrategy, 'append_dedupe');
        assert.equal(openRisksProperties.semanticDomain, 'risk');
        assert.equal(openRisksProperties.semanticIntent, 'risk_tracking');
        assert.equal(openRisksProperties.temporalScope, 'active_work');
        assert.deepEqual(openRisksProperties.semanticTags, ['project_memory', 'risk', 'tracking', 'list_fact']);

        const fileChangeEntry = await findEntry({
            entityType: 'project',
            entityId: projectEntity.split('/')[1]!,
            key: 'recent_file_changes',
        });
        assert.ok(fileChangeEntry, 'Expected recent_file_changes entry to exist in the knowledge base.');
        const fileChangeProperties = fileChangeEntry.properties as Record<string, unknown>;
        assert.equal(fileChangeProperties.memoryScope, 'project');
        assert.equal(fileChangeProperties.capturePhase, 'user_prompt');
        assert.equal(fileChangeProperties.durableClass, 'file_change');
        assert.equal(fileChangeProperties.canonicalKey, 'recent_file_changes');
        assert.equal(fileChangeProperties.mergeStrategy, 'append_dedupe');
        assert.equal(fileChangeProperties.semanticDomain, 'artifact');
        assert.equal(fileChangeProperties.semanticIntent, 'change_tracking');
        assert.equal(fileChangeProperties.temporalScope, 'active_work');
        assert.deepEqual(fileChangeProperties.semanticTags, ['project_memory', 'artifact', 'file_change', 'tracking', 'list_fact']);

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
