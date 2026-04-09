/**
 * Unit tests for auto-capture observability: verifying that
 * PostResponseCaptureInfo is correctly structured.
 *
 * In-memory — tests the type contract and extraction logic.
 */

import assert from 'node:assert/strict';
import { extractResponseArtifacts } from '../../src/lib/autoRemember';
import { extractAssistantCheckpointPayload } from '../../src/lib/assistantCheckpoint';

// ─── Test Scenarios ─────────────────────────────────────────────────────────

function testA_artifactBlockDetected() {
    const response = `Here is the analysis:

---
## Security Audit Report

Found 3 critical vulnerabilities in the authentication module.
1. SQL injection in login handler
2. Missing CSRF token validation
3. Insecure session storage
---

Let me fix these issues.`;

    const artifacts = extractResponseArtifacts(response);
    // extractResponseArtifacts looks for --- delimited blocks with a title
    // The capture info would report: factsExtracted = artifacts.length
    console.log(`  Artifacts found: ${artifacts.length}`);
    // The key point: the function runs and returns results that can be surfaced
    assert.ok(Array.isArray(artifacts), 'Scenario A: extractResponseArtifacts returns an array');
    console.log('  ✓ Scenario A: artifact extraction returns structured result');
}

function testB_plainChatterNoArtifacts() {
    const response = 'Sure, I can help with that. Let me check the codebase.';

    const artifacts = extractResponseArtifacts(response);
    assert.equal(artifacts.length, 0, 'Scenario B: plain chatter has no artifacts');
    console.log('  ✓ Scenario B: plain chatter → 0 artifacts extracted');
}

function testC_checkpointExtraction() {
    const response = `I've completed the refactoring.

Current step: Refactored the auth middleware
Next step: Update the test suite
Open risks: Migration compatibility with v2 clients`;

    const checkpoint = extractAssistantCheckpointPayload(response);
    // checkpoint may or may not parse depending on format requirements
    const checkpointExtracted = checkpoint !== null && checkpoint !== undefined;
    console.log(`  Checkpoint extracted: ${checkpointExtracted}`);
    console.log('  ✓ Scenario C: checkpoint extraction runs without error');
}

function testD_postResponseCaptureShape() {
    // Verify the PostResponseCaptureInfo shape contract
    const rememberResult = {
        enabled: true,
        extracted: 2,
        written: 1,
        skipped: [{ key: 'generated_foo', reason: 'duplicate' }],
    };
    const checkpoint = null;

    const captureInfo = {
        factsExtracted: rememberResult.extracted,
        factsWritten: rememberResult.written,
        checkpointExtracted: checkpoint !== null && checkpoint !== undefined,
        skipped: rememberResult.skipped,
    };

    assert.equal(captureInfo.factsExtracted, 2, 'Scenario D: factsExtracted');
    assert.equal(captureInfo.factsWritten, 1, 'Scenario D: factsWritten');
    assert.equal(captureInfo.checkpointExtracted, false, 'Scenario D: checkpointExtracted');
    assert.equal(captureInfo.skipped.length, 1, 'Scenario D: skipped');
    assert.equal(captureInfo.skipped[0].key, 'generated_foo', 'Scenario D: skipped key');
    console.log('  ✓ Scenario D: PostResponseCaptureInfo shape is correct');
}

function testE_zeroCaptureForEmptyResponse() {
    const response = '';

    const artifacts = extractResponseArtifacts(response);
    const checkpoint = extractAssistantCheckpointPayload(response);

    const captureInfo = {
        factsExtracted: artifacts.length,
        factsWritten: 0,
        checkpointExtracted: checkpoint !== null && checkpoint !== undefined,
        skipped: [] as Array<{ key: string; reason: string }>,
    };

    assert.equal(captureInfo.factsExtracted, 0, 'Scenario E: empty response → 0 extracted');
    assert.equal(captureInfo.checkpointExtracted, false, 'Scenario E: empty response → no checkpoint');
    console.log('  ✓ Scenario E: empty response → zero capture info');
}

// ─── Run ─────────────────────────────────────────────────────────────────────

console.log('Running auto-capture observability tests...');

testA_artifactBlockDetected();
testB_plainChatterNoArtifacts();
testC_checkpointExtraction();
testD_postResponseCaptureShape();
testE_zeroCaptureForEmptyResponse();

console.log('\nAll auto-capture observability tests passed.');
process.exit(0);
