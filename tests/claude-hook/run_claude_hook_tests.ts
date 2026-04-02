import assert from 'node:assert/strict';
import { buildHookAdditionalContext } from '../../scripts/claude-code-memory-hook';

function uniqueId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

async function main(): Promise<void> {
    const priorAgentId = process.env.IRANTI_CLAUDE_AGENT_ID;
    const priorMemoryEntity = process.env.IRANTI_MEMORY_ENTITY;
    const priorPersonalMemoryEntity = process.env.IRANTI_PERSONAL_MEMORY_ENTITY;
    const priorAutoRemember = process.env.IRANTI_AUTO_REMEMBER;

    const agentId = uniqueId('claude_hook_agent');
    const memoryEntity = `project/${uniqueId('claude_hook_project')}`;
    const personalMemoryEntity = `user/${uniqueId('claude_hook_user')}`;
    const factSummary = 'Deployment mode is isolated runtime.';

    process.env.IRANTI_CLAUDE_AGENT_ID = agentId;
    process.env.IRANTI_MEMORY_ENTITY = memoryEntity;
    process.env.IRANTI_PERSONAL_MEMORY_ENTITY = personalMemoryEntity;

    const calls: string[] = [];
    const queryValues = new Map<string, unknown>();
    const fakeIranti = {
        async registerAgent(input: { agentId: string }): Promise<void> {
            calls.push(`register:${input.agentId}`);
        },
        async query(entity: string, key: string): Promise<{ found: boolean; value?: unknown }> {
            calls.push(`query:${entity}:${key}`);
            const identity = `${entity}:${key}`;
            if (!queryValues.has(identity)) {
                return { found: false };
            }
            return { found: true, value: queryValues.get(identity) };
        },
        async write(input: { entity: string; key: string; value: unknown; summary: string }): Promise<void> {
            calls.push(`write:${input.entity}:${input.key}:${input.summary}`);
            queryValues.set(`${input.entity}:${input.key}`, input.value);
        },
        async checkpoint(input: {
            agent?: string;
            task: string;
            recentMessages: string[];
            checkpoint: {
                currentStep?: string;
                nextStep?: string;
                openRisks?: string[];
                recentOutputs?: string[];
                actions?: Array<{
                    kind: string;
                    summary: string;
                    status?: string;
                    target?: string;
                    detail?: string;
                }>;
                fileChanges?: Array<{
                    action: string;
                    path: string;
                    toPath?: string;
                    purpose?: string;
                }>;
                entityTargets?: string[];
            };
        }): Promise<void> {
            calls.push(`checkpoint:${input.agent}:${input.task}:${(input.checkpoint.entityTargets ?? []).join(',')}:${input.checkpoint.currentStep ?? ''}:${input.checkpoint.nextStep ?? ''}`);
            for (const entity of input.checkpoint.entityTargets ?? []) {
                if (input.checkpoint.currentStep) {
                    queryValues.set(`${entity}:checkpoint_current_step`, { text: input.checkpoint.currentStep });
                }
                if (input.checkpoint.nextStep) {
                    queryValues.set(`${entity}:checkpoint_next_step`, { text: input.checkpoint.nextStep });
                }
                if (input.checkpoint.openRisks && input.checkpoint.openRisks.length > 0) {
                    queryValues.set(`${entity}:checkpoint_open_risks`, { items: input.checkpoint.openRisks });
                }
                if (input.checkpoint.fileChanges && input.checkpoint.fileChanges.length > 0) {
                    queryValues.set(`${entity}:recent_file_changes`, { items: input.checkpoint.fileChanges });
                }
                if (input.checkpoint.actions && input.checkpoint.actions.length > 0) {
                    queryValues.set(`${entity}:recent_actions`, { items: input.checkpoint.actions });
                }
            }
        },
        async handshake(input: { agent?: string; task: string; recentMessages: string[] }) {
            calls.push(`handshake:${input.agent}:${input.task}`);
            return {
                agentId: input.agent,
                operatingRules: 'Use durable memory carefully.',
                inferredTaskType: 'project_work',
                workingMemory: [{
                    entityKey: `${memoryEntity}/deployment_mode`,
                    summary: factSummary,
                    confidence: 92,
                    source: 'claude_hook_test',
                }],
                sessionStarted: new Date().toISOString(),
                briefGeneratedAt: new Date().toISOString(),
                contextCallCount: 0,
                sessionCheckpoint: null,
                sessionRecovery: null,
            };
        },
        async attend(input: { agent?: string; latestMessage: string; currentContext: string; entityHints?: string[] }) {
            calls.push(`attend:${input.agent}:${input.latestMessage}`);
            if (/favorite movie/i.test(input.latestMessage)) {
                return {
                    shouldInject: true,
                    reason: 'memory_needed_injected',
                    decision: { needed: true },
                    facts: [
                        {
                            entityKey: `${personalMemoryEntity}/favorite_movie`,
                            summary: 'favorite movie is zebra asteroid midnight',
                            value: { text: 'zebra asteroid midnight' },
                            confidence: 96,
                            source: 'claude_hook_test',
                        },
                    ],
                    entitiesDetected: [],
                    alreadyPresent: 0,
                    totalFound: 1,
                    entitiesResolved: input.entityHints ?? [],
                    debug: {
                        skipped: null,
                        contextLength: input.currentContext.length,
                    },
                };
            }
            return {
                shouldInject: true,
                reason: 'memory_needed_injected',
                decision: { needed: true },
                facts: [{
                    entityKey: `${memoryEntity}/deployment_mode`,
                    summary: factSummary,
                    value: { mode: 'isolated_runtime' },
                    confidence: 92,
                    source: 'claude_hook_test',
                }],
                entitiesDetected: [],
                alreadyPresent: 0,
                totalFound: 1,
                entitiesResolved: input.entityHints ?? [],
                debug: {
                    skipped: null,
                    contextLength: input.currentContext.length,
                },
            };
        },
        async queryAll(): Promise<never[]> {
            throw new Error('queryAll() should not be required when handshake working memory exists.');
        },
    } as const;

    try {
        process.env.IRANTI_AUTO_REMEMBER = 'true';

        const sessionContext = await buildHookAdditionalContext({
            iranti: fakeIranti as never,
            event: 'SessionStart',
            payload: {
                cwd: process.cwd(),
                task: 'Validate Claude hook session startup memory loading.',
                recentMessages: ['Need the current deployment mode for this project.'],
            },
        });

        assert.ok(sessionContext.includes('[Iranti Session Memory]'), 'Expected SessionStart hook to emit session memory context.');
        assert.ok(sessionContext.includes(factSummary), 'Expected SessionStart hook to surface working memory facts.');
        assert.ok(calls.some((call) => call.startsWith(`handshake:${agentId}:`)), 'Expected SessionStart hook to call handshake().');

        const promptContext = await buildHookAdditionalContext({
            iranti: fakeIranti as never,
            event: 'UserPromptSubmit',
            payload: {
                cwd: process.cwd(),
                prompt: 'Remind me what we decided about the deployment mode.',
                recentMessages: ['assistant: We were discussing deployment tradeoffs.'],
            },
        });

        assert.ok(promptContext.includes('[Iranti Retrieved Memory]'), 'Expected UserPromptSubmit hook to emit retrieved memory context.');
        assert.ok(promptContext.includes(factSummary), 'Expected UserPromptSubmit hook to surface attend() facts.');
        assert.ok(
            calls.some((call) => call === `attend:${agentId}:Remind me what we decided about the deployment mode.`),
            'Expected UserPromptSubmit hook to call attend().'
        );

        const autoRememberContext = await buildHookAdditionalContext({
            iranti: fakeIranti as never,
            event: 'UserPromptSubmit',
            payload: {
                cwd: process.cwd(),
                prompt: 'My favourite snack is plantain chips.',
                recentMessages: ['assistant: Tell me something durable I should remember.'],
            },
        });

        assert.ok(autoRememberContext.includes('[Iranti Retrieved Memory]'), 'Expected declarative prompt auto-remember path to preserve retrieval injection.');
        assert.ok(
            calls.some((call) => call.startsWith(`write:${personalMemoryEntity}:favorite_snack:`)),
            'Expected opt-in auto-remember to write personal prompt memory to the personal memory entity.'
        );
        assert.ok(
            !calls.some((call) => call.startsWith(`write:${personalMemoryEntity}:favourite_snack:`)),
            'Expected favourite/favorite variants to canonicalize to favorite_snack only.'
        );

        const writesAfterFirstCapture = calls.filter((call) => call.startsWith(`write:${personalMemoryEntity}:favorite_snack:`)).length;
        await buildHookAdditionalContext({
            iranti: fakeIranti as never,
            event: 'UserPromptSubmit',
            payload: {
                cwd: process.cwd(),
                prompt: 'My favourite snack is plantain chips.',
                recentMessages: ['assistant: Repeating the same memory should not churn writes.'],
            },
        });
        const writesAfterSecondCapture = calls.filter((call) => call.startsWith(`write:${personalMemoryEntity}:favorite_snack:`)).length;
        assert.equal(writesAfterSecondCapture, writesAfterFirstCapture, 'Expected unchanged explicit prompt memory to avoid duplicate writes.');

        const conversationalAutoRememberContext = await buildHookAdditionalContext({
            iranti: fakeIranti as never,
            event: 'UserPromptSubmit',
            payload: {
                cwd: process.cwd(),
                prompt: 'Hey, so my favorite tv show is Bojack Horseman.',
                recentMessages: ['assistant: Mention another durable preference.'],
            },
        });
        assert.ok(
            conversationalAutoRememberContext.includes('[Iranti Retrieved Memory]'),
            'Expected conversational lead-ins to still preserve retrieval injection.'
        );
        assert.ok(
            calls.some((call) => call.startsWith(`write:${personalMemoryEntity}:favorite_tv_show:`)),
            'Expected conversational lead-ins to still write canonical favorite_tv_show memory.'
        );
        assert.ok(
            !calls.some((call) => call.startsWith(`write:${personalMemoryEntity}:tv_show:`)),
            'Expected favorite prompts not to also emit a duplicate tv_show fact.'
        );

        const projectCheckpointContext = await buildHookAdditionalContext({
            iranti: fakeIranti as never,
            event: 'UserPromptSubmit',
            payload: {
                cwd: process.cwd(),
                prompt: 'The current step is audit the retrieval lifecycle.',
                recentMessages: ['assistant: Capture the current checkpoint for later handoff.'],
            },
        });
        assert.equal(projectCheckpointContext, '', 'Expected project checkpoint prompt to avoid injecting unrelated memory.');
        assert.ok(
            calls.some((call) => call.startsWith(`write:${memoryEntity}:current_step:`)),
            'Expected current_step prompt memory to route to the project memory entity.'
        );

        const projectRiskContext = await buildHookAdditionalContext({
            iranti: fakeIranti as never,
            event: 'UserPromptSubmit',
            payload: {
                cwd: process.cwd(),
                prompt: 'Open risks are stale runtime metadata and duplicate instance state.',
                recentMessages: ['assistant: Capture the open risks for the shared handoff.'],
            },
        });
        assert.equal(projectRiskContext, '', 'Expected open_risks prompt to avoid injecting unrelated memory.');
        assert.ok(
            calls.some((call) => call.startsWith(`write:${memoryEntity}:open_risks:`)),
            'Expected open_risks prompt memory to route to the project memory entity.'
        );

        const stopContext = await buildHookAdditionalContext({
            iranti: fakeIranti as never,
            event: 'Stop',
            payload: {
                cwd: process.cwd(),
                last_assistant_message: 'The next step is rerun the db validation.',
            },
        });
        assert.equal(stopContext, '', 'Expected Stop hook to emit no additional context.');
        assert.ok(
            calls.some((call) => call.startsWith(`write:${memoryEntity}:next_step:`)),
            'Expected Stop hook auto-remember to persist strict assistant response facts.'
        );
        assert.ok(
            calls.some((call) => call.startsWith(`checkpoint:${agentId}:`) && call.includes(`:${memoryEntity}:`) && call.endsWith(':rerun the db validation.')),
            'Expected Stop hook to also persist a shared checkpoint for resumable project progress.'
        );

        const fileStopContext = await buildHookAdditionalContext({
            iranti: fakeIranti as never,
            event: 'Stop',
            payload: {
                cwd: process.cwd(),
                last_assistant_message: 'File created docs/runtime-verification.md for rollout notes.',
            },
        });
        assert.equal(fileStopContext, '', 'Expected Stop hook file-change persistence to emit no additional context.');
        assert.deepEqual(
            queryValues.get(`${memoryEntity}:recent_file_changes`),
            {
                items: [
                    {
                        action: 'created',
                        path: 'docs/runtime-verification.md',
                        purpose: 'rollout notes.',
                    },
                ],
            },
            'Expected Stop hook checkpointing to preserve structured file changes.'
        );

        const actionStopContext = await buildHookAdditionalContext({
            iranti: fakeIranti as never,
            event: 'Stop',
            payload: {
                cwd: process.cwd(),
                last_assistant_message: 'Validation passed runtime lifecycle smoke.',
            },
        });
        assert.equal(actionStopContext, '', 'Expected Stop hook action persistence to emit no additional context.');
        assert.deepEqual(
            queryValues.get(`${memoryEntity}:recent_actions`),
            {
                items: [
                    {
                        kind: 'validation',
                        summary: 'passed runtime lifecycle smoke.',
                        status: 'passed',
                        target: 'runtime lifecycle smoke.',
                    },
                ],
            },
            'Expected Stop hook checkpointing to preserve structured recent actions.'
        );

        const retrievalAnswerContext = await buildHookAdditionalContext({
            iranti: fakeIranti as never,
            event: 'UserPromptSubmit',
            payload: {
                cwd: process.cwd(),
                prompt: 'What is my favorite movie?',
                recentMessages: [],
            },
        });
        assert.ok(
            retrievalAnswerContext.includes('Direct answer: favorite movie is zebra asteroid midnight.'),
            'Expected self-memory question injection to include a direct answer candidate.'
        );
        assert.ok(
            !retrievalAnswerContext.includes('/favourite_movie:'),
            'Expected favourite_movie duplicate facts to be suppressed from injected context.'
        );

        console.log('Claude hook tests passed.');
    } finally {
        if (priorAgentId === undefined) {
            delete process.env.IRANTI_CLAUDE_AGENT_ID;
        } else {
            process.env.IRANTI_CLAUDE_AGENT_ID = priorAgentId;
        }

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

main().catch((error) => {
    console.error('Claude hook tests failed:', error);
    process.exit(1);
});
