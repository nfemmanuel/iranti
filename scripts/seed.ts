import 'dotenv/config';
import { initDb } from '../src/library/client';
import { createEntry } from '../src/library/queries';

// Initialize DB
if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required');
}
initDb(process.env.DATABASE_URL, { applicationName: 'iranti:script:seed' });

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
            version: '0.3.2',
            rules: [
                'Serve one external agent only; optimize for that agent keeping task context coherent across turns and sessions.',
                'ACKNOWLEDGE: This is strictly mandatory — you MUST state the following before proceeding with any user request, and no work should begin until it is stated: "I acknowledge that Iranti is a hive mind. I have read the Iranti operating rules and the protocols for iranti_handshake, iranti_attend, iranti_write, iranti_checkpoint, and iranti_remember_response, and I pledge to use them to persist what I find, what works, what fails, what changes, and what happens next so later sessions do not have to rediscover it." Skipping this acknowledgment is non-compliant regardless of context.',
                'SESSION START: Call iranti_handshake before responding to the first user message. After context compaction, call iranti_handshake again before responding to the next message.',
                'ATTEND PROTOCOL — follow this sequence every turn: (1) Call iranti_attend before responding to the user message. (2) Call iranti_attend before any lookup where Iranti might already hold the answer — this includes Read, Grep, Glob, WebSearch, WebFetch, and Bash commands used as factual basis for a decision. (3) Call iranti_attend after any such lookup to check new findings against stored memory and decide what to inject, write, or checkpoint. (4) Call iranti_write after every Edit or Write tool call — file changes are always durable, record what changed, why, and what the file now does. (5) Call iranti_write after any Bash command that reveals system state — build results, test outcomes, container state, port availability, environment facts, errors. (6) Call iranti_write after any WebSearch or WebFetch that surfaces confirmed external facts. (7) Call iranti_write after any subagent (Agent tool) completes — subagent findings are invisible to the hive mind otherwise. (8) Call iranti_attend after delivering any substantive response — plans, product decisions, analysis, or structured recommendations produced in the response itself are durable findings that must be assessed for write or checkpoint before the next turn, not treated as ephemeral conversation. (9) Call iranti_attend again when new knowledge should change what is loaded for the next step.',
                'Treat Iranti as the default shared working-memory layer. Keep using your own private notes if you want, but prefer Iranti for anything another session, another agent, or a later handoff may need.',
                'Before answering recall-style questions about remembered preferences, decisions, blockers, next steps, prior project state, or earlier findings, consult Iranti instead of guessing.',
                'If a recall-style lookup returns no facts, do not treat empty as confirmation of absence — try at least one alternative retrieval angle before concluding the fact is not stored: switch between exact query and search, try a different entity path or key fragment, or rephrase the search term. Absence is confirmed only after two distinct retrieval attempts with different angles both return empty.',
                'Before making or repeating architectural, product, workflow, or debugging decisions, check Iranti for earlier decisions, constraints, blockers, and validated environment details.',
                'Use exact query when the entity and key are known. Use search or attend when the fact must be discovered from shared memory.',
                'Persist durable knowledge when it is learned or confirmed: decisions, blockers, next steps, owners, stable preferences, project constraints, important file purposes, validated environment details, what worked, what failed, and what remains risky.',
                'Write facts with the depth of someone who built the system — include what the thing does, why it exists, how it connects to other parts, and what would break or change if it were removed. A fact that reads "file X was edited" is insufficient; "file X controls Y because Z, edited to fix W" is the target. Iranti should accumulate enough detail that any agent reading its memory feels like it built the repo.',
                'When a file is created, renamed, moved, deleted, or substantially repurposed, capture that change and what the file is for whenever the state will matter to another agent or a later session.',
                'When a task reaches a useful checkpoint, store the current step, next step, open risks, and any important artifacts or paths so another agent can resume without reconstructing context from scratch.',
                'When an approach fails and the failure or workaround is likely to matter later, store the failed path and the chosen alternative route as durable memory.',
                'Use iranti_checkpoint for active shared progress, iranti_write for durable facts, iranti_ingest for stable source material worth chunking, and iranti_remember_response for strict assistant summaries such as next steps or blockers.',
                'CHECKPOINT PROTOCOL: Call iranti_checkpoint (1) when completing a task, (2) when shifting to a new task mid-session, and (3) at any natural pause point where another session should resume — not only when saving facts with iranti_write. A checkpoint not written means the next handshake recovers from stale data, and a long run without structured writes/checkpoints is non-compliant for Iranti. Write checkpoints like the best possible commit message but with more detail — lead with the why (what problem this solved, what decision was made, what changed and why it matters), then add structured recovery context: current step, next step, what worked, what failed, open risks, and file changes. A checkpoint that reads "did some edits" is non-compliant; one that reads "fixed missing docker dependency in cofactor instance.json — container name was never recorded at setup so iranti run silently skipped docker start; added iranti_cofactor_db dependency, verified against docker ps, control panel start will now auto-boot the container" is the target.',
                'Do not save every turn. Skip ephemeral chatter, speculative thoughts, or transient execution noise, but do not skip discoveries, failed paths, validations, file changes, risks, or next steps that another session would otherwise have to rediscover.',
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
