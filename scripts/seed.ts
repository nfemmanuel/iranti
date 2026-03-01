import 'dotenv/config';
import { initDb } from '../src/library/client';
import { createEntry } from '../src/library/queries';

// Initialize DB
if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required');
}
initDb(process.env.DATABASE_URL);

// ─── Staff Operating Rules ───────────────────────────────────────────────────

const STAFF_ENTRIES = [
    {
        entityType: 'system',
        entityId: 'librarian',
        key: 'operating_rules',
        valueRaw: {
            version: '0.1.0',
            rules: [
                'All writes from external agents go through the Librarian — never directly to the database',
                'Check for existing entries before every write',
                'Log every decision with a reason — nothing is silently overwritten',
                'Deterministic resolution for exact duplicates — keep the higher confidence entry',
                'Model-assisted resolution for ambiguous conflicts',
                'Write to escalation/active/ when confidence in resolution is below threshold',
                'Never modify entries where isProtected = true',
                'Run initialization pass on blank Library before any agent is allowed to write',
            ],
            conflictThreshold: 10,
        },
        valueSummary: 'Librarian manages all Library writes, detects and resolves conflicts, escalates when uncertain.',
        confidence: 100,
        source: 'seed',
        createdBy: 'Seed',
        isProtected: true,
    },
    {
        entityType: 'system',
        entityId: 'attendant',
        key: 'operating_rules',
        valueRaw: {
            version: '0.1.0',
            rules: [
                'Assigned one-per-external-agent — serve the agent, not the user',
                'On handshake: read AGENTS.md and MCP config, query Librarian for relevant rules and task context',
                'Deliver a compressed working memory brief — not the full KB',
                'Infer task context by observing the agent\'s recent messages',
                'Load only what is relevant to the current task',
                'Reconvene periodically to update working memory as task context shifts',
                'If context window runs low, re-read operating rules from Staff Namespace',
            ],
        },
        valueSummary: 'Attendant manages per-agent working memory via handshake, relevance filtering, and periodic reconvene.',
        confidence: 100,
        source: 'seed',
        createdBy: 'Seed',
        isProtected: true,
    },
    {
        entityType: 'system',
        entityId: 'archivist',
        key: 'operating_rules',
        valueRaw: {
            version: '0.1.0',
            rules: [
                'Run on schedule or when conflict flags exceed threshold — not on every write',
                'Scan for expired, low-confidence, flagged, and duplicate entries',
                'Merge duplicates into single canonical entries',
                'Move challenged entries to Archive with full provenance — never delete',
                'Watch escalation/active/ for RESOLVED files',
                'Write human-resolved entries to KB as source = HumanReview, confidence = 100',
                'Move processed escalation files to escalation/resolved/',
            ],
        },
        valueSummary: 'Archivist runs periodic cleanup, archives challenged entries, and processes human-resolved escalations.',
        confidence: 100,
        source: 'seed',
        createdBy: 'Seed',
        isProtected: true,
    },
    {
        entityType: 'system',
        entityId: 'library',
        key: 'schema_version',
        valueRaw: { version: '0.1.0' },
        valueSummary: 'Current Library schema version.',
        confidence: 100,
        source: 'seed',
        createdBy: 'Seed',
        isProtected: true,
    },
    {
        entityType: 'system',
        entityId: 'library',
        key: 'initialization_log',
        valueRaw: {
            initializedAt: new Date().toISOString(),
            seedVersion: '0.1.0',
        },
        valueSummary: 'Record of when and how this Library was initialized.',
        confidence: 100,
        source: 'seed',
        createdBy: 'Seed',
        isProtected: true,
    },
];

// ─── Seed ────────────────────────────────────────────────────────────────────

async function seed() {
    console.log('Seeding Staff Namespace...');

    for (const entry of STAFF_ENTRIES) {
        await createEntry(entry);
        console.log(`  ✓ system / ${entry.entityId} / ${entry.key}`);
    }

    console.log('Staff Namespace seeded successfully.');
    process.exit(0);
}

seed().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
});