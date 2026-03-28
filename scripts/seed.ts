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
            version: '0.2.15',
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
            version: '0.2.15',
            rules: [
                'Serve one external agent only; optimize for that agent keeping task context coherent across turns and sessions.',
                'At session start or when the task changes, run handshake to load operating rules, task context, and the most relevant shared memory.',
                'Before answering recall-style questions about remembered preferences, decisions, blockers, next steps, prior project state, or earlier findings, consult Iranti instead of guessing.',
                'Use exact query when the entity and key are known. Use search or attend when the fact must be discovered from shared memory.',
                'Persist durable knowledge when it is learned or confirmed: decisions, blockers, next steps, owners, stable preferences, project constraints, important file purposes, and validated environment details.',
                'When a file is created or substantially repurposed, capture what it is for only if that context is likely to matter to another agent or a later session.',
                'When an approach fails and the failure or workaround is likely to matter later, store the failed path and the chosen alternative route as durable memory.',
                'Use iranti_write for durable facts, iranti_ingest for stable source material worth chunking, and iranti_remember_response for strict assistant summaries such as next steps or blockers.',
                'Do not save every turn. Skip ephemeral chatter, speculative thoughts, or transient execution noise that will degrade retrieval quality later.',
                'Deliver a compressed working-memory brief, not the full knowledge base. Load only what is relevant to the current task.',
                'Reconvene or attend again when context shifts, when the visible window is missing needed facts, or when a different entity becomes relevant.',
                'If context gets stale or the task has gone long enough that reasoning may drift, re-read the operating rules from the Staff Namespace before proceeding.',
            ],
        },
        valueSummary: 'Attendant manages per-agent working memory and instructs agents when to read and write durable memory.',
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
            version: '0.2.15',
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
        valueRaw: { version: '0.2.15' },
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
            seedVersion: '0.2.15',
        },
        valueSummary: 'Record of when and how this Library was initialized.',
        confidence: 100,
        source: 'seed',
        createdBy: 'Seed',
        isProtected: true,
    },
    {
        entityType: 'system',
        entityId: 'ontology',
        key: 'core_schema',
        valueRaw: {
            version: '0.2.15',
            states: ['candidate', 'provisional', 'canonical'],
            coreEntityTypes: [
                'person',
                'organization',
                'project',
                'document',
                'event',
                'agent',
                'system',
            ],
            coreKeys: [
                'profile',
                'preferences',
                'status',
                'goal',
                'constraint',
                'role',
                'deadline',
                'summary',
                'contact',
            ],
            coreRelationships: [
                'MEMBER_OF',
                'PART_OF',
                'AUTHORED',
                'OWNS',
                'RELATED_TO',
                'ASSIGNED_TO',
                'DEPENDS_ON',
            ],
            normalizationRules: {
                entityId: 'lowercase snake_case ascii',
                customTerms: 'extensions only, namespaced',
                corePromotion: 'never automatic',
            },
        },
        valueSummary: 'Canonical ontology base layer for entity types, core keys, relationships, and evolution states.',
        confidence: 100,
        source: 'seed',
        createdBy: 'Seed',
        isProtected: true,
    },
    {
        entityType: 'system',
        entityId: 'ontology',
        key: 'extension_registry',
        valueRaw: {
            version: '0.2.15',
            namespaces: {
                education: {
                    status: 'provisional',
                    description: 'Education and coursework concepts',
                },
                research: {
                    status: 'provisional',
                    description: 'Research workflow and evidence concepts',
                },
                software: {
                    status: 'provisional',
                    description: 'Code, repository, bug, service, and deployment concepts',
                },
                project_management: {
                    status: 'provisional',
                    description: 'Planning, ownership, blockers, and milestone concepts',
                },
            },
        },
        valueSummary: 'Registry of allowed ontology extension namespaces and their current status.',
        confidence: 100,
        source: 'seed',
        createdBy: 'Seed',
        isProtected: true,
    },
    {
        entityType: 'system',
        entityId: 'ontology',
        key: 'candidate_terms',
        valueRaw: {
            version: '0.2.15',
            terms: [],
        },
        valueSummary: 'Staging area for ontology terms detected repeatedly but not yet promoted.',
        confidence: 100,
        source: 'seed',
        createdBy: 'Seed',
        isProtected: true,
    },
    {
        entityType: 'system',
        entityId: 'ontology',
        key: 'promotion_policy',
        valueRaw: {
            version: '0.2.15',
            candidateToProvisional: {
                minSeenCount: 3,
                minDistinctAgents: 2,
                minDistinctProjects: 2,
                requiresNamespace: true,
            },
            provisionalToCanonical: {
                humanApprovalRequired: true,
                minSeenCount: 12,
                minDistinctAgents: 3,
                minDistinctProjects: 3,
                minStableDays: 14,
            },
            autoLearnAllowed: [
                'aliases',
                'extension_keys',
                'extension_relationships',
            ],
            autoLearnBlocked: [
                'core_entity_types',
                'core_key_remaps',
                'global_semantic_merges',
            ],
        },
        valueSummary: 'Governed ontology promotion policy controlling candidate, provisional, and canonical transitions.',
        confidence: 100,
        source: 'seed',
        createdBy: 'Seed',
        isProtected: true,
    },
    {
        entityType: 'system',
        entityId: 'ontology',
        key: 'change_log',
        valueRaw: {
            version: '0.2.15',
            events: [
                {
                    at: new Date().toISOString(),
                    actor: 'seed',
                    action: 'initialized_ontology_evolution_foundation',
                },
            ],
        },
        valueSummary: 'Append-only log for ontology promotions, namespace registrations, and policy changes.',
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
