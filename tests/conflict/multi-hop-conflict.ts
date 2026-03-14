import { BenchmarkSuite, expect } from './common';

export const multiHopConflictSuite: BenchmarkSuite = {
    label: 'Multi-hop conflict',
    cases: [
        {
            name: 'departed person still leads active project',
            expectation: 'xfail',
            note: 'Multi-hop conflict reasoning across relationships is not implemented in the Librarian.',
            async run({ iranti, entity }) {
                const person = entity('person', 'valdris_ohen');
                const project = entity('project', 'starfall_nexus');

                await iranti.relate(person, 'LEADS', project, { createdBy: 'agent_alpha' });
                await iranti.write({
                    entity: person,
                    key: 'employment_status',
                    value: { state: 'left_company' },
                    summary: 'Valdris Ohen left the company.',
                    confidence: 91,
                    source: 'hr_exit_log',
                    agent: 'agent_alpha',
                });
                const second = await iranti.write({
                    entity: project,
                    key: 'lead_status',
                    value: { state: 'active', person: person },
                    summary: 'Project still lists Valdris Ohen as active lead.',
                    confidence: 88,
                    source: 'project_roster',
                    agent: 'agent_beta',
                });
                const graph = await iranti.getRelatedDeep(person, 2);

                expect(graph.some((row) => row.relationshipType === 'LEADS'), 'expected graph edge to exist');
                expect(second.action !== 'created', `expected multi-hop contradiction to trigger conflict handling, got ${second.action}`);
            },
        },
        {
            name: 'dissolved org still contains active team',
            expectation: 'xfail',
            note: 'Relationship traversal exists, but no cross-entity contradiction detection uses it yet.',
            async run({ iranti, entity }) {
                const org = entity('org', 'cinder_labs');
                const team = entity('team', 'ember_ops');

                await iranti.relate(team, 'MEMBER_OF', org, { createdBy: 'agent_alpha' });
                await iranti.write({
                    entity: org,
                    key: 'status',
                    value: { state: 'dissolved' },
                    summary: 'Cinder Labs was dissolved.',
                    confidence: 92,
                    source: 'legal_notice',
                    agent: 'agent_alpha',
                });
                const second = await iranti.write({
                    entity: team,
                    key: 'status',
                    value: { state: 'active' },
                    summary: 'Ember Ops is still active.',
                    confidence: 87,
                    source: 'team_roster',
                    agent: 'agent_beta',
                });

                expect(second.action !== 'created', `expected multi-hop contradiction to trigger conflict handling, got ${second.action}`);
            },
        },
        {
            name: 'blacklisted supplier still marked as project dependency',
            expectation: 'xfail',
            note: 'Current benchmark case checks a cross-entity dependency conflict that the Librarian does not inspect.',
            async run({ iranti, entity }) {
                const supplier = entity('vendor', 'auric_supply');
                const project = entity('project', 'glass_harbor');

                await iranti.relate(project, 'DEPENDS_ON', supplier, { createdBy: 'agent_alpha' });
                await iranti.write({
                    entity: supplier,
                    key: 'compliance_status',
                    value: { state: 'blacklisted' },
                    summary: 'Supplier is blacklisted.',
                    confidence: 93,
                    source: 'compliance_audit',
                    agent: 'agent_alpha',
                });
                const second = await iranti.write({
                    entity: project,
                    key: 'procurement_status',
                    value: { state: 'approved', supplier: supplier },
                    summary: 'Project procurement remains approved with Auric Supply.',
                    confidence: 85,
                    source: 'procurement_board',
                    agent: 'agent_beta',
                });

                expect(second.action !== 'created', `expected multi-hop contradiction to trigger conflict handling, got ${second.action}`);
            },
        },
        {
            name: 'departed researcher still listed as principal investigator through lab graph',
            expectation: 'xfail',
            note: 'This case requires multi-hop reasoning across person -> lab -> project links.',
            async run({ iranti, entity }) {
                const researcher = entity('researcher', 'kaelis_thorne');
                const lab = entity('lab', 'solstice_lab');
                const project = entity('project', 'quantum_bridge');

                await iranti.relate(researcher, 'MEMBER_OF', lab, { createdBy: 'agent_alpha' });
                await iranti.relate(lab, 'LEADS', project, { createdBy: 'agent_alpha' });
                await iranti.write({
                    entity: researcher,
                    key: 'employment_status',
                    value: { state: 'departed' },
                    summary: 'Kaelis Thorne departed the lab.',
                    confidence: 91,
                    source: 'hr_exit_log',
                    agent: 'agent_alpha',
                });
                const second = await iranti.write({
                    entity: project,
                    key: 'principal_investigator',
                    value: { researcher },
                    summary: 'Kaelis Thorne remains principal investigator.',
                    confidence: 86,
                    source: 'grant_registry',
                    agent: 'agent_beta',
                });

                expect(second.action !== 'created', `expected multi-hop contradiction to trigger conflict handling, got ${second.action}`);
            },
        },
    ],
};
