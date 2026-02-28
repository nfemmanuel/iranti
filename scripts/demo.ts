import 'dotenv/config';
import { Iranti } from '../src/sdk';

// ─── Demo Config ─────────────────────────────────────────────────────────────

const DEMO_ENTITY = `researcher/demo_${Date.now()}`;
const SEPARATOR = '─'.repeat(60);

function log(msg: string): void { console.log(msg); }
function section(title: string): void {
    log(`\n${SEPARATOR}`);
    log(`  ${title}`);
    log(SEPARATOR);
}
function indent(msg: string, level = 1): void {
    log(`${'  '.repeat(level)}${msg}`);
}

// ─── Demo ─────────────────────────────────────────────────────────────────────

async function demo() {
    log('\n');
    log('██╗██████╗  █████╗ ███╗   ██╗████████╗██╗');
    log('██║██╔══██╗██╔══██╗████╗  ██║╚══██╔══╝██║');
    log('██║██████╔╝███████║██╔██╗ ██║   ██║   ██║');
    log('██║██╔══██╗██╔══██║██║╚██╗██║   ██║   ██║');
    log('██║██║  ██║██║  ██║██║ ╚████║   ██║   ██║');
    log('╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚═╝');
    log('\n  Memory infrastructure for multi-agent AI systems');
    log('  DEMO — Two agents, shared memory, conflict resolution\n');

    const iranti = new Iranti();

    // ── Scenario: disagreement ────────────────────────────────────────────────
    iranti.configureMock({ scenario: 'disagreement', seed: 123 });

    // ── Register agents ───────────────────────────────────────────────────────
    section('STEP 1 — Register agents');

    await iranti.registerAgent({
        agentId: 'agent_alpha',
        name: 'Alpha',
        description: 'Scrapes OpenAlex for researcher profiles',
        capabilities: ['web_scraping', 'data_extraction'],
        model: 'mock',
    });
    await iranti.registerAgent({
        agentId: 'agent_beta',
        name: 'Beta',
        description: 'Cross-references ORCID for verification',
        capabilities: ['verification', 'cross_referencing'],
        model: 'mock',
    });

    indent('✓ Agent Alpha registered (OpenAlex scraper)');
    indent('✓ Agent Beta registered (ORCID verifier)');

    // ── Handshake ─────────────────────────────────────────────────────────────
    section('STEP 2 — Agents handshake with Attendant');

    const briefAlpha = await iranti.handshake({
        agent: 'agent_alpha',
        task: 'Research publication history and affiliation for target researcher',
        recentMessages: ['Starting profile extraction from OpenAlex'],
    });

    indent('Agent Alpha brief:');
    indent(`Task inferred:     ${briefAlpha.inferredTaskType}`, 2);
    indent(`Operating rules:   ${briefAlpha.operatingRules.length > 0 ? 'loaded' : 'none'}`, 2);
    indent(`Working memory:    ${briefAlpha.workingMemory.length} entries`, 2);

    const briefBeta = await iranti.handshake({
        agent: 'agent_beta',
        task: 'Verify researcher affiliation against ORCID records',
        recentMessages: ['Starting ORCID verification pass'],
    });

    indent('Agent Beta brief:');
    indent(`Task inferred:     ${briefBeta.inferredTaskType}`, 2);
    indent(`Working memory:    ${briefBeta.workingMemory.length} entries`, 2);

    // ── Alpha writes findings ─────────────────────────────────────────────────
    section('STEP 3 — Agent Alpha writes findings');

    const alphaFindings = [
        {
            key: 'affiliation',
            value: { institution: 'Stanford University', department: 'Computer Science' },
            summary: 'Affiliated with Stanford University CS department',
            confidence: 82,
            source: 'OpenAlex',
        },
        {
            key: 'publication_count',
            value: { count: 31, asOf: '2024' },
            summary: 'Has published 31 papers as of 2024',
            confidence: 90,
            source: 'OpenAlex',
        },
        {
            key: 'research_focus',
            value: { primary: 'machine learning', secondary: 'computer vision' },
            summary: 'Primary focus: machine learning. Secondary: computer vision.',
            confidence: 75,
            source: 'OpenAlex',
        },
    ];

    for (const finding of alphaFindings) {
        const result = await iranti.write({
            entity: DEMO_ENTITY,
            ...finding,
            agent: 'agent_alpha',
        });
        const icon = result.action === 'created' ? '✓' : result.action === 'updated' ? '↑' : '–';
        indent(`${icon} [${finding.key}] ${result.action} (confidence: ${finding.confidence}, source: ${finding.source})`);
    }

    // ── Beta reads Alpha's work ───────────────────────────────────────────────
    section('STEP 4 — Agent Beta reconvenes, sees Alpha\'s findings');

    iranti.configureMock({ scenario: 'collaborative', seed: 456 });

    const briefBeta2 = await iranti.reconvene('agent_beta', {
        task: 'Verify researcher affiliation against ORCID records',
        recentMessages: [
            'Pulled ORCID records for target researcher',
            'Found affiliation data — cross-referencing with existing KB',
        ],
    });

    indent(`Working memory entries: ${briefBeta2.workingMemory.length}`);
    if (briefBeta2.workingMemory.length > 0) {
        briefBeta2.workingMemory.forEach((e) => {
            indent(`→ ${e.entityKey}: ${e.summary}`, 2);
        });
    } else {
        indent('→ No relevant entries surfaced (mock relevance filter)', 2);
    }

    // ── Beta writes conflicting finding ───────────────────────────────────────
    section('STEP 5 — Agent Beta writes a conflicting affiliation');

    iranti.configureMock({ scenario: 'disagreement', seed: 789 });

    indent('Alpha wrote: Stanford University (confidence 82, OpenAlex)');
    indent('Beta writes: MIT (confidence 79, ORCID)\n');

    const conflictResult = await iranti.write({
        entity: DEMO_ENTITY,
        key: 'affiliation',
        value: { institution: 'MIT', department: 'EECS' },
        summary: 'Affiliated with MIT EECS department',
        confidence: 79,
        source: 'ORCID',
        agent: 'agent_beta',
    });

    indent(`Librarian decision: ${conflictResult.action.toUpperCase()}`);
    indent(`Reason: ${conflictResult.reason}`, 2);

    if (conflictResult.action === 'escalated') {
        indent('\n⚡ Conflict written to escalation/active/', 2);
        indent('A human can resolve it in plain language — no code required.', 2);
    } else if (conflictResult.action === 'rejected') {
        indent('\nStanford entry preserved. ORCID entry rejected.', 2);
    } else if (conflictResult.action === 'updated') {
        indent('\nMIT entry accepted. Stanford entry archived with full provenance.', 2);
    }

    // ── Beta writes non-conflicting findings ──────────────────────────────────
    section('STEP 6 — Agent Beta adds new non-conflicting facts');

    const betaFindings = [
        {
            key: 'h_index',
            value: { score: 14 },
            summary: 'H-index of 14',
            confidence: 88,
            source: 'ORCID',
        },
        {
            key: 'orcid_verified',
            value: { verified: true, orcidId: '0000-0000-0000-0001' },
            summary: 'ORCID verified researcher profile',
            confidence: 99,
            source: 'ORCID',
        },
    ];

    for (const finding of betaFindings) {
        const result = await iranti.write({
            entity: DEMO_ENTITY,
            ...finding,
            agent: 'agent_beta',
        });
        const icon = result.action === 'created' ? '✓' : '–';
        indent(`${icon} [${finding.key}] ${result.action}`);
    }

    // ── Knowledge state ───────────────────────────────────────────────────────
    section('STEP 7 — Final knowledge base state');

    const allFacts = await iranti.queryAll(DEMO_ENTITY);
    indent(`Entity: ${DEMO_ENTITY}`);
    indent(`Total facts stored: ${allFacts.length}\n`);
    allFacts.forEach((f) => {
        indent(`[${f.key}]`, 2);
        indent(`Summary:    ${f.summary}`, 3);
        indent(`Confidence: ${f.confidence} | Source: ${f.source}`, 3);
    });

    // ── Agent stats ───────────────────────────────────────────────────────────
    section('STEP 8 — Agent activity summary');

    const alpha = await iranti.getAgent('agent_alpha');
    const beta = await iranti.getAgent('agent_beta');

    indent('Agent Alpha (OpenAlex scraper):');
    indent(`Writes: ${alpha?.stats.totalWrites ?? 0}  |  Rejections: ${alpha?.stats.totalRejections ?? 0}  |  Avg confidence: ${alpha?.stats.avgConfidence ?? 0}`, 2);

    indent('Agent Beta (ORCID verifier):');
    indent(`Writes: ${beta?.stats.totalWrites ?? 0}  |  Rejections: ${beta?.stats.totalRejections ?? 0}  |  Avg confidence: ${beta?.stats.avgConfidence ?? 0}`, 2);

    // ── whoKnows ──────────────────────────────────────────────────────────────
    section('STEP 9 — Who knows what about this entity?');

    const knowers = await iranti.whoKnows(DEMO_ENTITY);
    knowers.forEach((k) => {
        indent(`${k.agentId}: [${k.keys.join(', ')}] — ${k.totalContributions} facts`);
    });

    // ── Source reliability ────────────────────────────────────────────────────
    section('STEP 10 — Source reliability after this session');

    const { getReliabilityScores } = await import('../src/librarian/source-reliability');
    const scores = await getReliabilityScores();
    if (Object.keys(scores).length === 0) {
        indent('No conflicts resolved yet — reliability scores unchanged (all 0.5)');
    } else {
        Object.entries(scores).forEach(([source, score]) => {
            const bar = '█'.repeat(Math.round((score as number) * 20));
            indent(`${source.padEnd(20)} ${bar} ${(score as number).toFixed(3)}`);
        });
    }

    // ── Maintenance ───────────────────────────────────────────────────────────
    section('STEP 11 — Archivist maintenance cycle');

    const report = await iranti.runMaintenance();
    indent(`Expired archived:        ${report.expiredArchived}`);
    indent(`Low confidence archived: ${report.lowConfidenceArchived}`);
    indent(`Escalations processed:   ${report.escalationsProcessed}`);
    indent(`Errors:                  ${report.errors.length === 0 ? 'none' : report.errors.join(', ')}`);

    // ── Summary ───────────────────────────────────────────────────────────────
    section('DEMO COMPLETE');

    log('  What just happened:');
    log('');
    log('  1. Two agents started blind — no prior knowledge');
    log('  2. Each agent received a personalized working memory brief');
    log('  3. Agent Alpha wrote findings from OpenAlex');
    log('  4. Agent Beta reconvened and saw Alpha\'s work automatically');
    log('  5. Beta\'s conflicting affiliation was handled by the Librarian');
    log('  6. Beta added new non-conflicting facts — no collision');
    log('  7. Final KB has clean, attributed, versioned knowledge');
    log('  8. Source reliability scores updated for future sessions');
    log('  9. Everything is queryable, auditable, and recoverable');
    log('');
    log('  No agent needed to know about the other.');
    log('  No agent needed to manage conflicts.');
    log('  No knowledge was silently overwritten or lost.');
    log('');
    log(`${SEPARATOR}\n`);

    process.exit(0);
}

demo().catch((err) => {
    console.error('Demo failed:', err);
    process.exit(1);
});
