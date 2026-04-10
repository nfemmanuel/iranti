/**
 * Unit tests for compliance task-relevance checking.
 *
 * Verifies that injectedFactsAreTaskRelevant correctly distinguishes
 * between task-relevant and task-irrelevant injected facts, preventing
 * false-positive compliance violations when a session spans multiple
 * task domains on the same entity.
 *
 * In-memory — no DB required.
 */

import assert from 'node:assert/strict';
import { injectedFactsAreTaskRelevant } from '../../src/attendant/AttendantInstance';

function main(): void {
    // ─── No task context → always relevant ────────────────────────────────

    assert.ok(
        injectedFactsAreTaskRelevant(
            undefined,
            ['project/iranti/ci_status'],
            ['CI all green for commit abc123'],
        ),
        'Expected undefined task context to be treated as relevant.',
    );

    assert.ok(
        injectedFactsAreTaskRelevant(
            '',
            ['project/iranti/ci_status'],
            ['CI all green for commit abc123'],
        ),
        'Expected empty task context to be treated as relevant.',
    );

    // ─── Key-based relevance ──────────────────────────────────────────────

    assert.ok(
        injectedFactsAreTaskRelevant(
            'Fix the release pipeline and publish packages',
            ['project/iranti/release_v0321_publish_status'],
            ['v0.3.21 fully published'],
        ),
        'Expected key containing "release" to match task about release pipeline.',
    );

    assert.ok(
        injectedFactsAreTaskRelevant(
            'Review and update the compliance scorer logic',
            ['project/iranti/compliance_false_positive_fix'],
            ['Compliance scorer needs task-relevance check'],
        ),
        'Expected key containing "compliance" to match task about compliance scorer.',
    );

    // ─── Summary-based relevance (≥2 content token matches) ──────────────

    assert.ok(
        injectedFactsAreTaskRelevant(
            'Implement the compliance scorer false positive fix for task-irrelevant injected facts',
            ['project/iranti/some_unrelated_key'],
            ['Compliance scorer penalizes agents for not using injected facts that are task-irrelevant'],
        ),
        'Expected summary with multiple matching tokens to be relevant.',
    );

    // ─── Task-irrelevant facts ────────────────────────────────────────────

    assert.ok(
        !injectedFactsAreTaskRelevant(
            'Write marketing copy for the Hacker News launch post',
            ['project/iranti/ci_status_890357a8', 'project/iranti/release_v0321_publish_status'],
            [
                'CI all green for commit 890357a8: write-guard hooks and Codex protocol reminder',
                'v0.3.21 fully published: iranti npm, iranti sdk npm, iranti PyPI',
            ],
        ),
        'Expected CI/release facts to be irrelevant to marketing copy task.',
    );

    assert.ok(
        !injectedFactsAreTaskRelevant(
            'Draft the product landing page content and hero section',
            ['project/iranti/codex_setup_scaffold_status', 'project/iranti/alpha_test_bug_triage'],
            [
                'Codex setup scaffold updated integration files for iranti',
                'Alpha test bug triage: BUG-002 provider key separation resolved',
            ],
        ),
        'Expected codex setup and bug triage facts to be irrelevant to landing page task.',
    );

    assert.ok(
        !injectedFactsAreTaskRelevant(
            'Design the onboarding flow for new users',
            ['project/iranti/checkpoint_summary', 'project/iranti/current_step'],
            [
                'checkpoint summary: current step Release complete',
                'current step is Release complete — v0.3.21 GitHub Release created',
            ],
        ),
        'Expected release checkpoint facts to be irrelevant to onboarding design task.',
    );

    // ─── Edge: single summary token match is not enough ───────────────────

    assert.ok(
        !injectedFactsAreTaskRelevant(
            'Update the project README with better examples',
            ['project/iranti/ci_status_abc'],
            ['CI passed for the project build pipeline after security patches'],
        ),
        'Expected single overlapping word "project" (>5 chars) to be insufficient for relevance.',
    );

    // ─── Task-relevant via key even when summaries don't match ───────────

    assert.ok(
        injectedFactsAreTaskRelevant(
            'Debug the checkpoint recovery flow',
            ['project/iranti/checkpoint_recovery_status'],
            ['Some unrelated summary about weather patterns'],
        ),
        'Expected key containing "checkpoint" and "recovery" to match task about checkpoint recovery.',
    );

    // ─── Mixed: one relevant and one irrelevant key ──────────────────────

    assert.ok(
        injectedFactsAreTaskRelevant(
            'Fix the release publish workflow',
            ['project/iranti/ci_unrelated_key', 'project/iranti/release_workflow_fix'],
            ['CI status green', 'Release workflow needs fixing'],
        ),
        'Expected match when at least one key is relevant to the task.',
    );

    console.log('compliance task-relevance tests passed');
}

main();
