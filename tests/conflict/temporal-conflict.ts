import { BenchmarkSuite, expect } from './common';

export const temporalConflictSuite: BenchmarkSuite = {
    label: 'Temporal conflict',
    cases: [
        {
            name: 'older more reliable fact beats weaker newer contradiction',
            expectation: 'pass',
            async run({ iranti, entity }) {
                const target = entity('project', 'cinder_trace');

                await iranti.write({
                    entity: target,
                    key: 'budget',
                    value: { amount: 50000 },
                    summary: 'Budget is 50K.',
                    confidence: 85,
                    source: 'OpenAlex',
                    agent: 'agent_alpha',
                    validFrom: new Date('2026-01-01T00:00:00Z'),
                });
                const second = await iranti.write({
                    entity: target,
                    key: 'budget',
                    value: { amount: 75000 },
                    summary: 'Budget is 75K.',
                    confidence: 80,
                    source: 'finance_memo',
                    agent: 'agent_beta',
                    validFrom: new Date('2026-02-01T00:00:00Z'),
                });
                const current = await iranti.query(target, 'budget');

                expect(second.action === 'rejected', `expected newer weaker write rejected, got ${second.action}`);
                expect((current.value as any)?.amount === 50000, `expected older stronger fact to survive, got ${JSON.stringify(current.value)}`);
            },
        },
        {
            name: 'newer stronger fact replaces older weaker contradiction',
            expectation: 'pass',
            async run({ iranti, entity }) {
                const target = entity('project', 'opal_forge');

                await iranti.write({
                    entity: target,
                    key: 'budget',
                    value: { amount: 50000 },
                    summary: 'Budget is 50K.',
                    confidence: 70,
                    source: 'finance_memo',
                    agent: 'agent_alpha',
                    validFrom: new Date('2026-01-01T00:00:00Z'),
                });
                const second = await iranti.write({
                    entity: target,
                    key: 'budget',
                    value: { amount: 75000 },
                    summary: 'Budget is 75K.',
                    confidence: 85,
                    source: 'OpenAlex',
                    agent: 'agent_beta',
                    validFrom: new Date('2026-02-01T00:00:00Z'),
                });
                const current = await iranti.query(target, 'budget');
                const janAsOf = await iranti.query(target, 'budget', { asOf: new Date('2026-01-15T00:00:00Z') });

                expect(second.action === 'updated', `expected newer stronger write updated, got ${second.action}`);
                expect((current.value as any)?.amount === 75000, `expected current amount 75000, got ${JSON.stringify(current.value)}`);
                expect((janAsOf.value as any)?.amount === 50000, `expected Jan asOf amount 50000, got ${JSON.stringify(janAsOf.value)}`);
            },
        },
        {
            name: 'newer tied contradiction should not require manual escalation',
            expectation: 'pass',
            async run({ iranti, entity }) {
                const target = entity('project', 'mirror_delta');

                await iranti.write({
                    entity: target,
                    key: 'status',
                    value: { state: 'planning' },
                    summary: 'Status is planning.',
                    confidence: 80,
                    source: 'source_alpha',
                    agent: 'agent_alpha',
                    validFrom: new Date('2026-01-01T00:00:00Z'),
                });
                const second = await iranti.write({
                    entity: target,
                    key: 'status',
                    value: { state: 'launched' },
                    summary: 'Status is launched.',
                    confidence: 80,
                    source: 'source_beta',
                    agent: 'agent_beta',
                    validFrom: new Date('2026-02-01T00:00:00Z'),
                });
                const current = await iranti.query(target, 'status');

                expect(second.action === 'updated', `expected newer tied write to update, got ${second.action}`);
                expect((current.value as any)?.state === 'launched', `expected newer status launched, got ${JSON.stringify(current.value)}`);
            },
        },
        {
            name: 'historical reads preserve superseded intervals',
            expectation: 'pass',
            async run({ iranti, entity }) {
                const target = entity('project', 'solstice_braid');

                await iranti.write({
                    entity: target,
                    key: 'status',
                    value: { state: 'planning' },
                    summary: 'Status is planning.',
                    confidence: 78,
                    source: 'timeline_brief',
                    agent: 'agent_alpha',
                    validFrom: new Date('2026-01-01T00:00:00Z'),
                });
                await iranti.write({
                    entity: target,
                    key: 'status',
                    value: { state: 'launched' },
                    summary: 'Status is launched.',
                    confidence: 78,
                    source: 'timeline_brief',
                    agent: 'agent_alpha',
                    validFrom: new Date('2026-03-01T00:00:00Z'),
                });

                const febAsOf = await iranti.query(target, 'status', { asOf: new Date('2026-02-15T00:00:00Z') });
                const history = await iranti.history(target, 'status');

                expect((febAsOf.value as any)?.state === 'planning', `expected Feb asOf planning, got ${JSON.stringify(febAsOf.value)}`);
                expect(history.length === 2, `expected 2 history rows, got ${history.length}`);
                expect(history[0].validUntil !== null, 'expected superseded interval to be closed');
                expect(history[1].isCurrent === true, 'expected last history row to be current');
            },
        },
    ],
};
