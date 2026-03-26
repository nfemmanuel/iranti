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
