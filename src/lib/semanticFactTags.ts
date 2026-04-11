/**
 * Semantic tagging for Iranti knowledge facts.
 *
 * Assigns structured metadata (domain, intent, temporal scope, tags) to facts
 * at write time so retrieval can filter by semantic properties beyond pure
 * vector similarity. Every call to iranti_write that passes a durableClass
 * routes through buildSemanticFactTags() to enrich the stored properties.
 *
 * Key exports:
 *   - buildSemanticFactTags()  — produce the semantic properties block for a write
 *   - semanticMatchScore()     — score a stored fact against a SemanticFilter at retrieval
 *   - SemanticFilter           — structured filter passed to observe/attend for targeted injection
 */

type SemanticMemoryScope = 'personal' | 'project';
type MergeStrategy = 'replace' | 'append_dedupe';

type SemanticProfile = {
    semanticDomain: string;
    semanticIntent: string;
    temporalScope: string;
    semanticTags: string[];
};

function dedupeTags(tags: string[]): string[] {
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const tag of tags) {
        const trimmed = tag.trim().toLowerCase();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        deduped.push(trimmed);
    }
    return deduped;
}

// Static profile table for all known durable classes.
// Add a new entry here when a new durableClass is introduced — the default
// fallback below handles unknown classes gracefully.
const DURABLE_CLASS_PROFILES: Record<string, SemanticProfile> = {
    preference:         { semanticDomain: 'personal',       semanticIntent: 'preference_capture',         temporalScope: 'long_term',       semanticTags: ['personal_memory', 'preference', 'identity'] },
    profile:            { semanticDomain: 'personal',       semanticIntent: 'profile_capture',            temporalScope: 'long_term',       semanticTags: ['personal_memory', 'profile', 'identity'] },
    decision:           { semanticDomain: 'planning',       semanticIntent: 'decision_capture',           temporalScope: 'project_durable', semanticTags: ['project_memory', 'decision', 'planning'] },
    next_step:          { semanticDomain: 'planning',       semanticIntent: 'task_state_tracking',        temporalScope: 'active_work',     semanticTags: ['project_memory', 'next_step', 'planning', 'actionable'] },
    current_step:       { semanticDomain: 'planning',       semanticIntent: 'task_state_tracking',        temporalScope: 'active_work',     semanticTags: ['project_memory', 'current_step', 'planning', 'status'] },
    blocker:            { semanticDomain: 'risk',           semanticIntent: 'risk_tracking',              temporalScope: 'active_work',     semanticTags: ['project_memory', 'blocker', 'risk', 'blocking'] },
    owner:              { semanticDomain: 'coordination',   semanticIntent: 'owner_tracking',             temporalScope: 'active_work',     semanticTags: ['project_memory', 'ownership', 'coordination'] },
    open_risks:         { semanticDomain: 'risk',           semanticIntent: 'risk_tracking',              temporalScope: 'active_work',     semanticTags: ['project_memory', 'risk', 'tracking', 'list_fact'] },
    artifact:           { semanticDomain: 'artifact',       semanticIntent: 'artifact_tracking',          temporalScope: 'project_durable', semanticTags: ['project_memory', 'artifact', 'reference', 'list_fact'] },
    file_change:        { semanticDomain: 'artifact',       semanticIntent: 'change_tracking',            temporalScope: 'active_work',     semanticTags: ['project_memory', 'artifact', 'file_change', 'tracking', 'list_fact'] },
    action_log:         { semanticDomain: 'execution',      semanticIntent: 'activity_tracking',          temporalScope: 'active_work',     semanticTags: ['project_memory', 'activity', 'execution', 'tracking', 'list_fact'] },
    issue_status:       { semanticDomain: 'issue_tracking', semanticIntent: 'issue_status_tracking',      temporalScope: 'project_durable', semanticTags: ['project_memory', 'issue', 'status', 'tracking'] },
    failed_path:        { semanticDomain: 'execution',      semanticIntent: 'execution_learning',         temporalScope: 'active_work',     semanticTags: ['project_memory', 'failure', 'execution_learning', 'list_fact'] },
    alternative_route:  { semanticDomain: 'execution',      semanticIntent: 'execution_learning',         temporalScope: 'active_work',     semanticTags: ['project_memory', 'recovery', 'execution_learning', 'list_fact'] },
    checkpoint_summary: { semanticDomain: 'coordination',   semanticIntent: 'checkpoint_handoff',         temporalScope: 'active_work',     semanticTags: ['project_memory', 'checkpoint', 'summary', 'recovery'] },
    scaffold_status:    { semanticDomain: 'integration',    semanticIntent: 'integration_state_tracking', temporalScope: 'project_durable', semanticTags: ['project_memory', 'integration', 'scaffold', 'status'] },
    handoff_status:     { semanticDomain: 'coordination',   semanticIntent: 'handoff_tracking',           temporalScope: 'active_work',     semanticTags: ['project_memory', 'handoff', 'status', 'coordination'] },
    handoff_task:       { semanticDomain: 'coordination',   semanticIntent: 'handoff_tracking',           temporalScope: 'active_work',     semanticTags: ['project_memory', 'handoff', 'task_reference', 'coordination'] },
};

function deriveSemanticProfile(memoryScope: SemanticMemoryScope, durableClass: string): SemanticProfile {
    const known = DURABLE_CLASS_PROFILES[durableClass];
    if (known) return known;

    // Unknown durable class: fall back to a generic profile scoped to memoryScope.
    return {
        semanticDomain: memoryScope === 'personal' ? 'personal' : 'project',
        semanticIntent: 'fact_capture',
        temporalScope: memoryScope === 'personal' ? 'long_term' : 'active_work',
        semanticTags: [memoryScope === 'personal' ? 'personal_memory' : 'project_memory'],
    };
}

export function buildSemanticFactTags(input: {
    memoryScope: SemanticMemoryScope;
    durableClass: string;
    mergeStrategy: MergeStrategy;
    extraTags?: string[];
}): Record<string, unknown> {
    const profile = deriveSemanticProfile(input.memoryScope, input.durableClass);
    return {
        semanticDomain: profile.semanticDomain,
        semanticIntent: profile.semanticIntent,
        temporalScope: profile.temporalScope,
        semanticTags: dedupeTags([
            ...profile.semanticTags,
            ...(input.extraTags ?? []),
            input.mergeStrategy === 'append_dedupe' ? 'list_fact' : 'singleton_fact',
        ]),
    };
}

export interface SemanticFilter {
    domains?: string[];
    intents?: string[];
    scopes?: string[];
    tags?: string[];
}

export function semanticMatchScore(properties: Record<string, unknown> | null | undefined, filter: SemanticFilter): number {
    if (!properties || !filter) return 0;

    let matches = 0;
    let criteria = 0;

    if (filter.domains && filter.domains.length > 0) {
        criteria++;
        const domain = typeof properties.semanticDomain === 'string' ? properties.semanticDomain : '';
        if (filter.domains.includes(domain)) matches++;
    }

    if (filter.intents && filter.intents.length > 0) {
        criteria++;
        const intent = typeof properties.semanticIntent === 'string' ? properties.semanticIntent : '';
        if (filter.intents.includes(intent)) matches++;
    }

    if (filter.scopes && filter.scopes.length > 0) {
        criteria++;
        const scope = typeof properties.temporalScope === 'string' ? properties.temporalScope : '';
        if (filter.scopes.includes(scope)) matches++;
    }

    if (filter.tags && filter.tags.length > 0) {
        criteria++;
        const tags = Array.isArray(properties.semanticTags) ? properties.semanticTags as string[] : [];
        if (filter.tags.some((t) => tags.includes(t))) matches++;
    }

    return criteria > 0 ? matches / criteria : 0;
}
