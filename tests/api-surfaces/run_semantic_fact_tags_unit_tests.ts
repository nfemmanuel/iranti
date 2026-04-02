/**
 * Focused unit tests for buildSemanticFactTags and buildIssueFactProperties.
 *
 * These tests are fully in-memory — no DB or network required.
 * They lock the deterministic semantic metadata shape for all durableClass
 * cases so that regressions in the tag builder are caught before integration
 * tests need to run.
 */

import assert from 'node:assert/strict';
import { buildSemanticFactTags } from '../../src/lib/semanticFactTags';
import {
    buildIssueFactProperties,
    buildIssueFactValue,
    issueFactKey,
} from '../../src/lib/issueFacts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function assertSemanticShape(
    result: Record<string, unknown>,
    expected: {
        semanticDomain: string;
        semanticIntent: string;
        temporalScope: string;
        requiredTags: string[];
        forbiddenTags?: string[];
    },
    label: string,
): void {
    assert.equal(result.semanticDomain, expected.semanticDomain, `${label}: semanticDomain`);
    assert.equal(result.semanticIntent, expected.semanticIntent, `${label}: semanticIntent`);
    assert.equal(result.temporalScope, expected.temporalScope, `${label}: temporalScope`);

    const tags = result.semanticTags as string[];
    assert.ok(Array.isArray(tags), `${label}: semanticTags must be an array`);
    for (const tag of expected.requiredTags) {
        assert.ok(tags.includes(tag), `${label}: semanticTags must include '${tag}', got ${JSON.stringify(tags)}`);
    }
    for (const tag of expected.forbiddenTags ?? []) {
        assert.ok(!tags.includes(tag), `${label}: semanticTags must NOT include '${tag}', got ${JSON.stringify(tags)}`);
    }
}

// ─── buildSemanticFactTags — all named durableClass cases ────────────────────

function runBuildSemanticFactTagsTests(): void {
    const cases: Array<{
        durableClass: string;
        mergeStrategy: 'replace' | 'append_dedupe';
        expected: Parameters<typeof assertSemanticShape>[1];
    }> = [
        {
            durableClass: 'preference',
            mergeStrategy: 'replace',
            expected: {
                semanticDomain: 'personal',
                semanticIntent: 'preference_capture',
                temporalScope: 'long_term',
                requiredTags: ['personal_memory', 'preference', 'identity', 'singleton_fact'],
                forbiddenTags: ['list_fact'],
            },
        },
        {
            durableClass: 'profile',
            mergeStrategy: 'replace',
            expected: {
                semanticDomain: 'personal',
                semanticIntent: 'profile_capture',
                temporalScope: 'long_term',
                requiredTags: ['personal_memory', 'profile', 'identity', 'singleton_fact'],
            },
        },
        {
            durableClass: 'decision',
            mergeStrategy: 'replace',
            expected: {
                semanticDomain: 'planning',
                semanticIntent: 'decision_capture',
                temporalScope: 'project_durable',
                requiredTags: ['project_memory', 'decision', 'planning', 'singleton_fact'],
            },
        },
        {
            durableClass: 'next_step',
            mergeStrategy: 'replace',
            expected: {
                semanticDomain: 'planning',
                semanticIntent: 'task_state_tracking',
                temporalScope: 'active_work',
                requiredTags: ['project_memory', 'next_step', 'planning', 'actionable', 'singleton_fact'],
            },
        },
        {
            durableClass: 'current_step',
            mergeStrategy: 'replace',
            expected: {
                semanticDomain: 'planning',
                semanticIntent: 'task_state_tracking',
                temporalScope: 'active_work',
                requiredTags: ['project_memory', 'current_step', 'planning', 'status', 'singleton_fact'],
            },
        },
        {
            durableClass: 'blocker',
            mergeStrategy: 'replace',
            expected: {
                semanticDomain: 'risk',
                semanticIntent: 'risk_tracking',
                temporalScope: 'active_work',
                requiredTags: ['project_memory', 'blocker', 'risk', 'blocking', 'singleton_fact'],
            },
        },
        {
            durableClass: 'owner',
            mergeStrategy: 'replace',
            expected: {
                semanticDomain: 'coordination',
                semanticIntent: 'owner_tracking',
                temporalScope: 'active_work',
                requiredTags: ['project_memory', 'ownership', 'coordination', 'singleton_fact'],
            },
        },
        {
            durableClass: 'open_risks',
            mergeStrategy: 'append_dedupe',
            expected: {
                semanticDomain: 'risk',
                semanticIntent: 'risk_tracking',
                temporalScope: 'active_work',
                requiredTags: ['project_memory', 'risk', 'tracking', 'list_fact'],
                forbiddenTags: ['singleton_fact'],
            },
        },
        {
            durableClass: 'artifact',
            mergeStrategy: 'append_dedupe',
            expected: {
                semanticDomain: 'artifact',
                semanticIntent: 'artifact_tracking',
                temporalScope: 'project_durable',
                requiredTags: ['project_memory', 'artifact', 'reference', 'list_fact'],
            },
        },
        {
            durableClass: 'file_change',
            mergeStrategy: 'append_dedupe',
            expected: {
                semanticDomain: 'artifact',
                semanticIntent: 'change_tracking',
                temporalScope: 'active_work',
                requiredTags: ['project_memory', 'artifact', 'file_change', 'tracking', 'list_fact'],
            },
        },
        {
            durableClass: 'action_log',
            mergeStrategy: 'append_dedupe',
            expected: {
                semanticDomain: 'execution',
                semanticIntent: 'activity_tracking',
                temporalScope: 'active_work',
                requiredTags: ['project_memory', 'activity', 'execution', 'tracking', 'list_fact'],
            },
        },
        {
            durableClass: 'issue_status',
            mergeStrategy: 'replace',
            expected: {
                semanticDomain: 'issue_tracking',
                semanticIntent: 'issue_status_tracking',
                temporalScope: 'project_durable',
                requiredTags: ['project_memory', 'issue', 'status', 'tracking', 'singleton_fact'],
            },
        },
        {
            durableClass: 'failed_path',
            mergeStrategy: 'append_dedupe',
            expected: {
                semanticDomain: 'execution',
                semanticIntent: 'execution_learning',
                temporalScope: 'active_work',
                requiredTags: ['project_memory', 'failure', 'execution_learning', 'list_fact'],
            },
        },
        {
            durableClass: 'alternative_route',
            mergeStrategy: 'append_dedupe',
            expected: {
                semanticDomain: 'execution',
                semanticIntent: 'execution_learning',
                temporalScope: 'active_work',
                requiredTags: ['project_memory', 'recovery', 'execution_learning', 'list_fact'],
            },
        },
        {
            durableClass: 'checkpoint_summary',
            mergeStrategy: 'replace',
            expected: {
                semanticDomain: 'coordination',
                semanticIntent: 'checkpoint_handoff',
                temporalScope: 'active_work',
                requiredTags: ['project_memory', 'checkpoint', 'summary', 'recovery', 'singleton_fact'],
            },
        },
        {
            durableClass: 'scaffold_status',
            mergeStrategy: 'replace',
            expected: {
                semanticDomain: 'integration',
                semanticIntent: 'integration_state_tracking',
                temporalScope: 'project_durable',
                requiredTags: ['project_memory', 'integration', 'scaffold', 'status', 'singleton_fact'],
            },
        },
        {
            durableClass: 'handoff_status',
            mergeStrategy: 'replace',
            expected: {
                semanticDomain: 'coordination',
                semanticIntent: 'handoff_tracking',
                temporalScope: 'active_work',
                requiredTags: ['project_memory', 'handoff', 'status', 'coordination', 'singleton_fact'],
            },
        },
        {
            durableClass: 'handoff_task',
            mergeStrategy: 'replace',
            expected: {
                semanticDomain: 'coordination',
                semanticIntent: 'handoff_tracking',
                temporalScope: 'active_work',
                requiredTags: ['project_memory', 'handoff', 'task_reference', 'coordination', 'singleton_fact'],
            },
        },
    ];

    for (const tc of cases) {
        const result = buildSemanticFactTags({
            memoryScope: tc.durableClass === 'preference' || tc.durableClass === 'profile' ? 'personal' : 'project',
            durableClass: tc.durableClass,
            mergeStrategy: tc.mergeStrategy,
        });
        assertSemanticShape(result, tc.expected, `buildSemanticFactTags(${tc.durableClass})`);
    }

    // Default case — unknown durableClass falls back to generic fact_capture
    const defaultResult = buildSemanticFactTags({
        memoryScope: 'project',
        durableClass: 'unknown_future_class',
        mergeStrategy: 'replace',
    });
    assert.equal(defaultResult.semanticDomain, 'project', 'default: semanticDomain should be project for project scope');
    assert.equal(defaultResult.semanticIntent, 'fact_capture', 'default: semanticIntent should be fact_capture');
    assert.equal(defaultResult.temporalScope, 'active_work', 'default: temporalScope should be active_work for project scope');
    assert.ok(Array.isArray(defaultResult.semanticTags), 'default: semanticTags must be an array');
    assert.ok((defaultResult.semanticTags as string[]).includes('project_memory'), 'default: semanticTags must include project_memory');

    // Personal scope default
    const personalDefaultResult = buildSemanticFactTags({
        memoryScope: 'personal',
        durableClass: 'unknown_personal_class',
        mergeStrategy: 'replace',
    });
    assert.equal(personalDefaultResult.semanticDomain, 'personal', 'personal default: semanticDomain should be personal');
    assert.equal(personalDefaultResult.temporalScope, 'long_term', 'personal default: temporalScope should be long_term');

    // extraTags are included in the output
    const withExtras = buildSemanticFactTags({
        memoryScope: 'project',
        durableClass: 'decision',
        mergeStrategy: 'replace',
        extraTags: ['my_custom_tag', 'another_tag'],
    });
    const withExtrasTags = withExtras.semanticTags as string[];
    assert.ok(withExtrasTags.includes('my_custom_tag'), 'extraTags: custom tag must appear in semanticTags');
    assert.ok(withExtrasTags.includes('another_tag'), 'extraTags: second custom tag must appear in semanticTags');

    // Duplicate tags are deduplicated (case-insensitive)
    const withDupeTags = buildSemanticFactTags({
        memoryScope: 'project',
        durableClass: 'decision',
        mergeStrategy: 'replace',
        extraTags: ['planning', 'PLANNING', 'Planning'],
    });
    const withDupeTagsList = withDupeTags.semanticTags as string[];
    const planningCount = withDupeTagsList.filter((t) => t === 'planning').length;
    assert.equal(planningCount, 1, 'Duplicate tags (case-insensitive) should be deduplicated');

    // append_dedupe adds list_fact, not singleton_fact
    const appendResult = buildSemanticFactTags({
        memoryScope: 'project',
        durableClass: 'artifact',
        mergeStrategy: 'append_dedupe',
    });
    const appendTags = appendResult.semanticTags as string[];
    assert.ok(appendTags.includes('list_fact'), 'append_dedupe mergeStrategy should add list_fact tag');
    assert.ok(!appendTags.includes('singleton_fact'), 'append_dedupe mergeStrategy should NOT add singleton_fact tag');

    // replace adds singleton_fact, not list_fact
    const replaceResult = buildSemanticFactTags({
        memoryScope: 'project',
        durableClass: 'decision',
        mergeStrategy: 'replace',
    });
    const replaceTags = replaceResult.semanticTags as string[];
    assert.ok(replaceTags.includes('singleton_fact'), 'replace mergeStrategy should add singleton_fact tag');
    assert.ok(!replaceTags.includes('list_fact'), 'replace mergeStrategy should NOT add list_fact tag');

    console.log('buildSemanticFactTags unit tests passed');
}

// ─── buildIssueFactProperties — semantic shape of issue writes ───────────────

function runBuildIssueFactPropertiesTests(): void {
    const base = {
        entity: 'project/test_project',
        issueId: 'my-test-issue',
        title: 'My Test Issue',
        status: 'open' as const,
        summary: 'This is a test issue.',
        confidence: 90,
        source: 'IssueFactTest',
        agent: 'test_agent',
    };

    const properties = buildIssueFactProperties(base);

    // Structural fields
    assert.equal(properties.memoryScope, 'project', 'issue properties: memoryScope');
    assert.equal(properties.capturePhase, 'manual', 'issue properties: capturePhase');
    assert.equal(properties.durableClass, 'issue_status', 'issue properties: durableClass');
    assert.equal(properties.mergeStrategy, 'replace', 'issue properties: mergeStrategy');
    assert.equal(properties.canonicalKey, 'issue_my_test_issue', 'issue properties: canonicalKey matches issueFactKey');
    assert.equal(properties.issueId, 'my_test_issue', 'issue properties: issueId normalized');
    assert.equal(properties.issueStatus, 'open', 'issue properties: issueStatus');
    assert.equal(properties.issueSeverity, 'medium', 'issue properties: issueSeverity defaults to medium');
    assert.equal(properties.issueTitle, 'My Test Issue', 'issue properties: issueTitle');

    // Semantic metadata
    assert.equal(properties.semanticDomain, 'issue_tracking', 'issue properties: semanticDomain');
    assert.equal(properties.semanticIntent, 'issue_status_tracking', 'issue properties: semanticIntent');
    assert.equal(properties.temporalScope, 'project_durable', 'issue properties: temporalScope');
    const tags = properties.semanticTags as string[];
    assert.ok(Array.isArray(tags), 'issue properties: semanticTags must be an array');
    assert.ok(tags.includes('project_memory'), 'issue properties: semanticTags includes project_memory');
    assert.ok(tags.includes('issue'), 'issue properties: semanticTags includes issue');
    assert.ok(tags.includes('status'), 'issue properties: semanticTags includes status');
    assert.ok(tags.includes('tracking'), 'issue properties: semanticTags includes tracking');
    assert.ok(tags.includes('singleton_fact'), 'issue properties: semanticTags includes singleton_fact (replace merge)');
    // extra tags from extraTags (status and severity included)
    assert.ok(tags.includes('open'), 'issue properties: semanticTags includes issue status tag');
    assert.ok(tags.includes('medium'), 'issue properties: semanticTags includes default severity tag');

    // Resolved issue
    const resolvedProperties = buildIssueFactProperties({
        ...base,
        issueId: 'resolved-issue',
        status: 'resolved',
        severity: 'high',
        tags: ['my-tag'],
    });
    assert.equal(resolvedProperties.issueStatus, 'resolved', 'resolved issue: issueStatus');
    assert.equal(resolvedProperties.issueSeverity, 'high', 'resolved issue: issueSeverity');
    const resolvedTags = resolvedProperties.semanticTags as string[];
    assert.ok(resolvedTags.includes('resolved'), 'resolved issue: semanticTags includes resolved status');
    assert.ok(resolvedTags.includes('high'), 'resolved issue: semanticTags includes high severity');
    assert.ok(resolvedTags.includes('my-tag'), 'resolved issue: semanticTags includes custom tag');

    // issueFactKey normalization
    assert.equal(issueFactKey('my-test-issue'), 'issue_my_test_issue', 'issueFactKey: normalizes hyphens to underscores');
    assert.equal(issueFactKey('  My Issue  '), 'issue_my_issue', 'issueFactKey: trims and lowercases');
    assert.equal(issueFactKey('issue123'), 'issue_issue123', 'issueFactKey: prepends issue_ prefix');

    // buildIssueFactValue shape
    const value = buildIssueFactValue(base);
    assert.equal(value.issueId, 'my_test_issue', 'issueFactValue: issueId normalized');
    assert.equal(value.title, 'My Test Issue', 'issueFactValue: title');
    assert.equal(value.status, 'open', 'issueFactValue: status');
    assert.equal(value.severity, 'medium', 'issueFactValue: severity defaults to medium');
    assert.equal(value.resolvedAt, null, 'issueFactValue: resolvedAt is null for open issues');
    assert.equal(value.resolution, null, 'issueFactValue: resolution is null for open issues');

    console.log('buildIssueFactProperties unit tests passed');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    runBuildSemanticFactTagsTests();
    runBuildIssueFactPropertiesTests();
    console.log('All semantic fact tags unit tests passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
