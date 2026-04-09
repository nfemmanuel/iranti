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

function deriveSemanticProfile(memoryScope: SemanticMemoryScope, durableClass: string): SemanticProfile {
    switch (durableClass) {
        case 'preference':
            return {
                semanticDomain: 'personal',
                semanticIntent: 'preference_capture',
                temporalScope: 'long_term',
                semanticTags: ['personal_memory', 'preference', 'identity'],
            };
        case 'profile':
            return {
                semanticDomain: 'personal',
                semanticIntent: 'profile_capture',
                temporalScope: 'long_term',
                semanticTags: ['personal_memory', 'profile', 'identity'],
            };
        case 'decision':
            return {
                semanticDomain: 'planning',
                semanticIntent: 'decision_capture',
                temporalScope: 'project_durable',
                semanticTags: ['project_memory', 'decision', 'planning'],
            };
        case 'next_step':
            return {
                semanticDomain: 'planning',
                semanticIntent: 'task_state_tracking',
                temporalScope: 'active_work',
                semanticTags: ['project_memory', 'next_step', 'planning', 'actionable'],
            };
        case 'current_step':
            return {
                semanticDomain: 'planning',
                semanticIntent: 'task_state_tracking',
                temporalScope: 'active_work',
                semanticTags: ['project_memory', 'current_step', 'planning', 'status'],
            };
        case 'blocker':
            return {
                semanticDomain: 'risk',
                semanticIntent: 'risk_tracking',
                temporalScope: 'active_work',
                semanticTags: ['project_memory', 'blocker', 'risk', 'blocking'],
            };
        case 'owner':
            return {
                semanticDomain: 'coordination',
                semanticIntent: 'owner_tracking',
                temporalScope: 'active_work',
                semanticTags: ['project_memory', 'ownership', 'coordination'],
            };
        case 'open_risks':
            return {
                semanticDomain: 'risk',
                semanticIntent: 'risk_tracking',
                temporalScope: 'active_work',
                semanticTags: ['project_memory', 'risk', 'tracking', 'list_fact'],
            };
        case 'artifact':
            return {
                semanticDomain: 'artifact',
                semanticIntent: 'artifact_tracking',
                temporalScope: 'project_durable',
                semanticTags: ['project_memory', 'artifact', 'reference', 'list_fact'],
            };
        case 'file_change':
            return {
                semanticDomain: 'artifact',
                semanticIntent: 'change_tracking',
                temporalScope: 'active_work',
                semanticTags: ['project_memory', 'artifact', 'file_change', 'tracking', 'list_fact'],
            };
        case 'action_log':
            return {
                semanticDomain: 'execution',
                semanticIntent: 'activity_tracking',
                temporalScope: 'active_work',
                semanticTags: ['project_memory', 'activity', 'execution', 'tracking', 'list_fact'],
            };
        case 'issue_status':
            return {
                semanticDomain: 'issue_tracking',
                semanticIntent: 'issue_status_tracking',
                temporalScope: 'project_durable',
                semanticTags: ['project_memory', 'issue', 'status', 'tracking'],
            };
        case 'failed_path':
            return {
                semanticDomain: 'execution',
                semanticIntent: 'execution_learning',
                temporalScope: 'active_work',
                semanticTags: ['project_memory', 'failure', 'execution_learning', 'list_fact'],
            };
        case 'alternative_route':
            return {
                semanticDomain: 'execution',
                semanticIntent: 'execution_learning',
                temporalScope: 'active_work',
                semanticTags: ['project_memory', 'recovery', 'execution_learning', 'list_fact'],
            };
        case 'checkpoint_summary':
            return {
                semanticDomain: 'coordination',
                semanticIntent: 'checkpoint_handoff',
                temporalScope: 'active_work',
                semanticTags: ['project_memory', 'checkpoint', 'summary', 'recovery'],
            };
        case 'scaffold_status':
            return {
                semanticDomain: 'integration',
                semanticIntent: 'integration_state_tracking',
                temporalScope: 'project_durable',
                semanticTags: ['project_memory', 'integration', 'scaffold', 'status'],
            };
        case 'handoff_status':
            return {
                semanticDomain: 'coordination',
                semanticIntent: 'handoff_tracking',
                temporalScope: 'active_work',
                semanticTags: ['project_memory', 'handoff', 'status', 'coordination'],
            };
        case 'handoff_task':
            return {
                semanticDomain: 'coordination',
                semanticIntent: 'handoff_tracking',
                temporalScope: 'active_work',
                semanticTags: ['project_memory', 'handoff', 'task_reference', 'coordination'],
            };
        default:
            return {
                semanticDomain: memoryScope === 'personal' ? 'personal' : 'project',
                semanticIntent: 'fact_capture',
                temporalScope: memoryScope === 'personal' ? 'long_term' : 'active_work',
                semanticTags: [memoryScope === 'personal' ? 'personal_memory' : 'project_memory'],
            };
    }
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
