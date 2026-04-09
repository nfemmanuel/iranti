/**
 * Unit tests for search suggestion stopword filtering.
 *
 * In-memory — no DB required. Tests that tokenizeForSearch filters
 * stopwords and that search suggestions are suppressed for pure chatter.
 */

import assert from 'node:assert/strict';

// Replicate the relevant functions from AttendantInstance for isolated testing

const SEARCH_SUGGESTION_STOPWORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing',
    'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can',
    'you', 'your', 'yours', 'me', 'my', 'mine', 'we', 'our', 'ours',
    'they', 'them', 'their', 'theirs', 'he', 'she', 'his', 'her', 'its',
    'this', 'that', 'these', 'those', 'it',
    'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'for', 'with',
    'from', 'into', 'about', 'after', 'before', 'between', 'under', 'over',
    'some', 'any', 'all', 'each', 'every', 'other', 'more', 'most',
    'very', 'much', 'just', 'also', 'too', 'still', 'own',
    'what', 'how', 'when', 'where', 'which', 'who', 'why',
    'get', 'got', 'let', 'put', 'say', 'tell', 'ask', 'use', 'try',
    'give', 'take', 'make', 'come', 'see', 'look', 'think', 'know',
    'want', 'need', 'keep', 'turn', 'run',
    'way', 'now', 'here', 'there', 'then', 'than',
    'yes', 'no', 'nice', 'okay', 'sure', 'like',
    'new', 'old', 'possible', 'ideas', 'idea',
    'hey', 'per',
]);

function normalizeText(text: string | undefined): string {
    return (text ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenize(text: string | undefined): string[] {
    return normalizeText(text)
        .split(' ')
        .map((part) => part.trim())
        .filter((part) => part.length > 2);
}

function tokenizeForSearch(text: string | undefined): string[] {
    return tokenize(text).filter((token) => !SEARCH_SUGGESTION_STOPWORDS.has(token));
}

// ─── Test Cases ─────────────────────────────────────────────────────────────

function testA_pureChatterYieldsEmpty() {
    const terms = tokenizeForSearch('Give me possible ideas');
    assert.equal(terms.length, 0, 'Scenario A: all-stopword message should yield empty terms');
    console.log('  ✓ Scenario A: "Give me possible ideas" → no search terms');
}

function testB_projectTermsSurvive() {
    const terms = tokenizeForSearch("What's the iranti compliance tracker doing");
    assert.ok(terms.includes('iranti'), `Scenario B: should include "iranti", got ${JSON.stringify(terms)}`);
    assert.ok(terms.includes('compliance'), `Scenario B: should include "compliance", got ${JSON.stringify(terms)}`);
    assert.ok(terms.includes('tracker'), `Scenario B: should include "tracker", got ${JSON.stringify(terms)}`);
    assert.ok(!terms.includes('the'), 'Scenario B: should NOT include "the"');
    assert.ok(!terms.includes('what'), 'Scenario B: should NOT include "what"');
    console.log(`  ✓ Scenario B: project terms survive: ${JSON.stringify(terms)}`);
}

function testC_actionVerbsWithContext() {
    const terms = tokenizeForSearch('Fix the authentication bug');
    assert.ok(terms.includes('fix'), `Scenario C: should include "fix", got ${JSON.stringify(terms)}`);
    assert.ok(terms.includes('authentication'), `Scenario C: should include "authentication", got ${JSON.stringify(terms)}`);
    assert.ok(terms.includes('bug'), `Scenario C: should include "bug", got ${JSON.stringify(terms)}`);
    assert.ok(!terms.includes('the'), 'Scenario C: should NOT include "the"');
    console.log(`  ✓ Scenario C: action verbs with context: ${JSON.stringify(terms)}`);
}

function testD_emptyMessage() {
    const terms = tokenizeForSearch('');
    assert.equal(terms.length, 0, 'Scenario D: empty message yields empty terms');
    console.log('  ✓ Scenario D: empty message → no search terms');
}

function testE_shortGreetings() {
    const terms = tokenizeForSearch('hey nice okay sure');
    assert.equal(terms.length, 0, 'Scenario E: short greetings should be all stopwords');
    console.log('  ✓ Scenario E: short greetings → no search terms');
}

function testF_technicalTermsPreserved() {
    const terms = tokenizeForSearch('refactor the database migration handler');
    assert.ok(terms.includes('refactor'), `Scenario F: should include "refactor", got ${JSON.stringify(terms)}`);
    assert.ok(terms.includes('database'), `Scenario F: should include "database", got ${JSON.stringify(terms)}`);
    assert.ok(terms.includes('migration'), `Scenario F: should include "migration", got ${JSON.stringify(terms)}`);
    assert.ok(terms.includes('handler'), `Scenario F: should include "handler", got ${JSON.stringify(terms)}`);
    console.log(`  ✓ Scenario F: technical terms preserved: ${JSON.stringify(terms)}`);
}

function testG_callSiteSlice() {
    const terms = tokenizeForSearch('refactor the database migration handler service controller endpoint middleware');
    // tokenizeForSearch returns all non-stopword terms; slicing to 6 happens at the call site.
    assert.ok(terms.length > 6, `Scenario G: raw output has more than 6 terms (${terms.length})`);
    const sliced = terms.slice(0, 6);
    assert.equal(sliced.length, 6, 'Scenario G: call-site slice limits to 6');
    assert.ok(!sliced.includes('the'), 'Scenario G: stopwords still filtered after slice');
    console.log(`  ✓ Scenario G: tokenizeForSearch returns ${terms.length} terms, call site slices to ${sliced.length}`);
}

// ─── Run ─────────────────────────────────────────────────────────────────────

console.log('Running search suggestion quality tests...');

testA_pureChatterYieldsEmpty();
testB_projectTermsSurvive();
testC_actionVerbsWithContext();
testD_emptyMessage();
testE_shortGreetings();
testF_technicalTermsPreserved();
testG_callSiteSlice();

console.log('\nAll search suggestion quality tests passed.');
process.exit(0);
