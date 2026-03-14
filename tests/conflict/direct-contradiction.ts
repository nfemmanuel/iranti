import { BenchmarkSuite, expect } from './common';

export const directContradictionSuite: BenchmarkSuite = {
    label: 'Direct contradiction',
    cases: [
        {
            name: 'rejects lower-confidence contradictory write',
            expectation: 'pass',
            async run({ iranti, entity }) {
                const target = entity('project', 'starfall_nexus');

                const first = await iranti.write({
                    entity: target,
                    key: 'budget',
                    value: { amount: 50000, currency: 'USD' },
                    summary: 'Budget is $50K.',
                    confidence: 82,
                    source: 'OpenAlex',
                    agent: 'agent_alpha',
                });
                const second = await iranti.write({
                    entity: target,
                    key: 'budget',
                    value: { amount: 75000, currency: 'USD' },
                    summary: 'Budget is $75K.',
                    confidence: 60,
                    source: 'finance_memo',
                    agent: 'agent_beta',
                });
                const current = await iranti.query(target, 'budget');

                expect(first.action === 'created', `expected first action created, got ${first.action}`);
                expect(second.action === 'rejected', `expected second action rejected, got ${second.action}`);
                expect(current.found, 'expected current fact to remain readable');
                expect((current.value as any)?.amount === 50000, `expected winning amount 50000, got ${JSON.stringify(current.value)}`);
                expect(typeof current.confidence === 'number', 'expected winning fact to carry confidence');
            },
        },
        {
            name: 'accepts stronger contradictory write',
            expectation: 'pass',
            async run({ iranti, entity }) {
                const target = entity('project', 'ember_arc');

                await iranti.write({
                    entity: target,
                    key: 'budget',
                    value: { amount: 50000, currency: 'USD' },
                    summary: 'Budget is $50K.',
                    confidence: 60,
                    source: 'briefing_note',
                    agent: 'agent_alpha',
                });
                const second = await iranti.write({
                    entity: target,
                    key: 'budget',
                    value: { amount: 75000, currency: 'USD' },
                    summary: 'Budget is $75K.',
                    confidence: 90,
                    source: 'OpenAlex',
                    agent: 'agent_beta',
                });
                const current = await iranti.query(target, 'budget');

                expect(second.action === 'updated', `expected second action updated, got ${second.action}`);
                expect(current.found, 'expected current fact to exist');
                expect((current.value as any)?.amount === 75000, `expected winning amount 75000, got ${JSON.stringify(current.value)}`);
                expect(typeof current.confidence === 'number', 'expected winning fact to carry confidence');
            },
        },
        {
            name: 'same-source equal-confidence contradiction uses latest update',
            expectation: 'pass',
            async run({ iranti, entity }) {
                const target = entity('project', 'aurora_spindle');

                await iranti.write({
                    entity: target,
                    key: 'status',
                    value: { state: 'planning' },
                    summary: 'Status is planning.',
                    confidence: 80,
                    source: 'project_brief',
                    agent: 'agent_alpha',
                });
                const second = await iranti.write({
                    entity: target,
                    key: 'status',
                    value: { state: 'launched' },
                    summary: 'Status is launched.',
                    confidence: 80,
                    source: 'project_brief',
                    agent: 'agent_alpha',
                });
                const current = await iranti.query(target, 'status');
                const history = await iranti.history(target, 'status');

                expect(second.action === 'updated', `expected second action updated, got ${second.action}`);
                expect((current.value as any)?.state === 'launched', `expected current status launched, got ${JSON.stringify(current.value)}`);
                expect(history.length === 2, `expected 2 history rows, got ${history.length}`);
                expect(history[0].archivedReason === 'superseded', `expected first row superseded, got ${history[0].archivedReason}`);
            },
        },
        {
            name: 'equal-confidence different-source contradiction escalates',
            expectation: 'pass',
            async run({ iranti, entity }) {
                const target = entity('project', 'glass_harbor');

                await iranti.write({
                    entity: target,
                    key: 'budget',
                    value: { amount: 50000, currency: 'USD' },
                    summary: 'Budget is $50K.',
                    confidence: 80,
                    source: 'source_alpha',
                    agent: 'agent_alpha',
                });
                const second = await iranti.write({
                    entity: target,
                    key: 'budget',
                    value: { amount: 75000, currency: 'USD' },
                    summary: 'Budget is $75K.',
                    confidence: 80,
                    source: 'source_beta',
                    agent: 'agent_beta',
                });
                const current = await iranti.query(target, 'budget');
                const history = await iranti.history(target, 'budget');

                expect(second.action === 'escalated', `expected second action escalated, got ${second.action}`);
                expect(current.found === false, 'expected no current row during escalation');
                expect(history.some((row) => row.archivedReason === 'escalated'), 'expected escalation interval in history');
            },
        },
    ],
};
