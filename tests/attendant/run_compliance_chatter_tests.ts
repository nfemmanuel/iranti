/**
 * Unit tests for compliance context-awareness: chatter-only turns
 * should not escalate turnsWithoutWrite.
 *
 * In-memory — no DB required. Tests the buildSessionComplianceState function
 * and the mid-turn attend tracking logic.
 */

import assert from 'node:assert/strict';

// We test the exported buildSessionComplianceState indirectly via AttendantInstance,
// but for unit tests we import the function directly.
// Since buildSessionComplianceState is a module-level function (not exported),
// we test through the compliance counters type contract.

type ComplianceInput = {
    attendsWithoutPersist: number;
    turnsWithoutWrite: number;
    midTurnAttendsThisTurn: number;
    consecutivePreResponseWithoutPost: number;
    consecutiveUnusedMemoryInjections: number;
    lastAttendPhase?: 'pre-response' | 'post-response' | 'mid-turn';
    lastUpdated?: string;
};

// Inline the compliance logic for unit testing (mirrors buildSessionComplianceState)
function buildComplianceState(input: ComplianceInput) {
    const PERSISTENCE_WARNING_THRESHOLD = 3;
    const PERSISTENCE_NON_COMPLIANT_THRESHOLD = 5;

    const pendingPostResponse = input.lastAttendPhase === 'pre-response';
    const issues: Array<{ code: string; severity: 'warn' | 'error'; count: number; message: string }> = [];

    if (input.consecutivePreResponseWithoutPost > 0) {
        issues.push({
            code: 'missing_post_response_attend',
            severity: 'error',
            count: input.consecutivePreResponseWithoutPost,
            message: 'Missing post-response attend.',
        });
    }

    if (input.attendsWithoutPersist >= PERSISTENCE_WARNING_THRESHOLD) {
        const severity = input.attendsWithoutPersist >= PERSISTENCE_NON_COMPLIANT_THRESHOLD ? 'error' : 'warn';
        issues.push({
            code: 'missing_durable_persistence',
            severity,
            count: input.attendsWithoutPersist,
            message: `${input.attendsWithoutPersist} attend calls without persist.`,
        });
    }

    if (input.turnsWithoutWrite >= 2) {
        const severity = input.turnsWithoutWrite >= 3 ? 'error' : 'warn';
        issues.push({
            code: 'missing_writes_across_turns',
            severity,
            count: input.turnsWithoutWrite,
            message: `${input.turnsWithoutWrite} active turns without write.`,
        });
    }

    let status: 'healthy' | 'degraded' | 'non_compliant' = 'healthy';
    if (issues.some((i) => i.severity === 'error')) {
        status = 'non_compliant';
    } else if (issues.length > 0) {
        status = 'degraded';
    }

    return { status, issues, counters: { ...input, pendingPostResponse } };
}

// Simulates the attend phase-tracking logic from AttendantInstance
class ComplianceSimulator {
    attendsWithoutPersist = 0;
    turnsWithoutWrite = 0;
    midTurnAttendsThisTurn = 0;
    writeOccurredThisTurn = false;
    consecutivePreResponseWithoutPost = 0;
    consecutiveUnusedMemoryInjections = 0;
    lastAttendPhase: 'pre-response' | 'post-response' | 'mid-turn' | undefined = undefined;

    attend(phase?: 'pre-response' | 'post-response' | 'mid-turn') {
        this.attendsWithoutPersist++;

        if (phase === 'post-response') {
            this.attendsWithoutPersist = 0;
            if (this.midTurnAttendsThisTurn > 0 && !this.writeOccurredThisTurn) {
                this.turnsWithoutWrite++;
            }
            this.midTurnAttendsThisTurn = 0;
            this.writeOccurredThisTurn = false;
            this.lastAttendPhase = 'post-response';
            this.consecutivePreResponseWithoutPost = 0;
        } else if (phase === 'pre-response') {
            if (this.lastAttendPhase === 'pre-response') {
                this.consecutivePreResponseWithoutPost++;
            } else {
                this.consecutivePreResponseWithoutPost = 0;
            }
            this.midTurnAttendsThisTurn = 0;
            this.writeOccurredThisTurn = false;
            this.lastAttendPhase = 'pre-response';
        } else if (phase === 'mid-turn') {
            this.midTurnAttendsThisTurn++;
            this.lastAttendPhase = 'mid-turn';
        } else {
            this.midTurnAttendsThisTurn++;
        }
    }

    notifyWriteOccurred() {
        this.attendsWithoutPersist = 0;
        this.turnsWithoutWrite = 0;
        this.writeOccurredThisTurn = true;
        this.consecutivePreResponseWithoutPost = 0;
    }

    getComplianceState() {
        return buildComplianceState({
            attendsWithoutPersist: this.attendsWithoutPersist,
            turnsWithoutWrite: this.turnsWithoutWrite,
            midTurnAttendsThisTurn: this.midTurnAttendsThisTurn,
            consecutivePreResponseWithoutPost: this.consecutivePreResponseWithoutPost,
            consecutiveUnusedMemoryInjections: this.consecutiveUnusedMemoryInjections,
            lastAttendPhase: this.lastAttendPhase,
        });
    }
}

function runChatterTurn(sim: ComplianceSimulator) {
    sim.attend('pre-response');
    sim.attend('post-response');
}

function runActiveTurn(sim: ComplianceSimulator, writeAfter = false) {
    sim.attend('pre-response');
    sim.attend('mid-turn');
    if (writeAfter) {
        sim.notifyWriteOccurred();
    }
    sim.attend('post-response');
}

// ─── Test Scenarios ─────────────────────────────────────────────────────────

function testA_chatterTurnsStayHealthy() {
    const sim = new ComplianceSimulator();

    // 3 pure chatter turns: pre → post, no mid-turn attends
    runChatterTurn(sim);
    runChatterTurn(sim);
    runChatterTurn(sim);

    const state = sim.getComplianceState();
    assert.equal(state.status, 'healthy', 'Scenario A: 3 chatter turns should stay healthy');
    assert.equal(state.counters.turnsWithoutWrite, 0, 'Scenario A: turnsWithoutWrite should be 0 for chatter turns');
    console.log('  ✓ Scenario A: 3 chatter turns → healthy');
}

function testB_activeTurnsEscalate() {
    const sim = new ComplianceSimulator();

    // 3 active turns with mid-turn attends but no writes
    runActiveTurn(sim);
    runActiveTurn(sim);
    runActiveTurn(sim);

    const state = sim.getComplianceState();
    assert.equal(state.status, 'non_compliant', 'Scenario B: 3 active turns without write should be non_compliant');
    assert.equal(state.counters.turnsWithoutWrite, 3, 'Scenario B: turnsWithoutWrite should be 3');
    console.log('  ✓ Scenario B: 3 active turns without write → non_compliant');
}

function testC_mixedTurnsWithWrite() {
    const sim = new ComplianceSimulator();

    // 2 chatter turns, 1 active turn with write
    runChatterTurn(sim);
    runChatterTurn(sim);
    runActiveTurn(sim, true);

    const state = sim.getComplianceState();
    assert.equal(state.status, 'healthy', 'Scenario C: mixed turns with write should stay healthy');
    assert.equal(state.counters.turnsWithoutWrite, 0, 'Scenario C: turnsWithoutWrite resets after write');
    console.log('  ✓ Scenario C: 2 chatter + 1 active with write → healthy');
}

function testD_writeResets() {
    const sim = new ComplianceSimulator();

    // Active turn without write, then write
    runActiveTurn(sim);
    assert.equal(sim.turnsWithoutWrite, 1, 'Scenario D: 1 active turn without write');

    sim.notifyWriteOccurred();
    assert.equal(sim.turnsWithoutWrite, 0, 'Scenario D: write resets counter');

    const state = sim.getComplianceState();
    assert.equal(state.status, 'healthy', 'Scenario D: healthy after write');
    console.log('  ✓ Scenario D: active turn + write → counter resets');
}

function testE_noPhaseMeansActivity() {
    const sim = new ComplianceSimulator();

    // Turns with no-phase attend calls (legacy behavior counts as activity)
    sim.attend('pre-response');
    sim.attend(); // no phase = activity signal
    sim.attend('post-response');

    sim.attend('pre-response');
    sim.attend(); // no phase = activity signal
    sim.attend('post-response');

    const state = sim.getComplianceState();
    assert.equal(state.counters.turnsWithoutWrite, 2, 'Scenario E: no-phase attends count as activity');
    assert.equal(state.status, 'degraded', 'Scenario E: degraded after 2 active turns without write');
    console.log('  ✓ Scenario E: no-phase attends → counts as activity');
}

// ─── Run ─────────────────────────────────────────────────────────────────────

console.log('Running compliance chatter awareness tests...');

testA_chatterTurnsStayHealthy();
testB_activeTurnsEscalate();
testC_mixedTurnsWithWrite();
testD_writeResets();
testE_noPhaseMeansActivity();

console.log('\nAll compliance chatter tests passed.');
process.exit(0);
