import 'dotenv/config';
import assert from 'node:assert/strict';
import { bootstrapHarness, ensureHarnessStaffEventsTable } from '../../scripts/harness';
import { createFirstPartyIranti } from '../../src/lib/createFirstPartyIranti';
import { disconnectDb } from '../../src/library/client';
import { querySessionLedger, summarizeMemoryAttribution } from '../../src/lib/sessionLedger';
import { resolveValidationDatabaseUrl } from '../helpers/resolveValidationDatabase';

function uniqueId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

async function main(): Promise<void> {
    process.env.LLM_PROVIDER = 'mock';
    const connectionString = await resolveValidationDatabaseUrl('memory attribution tests');
    bootstrapHarness({
        requireDb: true,
        forceLocalEscalationDir: true,
        dbApplicationName: 'iranti:test:memory_attribution',
    });
    await ensureHarnessStaffEventsTable();

    const iranti = createFirstPartyIranti({
        connectionString,
        llmProvider: 'mock',
        sessionLedgerSource: 'test',
        sessionLedgerHost: 'memory_attribution',
    });

    const agentId = uniqueId('memory_attr_agent');
    const projectEntity = `project/${uniqueId('memory_attr_project')}`;

    try {
        await iranti.registerAgent({
            agentId,
            name: 'Memory Attribution Test Agent',
            description: 'Validates injection ids, injected fact ids, and scored memory effects.',
            capabilities: ['attend', 'write', 'checkpoint'],
            model: 'mock',
        });

        await iranti.write({
            entity: projectEntity,
            key: 'next_step',
            value: { instruction: 'rerun the failing runtime validation.' },
            summary: 'Next step is rerun the failing runtime validation.',
            confidence: 96,
            source: 'memory_attribution_seed',
            agent: agentId,
        });
        await iranti.write({
            entity: projectEntity,
            key: 'blockers',
            value: { items: ['Need to preserve docs/runtime-verification.md.'] },
            summary: 'Blocker: preserve docs/runtime-verification.md while fixing the runtime validation.',
            confidence: 94,
            source: 'memory_attribution_seed',
            agent: agentId,
        });

        const injectedAttend = await iranti.attend({
            agentId,
            latestMessage: 'What should I do next on this runtime validation task?',
            currentContext: 'We are resuming a runtime validation task.',
            entityHints: [projectEntity],
            maxFacts: 5,
            phase: 'pre-response',
        });

        assert.equal(injectedAttend.shouldInject, true, 'Expected pre-response attend to inject project memory.');
        assert.ok(injectedAttend.memoryAttributions?.[0]?.injectionId, 'Expected an injection id for surfaced memory.');
        assert.ok(
            injectedAttend.facts.every((fact) => typeof fact.knowledgeEntryId === 'number'),
            'Expected injected facts to preserve durable knowledge entry ids.',
        );

        await iranti.checkpoint({
            agentId,
            task: 'Close the runtime validation recovery turn.',
            recentMessages: [
                'Recovered the next step from memory.',
                'Preserving the shared blocker and file-state breadcrumbs.',
            ],
            checkpoint: {
                currentStep: 'recovering next step and blocker from injected memory',
                nextStep: 'rerun the failing runtime validation',
                openRisks: ['Need to preserve docs/runtime-verification.md.'],
                entityTargets: [projectEntity],
            },
        });

        const scoredAttend = await iranti.attend({
            agentId,
            latestMessage: 'The next step is rerun the failing runtime validation, and the blocker is preserving docs/runtime-verification.md.',
            currentContext: 'Closing the response after using the injected project memory.',
            entityHints: [projectEntity],
            phase: 'post-response',
        });

        const scoredAttribution = scoredAttend.memoryAttributions?.find(
            (entry) => entry.injectionId === injectedAttend.memoryAttributions?.[0]?.injectionId,
        );
        assert.ok(scoredAttribution, 'Expected post-response attend to score the earlier injection.');
        assert.equal(scoredAttribution?.status, 'scored');
        assert.equal(scoredAttribution?.surfaced, true);
        assert.equal(scoredAttribution?.used, true);
        assert.equal(scoredAttribution?.helpful, true);
        assert.equal(scoredAttend.compliance.status, 'healthy');
        assert.ok(
            scoredAttribution?.evidenceKinds.includes('checkpoint'),
            'Expected checkpoint evidence to be attached to the scored injection.',
        );

        const attributionSummary = await summarizeMemoryAttribution({ agentId, limit: 50 });
        const scoredSummary = attributionSummary.find((entry) => entry.injectionId === scoredAttribution?.injectionId);
        assert.ok(scoredSummary, 'Expected summarizeMemoryAttribution() to return the scored injection.');
        assert.equal(scoredSummary?.used, true);
        assert.equal(scoredSummary?.helpful, true);
        assert.ok(
            (scoredSummary?.injectedEntryIds.length ?? 0) >= 1,
            'Expected attribution summary to preserve injected knowledge entry ids.',
        );

        const surfacedOnlyAttend = await iranti.attend({
            agentId,
            latestMessage: 'What should I do next on this runtime validation task?',
            currentContext: 'Start another turn, but do not use the memory in the answer.',
            entityHints: [projectEntity],
            maxFacts: 5,
            phase: 'pre-response',
        });
        assert.equal(surfacedOnlyAttend.shouldInject, true, 'Expected a second injection for surfaced-only scoring.');

        const surfacedOnlyClose = await iranti.attend({
            agentId,
            latestMessage: 'I will investigate manually and respond later.',
            currentContext: 'Closing a turn where memory was surfaced but not used.',
            entityHints: [projectEntity],
            phase: 'post-response',
        });

        const surfacedOnlyScore = surfacedOnlyClose.memoryAttributions?.find(
            (entry) => entry.injectionId === surfacedOnlyAttend.memoryAttributions?.[0]?.injectionId,
        );
        assert.ok(surfacedOnlyScore, 'Expected the surfaced-only injection to be scored.');
        assert.equal(surfacedOnlyScore?.used, false);
        assert.equal(surfacedOnlyScore?.helpful, false);
        assert.equal(surfacedOnlyClose.compliance.status, 'degraded');
        assert.ok(
            surfacedOnlyClose.compliance.issues.some((issue) => issue.code === 'ignored_injected_memory'),
            'Expected unused injected memory to become a compliance issue.',
        );
        assert.match(
            surfacedOnlyClose.complianceWarning ?? '',
            /injected memory was surfaced but not used/i,
        );

        const ledgerEvents = await querySessionLedger({ agentId, limit: 100 });
        assert.ok(
            ledgerEvents.some((event) => event.actionType === 'memory_injected' && event.metadata?.injectionId === injectedAttend.memoryAttributions?.[0]?.injectionId),
            'Expected the ledger to persist the injection id on memory_injected events.',
        );
        assert.ok(
            ledgerEvents.some((event) => event.actionType === 'memory_injection_scored' && event.metadata?.injectionId === injectedAttend.memoryAttributions?.[0]?.injectionId),
            'Expected the ledger to persist scored attribution events.',
        );

        console.log('memory attribution tests passed');
    } finally {
        await disconnectDb().catch(() => undefined);
    }
}

void main().catch((error) => {
    console.error('memory attribution tests failed:', error);
    process.exitCode = 1;
});
