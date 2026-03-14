import { BenchmarkSuite, expect } from './common';

export const cascadingConflictSuite: BenchmarkSuite = {
    label: 'Cascading conflict',
    cases: [
        {
            name: 'launched status conflicts with future launch date',
            expectation: 'xfail',
            note: 'Cross-key consistency checks are not implemented; Librarian currently reasons one entity+key at a time.',
            async run({ iranti, entity }) {
                const target = entity('project', 'starfall_nexus');
                await iranti.write({
                    entity: target,
                    key: 'status',
                    value: { state: 'launched' },
                    summary: 'Project is launched.',
                    confidence: 90,
                    source: 'project_brief',
                    agent: 'agent_alpha',
                });
                const second = await iranti.write({
                    entity: target,
                    key: 'launch_date',
                    value: { iso: '2099-04-01T00:00:00Z' },
                    summary: 'Launch date is in the future.',
                    confidence: 88,
                    source: 'timeline_brief',
                    agent: 'agent_beta',
                });
                expect(second.action !== 'created', `expected cascading contradiction to trigger conflict handling, got ${second.action}`);
            },
        },
        {
            name: 'completed status conflicts with unfinished tasks',
            expectation: 'xfail',
            note: 'Cross-key semantic consistency is not enforced in current Librarian writes.',
            async run({ iranti, entity }) {
                const target = entity('project', 'ember_vault');
                await iranti.write({
                    entity: target,
                    key: 'status',
                    value: { state: 'completed' },
                    summary: 'Project is completed.',
                    confidence: 90,
                    source: 'delivery_report',
                    agent: 'agent_alpha',
                });
                const second = await iranti.write({
                    entity: target,
                    key: 'remaining_tasks',
                    value: { count: 12 },
                    summary: 'Twelve tasks remain unfinished.',
                    confidence: 87,
                    source: 'task_board',
                    agent: 'agent_beta',
                });
                expect(second.action !== 'created', `expected cascading contradiction to trigger conflict handling, got ${second.action}`);
            },
        },
        {
            name: 'zero headcount conflicts with active hiring plan',
            expectation: 'xfail',
            note: 'Current write path does not detect internal contradictions across different keys.',
            async run({ iranti, entity }) {
                const target = entity('team', 'lattice_ops');
                await iranti.write({
                    entity: target,
                    key: 'headcount',
                    value: { count: 0 },
                    summary: 'Team headcount is zero.',
                    confidence: 84,
                    source: 'org_chart',
                    agent: 'agent_alpha',
                });
                const second = await iranti.write({
                    entity: target,
                    key: 'hiring_status',
                    value: { state: 'actively_hiring' },
                    summary: 'Team is actively hiring.',
                    confidence: 86,
                    source: 'recruiting_plan',
                    agent: 'agent_beta',
                });
                expect(second.action !== 'created', `expected cascading contradiction to trigger conflict handling, got ${second.action}`);
            },
        },
        {
            name: 'budget frozen conflicts with approved procurement',
            expectation: 'xfail',
            note: 'Benchmark captures the current absence of cross-key conflict reasoning.',
            async run({ iranti, entity }) {
                const target = entity('project', 'onyx_flare');
                await iranti.write({
                    entity: target,
                    key: 'budget_status',
                    value: { state: 'frozen' },
                    summary: 'Budget is frozen.',
                    confidence: 83,
                    source: 'finance_notice',
                    agent: 'agent_alpha',
                });
                const second = await iranti.write({
                    entity: target,
                    key: 'procurement_status',
                    value: { state: 'approved' },
                    summary: 'Procurement is approved.',
                    confidence: 81,
                    source: 'ops_notice',
                    agent: 'agent_beta',
                });
                expect(second.action !== 'created', `expected cascading contradiction to trigger conflict handling, got ${second.action}`);
            },
        },
    ],
};
