/**
 * Unit tests for semantic tag-aware retrieval: the semanticMatchScore
 * function and SemanticFilter type.
 *
 * In-memory — no DB required. Tests the matching logic.
 */

import assert from 'node:assert/strict';
import { buildSemanticFactTags, semanticMatchScore } from '../../src/lib/semanticFactTags';
import type { SemanticFilter } from '../../src/lib/semanticFactTags';

// ─── Test Scenarios ─────────────────────────────────────────────────────────

function testA_exactDomainMatch() {
    const props = buildSemanticFactTags({
        memoryScope: 'project',
        durableClass: 'blocker',
        mergeStrategy: 'replace',
    });
    const filter: SemanticFilter = { domains: ['risk'] };

    const score = semanticMatchScore(props, filter);
    assert.equal(score, 1, 'Scenario A: blocker → risk domain → score 1');
    console.log(`  ✓ Scenario A: risk domain match → score ${score}`);
}

function testB_domainMismatch() {
    const props = buildSemanticFactTags({
        memoryScope: 'project',
        durableClass: 'preference',
        mergeStrategy: 'replace',
    });
    const filter: SemanticFilter = { domains: ['risk'] };

    const score = semanticMatchScore(props, filter);
    assert.equal(score, 0, 'Scenario B: preference is personal domain, not risk → score 0');
    console.log(`  ✓ Scenario B: domain mismatch → score ${score}`);
}

function testC_multiCriteriaPartialMatch() {
    const props = buildSemanticFactTags({
        memoryScope: 'project',
        durableClass: 'next_step',
        mergeStrategy: 'replace',
    });
    // next_step: domain=planning, intent=task_state_tracking, scope=active_work
    const filter: SemanticFilter = {
        domains: ['planning'],
        intents: ['risk_tracking'],  // mismatch
    };

    const score = semanticMatchScore(props, filter);
    assert.equal(score, 0.5, 'Scenario C: 1/2 criteria match → score 0.5');
    console.log(`  ✓ Scenario C: partial multi-criteria match → score ${score}`);
}

function testD_fullMatch() {
    const props = buildSemanticFactTags({
        memoryScope: 'project',
        durableClass: 'next_step',
        mergeStrategy: 'replace',
    });
    const filter: SemanticFilter = {
        domains: ['planning'],
        intents: ['task_state_tracking'],
        scopes: ['active_work'],
    };

    const score = semanticMatchScore(props, filter);
    assert.equal(score, 1, 'Scenario D: 3/3 criteria match → score 1');
    console.log(`  ✓ Scenario D: full multi-criteria match → score ${score}`);
}

function testE_tagMatch() {
    const props = buildSemanticFactTags({
        memoryScope: 'project',
        durableClass: 'next_step',
        mergeStrategy: 'replace',
    });
    // next_step tags include 'actionable'
    const filter: SemanticFilter = { tags: ['actionable'] };

    const score = semanticMatchScore(props, filter);
    assert.equal(score, 1, 'Scenario E: tag match → score 1');
    console.log(`  ✓ Scenario E: tag "actionable" match → score ${score}`);
}

function testF_tagMismatch() {
    const props = buildSemanticFactTags({
        memoryScope: 'project',
        durableClass: 'decision',
        mergeStrategy: 'replace',
    });
    // decision tags: ['project_memory', 'decision', 'planning', 'singleton_fact']
    const filter: SemanticFilter = { tags: ['actionable'] };

    const score = semanticMatchScore(props, filter);
    assert.equal(score, 0, 'Scenario F: tag mismatch → score 0');
    console.log(`  ✓ Scenario F: tag "actionable" not in decision → score ${score}`);
}

function testG_nullProperties() {
    const score = semanticMatchScore(null, { domains: ['risk'] });
    assert.equal(score, 0, 'Scenario G: null properties → score 0');
    console.log(`  ✓ Scenario G: null properties → score ${score}`);
}

function testH_emptyFilter() {
    const props = buildSemanticFactTags({
        memoryScope: 'project',
        durableClass: 'blocker',
        mergeStrategy: 'replace',
    });
    const score = semanticMatchScore(props, {});
    assert.equal(score, 0, 'Scenario H: empty filter → score 0 (no criteria)');
    console.log(`  ✓ Scenario H: empty filter → score ${score}`);
}

function testI_noFilterMeansNoBoost() {
    // When no semantic filter is active, the ranking should not change.
    // This is handled at the call site (semanticBoost = 0 when no filter),
    // but we verify semanticMatchScore returns 0 for empty/undefined filter.
    const props = buildSemanticFactTags({
        memoryScope: 'project',
        durableClass: 'blocker',
        mergeStrategy: 'replace',
    });

    const score1 = semanticMatchScore(props, {} as SemanticFilter);
    assert.equal(score1, 0, 'Scenario I: empty filter → no boost');

    const score2 = semanticMatchScore(props, undefined as unknown as SemanticFilter);
    assert.equal(score2, 0, 'Scenario I: undefined filter → no boost');
    console.log('  ✓ Scenario I: no filter → no boost (regression safe)');
}

function testJ_multiDomainFilter() {
    const riskProps = buildSemanticFactTags({
        memoryScope: 'project',
        durableClass: 'open_risks',
        mergeStrategy: 'append_dedupe',
    });
    const planningProps = buildSemanticFactTags({
        memoryScope: 'project',
        durableClass: 'decision',
        mergeStrategy: 'replace',
    });

    const filter: SemanticFilter = { domains: ['risk', 'planning'] };

    const riskScore = semanticMatchScore(riskProps, filter);
    const planScore = semanticMatchScore(planningProps, filter);

    assert.equal(riskScore, 1, 'Scenario J: risk matches [risk, planning]');
    assert.equal(planScore, 1, 'Scenario J: planning matches [risk, planning]');
    console.log(`  ✓ Scenario J: multi-domain filter → both match`);
}

// ─── Run ─────────────────────────────────────────────────────────────────────

console.log('Running semantic retrieval tests...');

testA_exactDomainMatch();
testB_domainMismatch();
testC_multiCriteriaPartialMatch();
testD_fullMatch();
testE_tagMatch();
testF_tagMismatch();
testG_nullProperties();
testH_emptyFilter();
testI_noFilterMeansNoBoost();
testJ_multiDomainFilter();

console.log('\nAll semantic retrieval tests passed.');
process.exit(0);
