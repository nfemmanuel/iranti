import assert from 'node:assert/strict';
import { buildGracefulShutdownCheckpoint, buildMemoryBlock } from '../../src/chat/index';

function main(): void {
    const empty = buildGracefulShutdownCheckpoint([], []);
    assert.equal(empty, null, 'Expected no shutdown checkpoint when chat history is empty.');

    const payload = buildGracefulShutdownCheckpoint([
        { role: 'user', content: 'Can you summarize what we changed in the runtime authority work?' },
        { role: 'assistant', content: 'We patched doctor so repo-root checks surface nearby binding authority and DB divergence.' },
        { role: 'user', content: 'Cool, what should we do next?' },
    ], [
        {
            entityKey: 'project/iranti/next_step',
            summary: 'next step is graceful shutdown checkpointing',
            value: { text: 'graceful shutdown checkpointing' },
            confidence: 92,
            source: 'test',
        },
    ]);

    assert.ok(payload, 'Expected a shutdown checkpoint payload when history exists.');
    assert.match(payload?.currentStep ?? '', /latest user request/i, 'Expected shutdown checkpoint to preserve the latest user request.');
    assert.equal(payload?.nextStep, 'Review the recent conversation outputs and continue the chat if applicable.');
    assert.equal(payload?.recentOutputs?.length, 3, 'Expected recent outputs to preserve the recent chat transcript.');
    assert.match(payload?.recentOutputs?.[0] ?? '', /^User:/, 'Expected user turns to be labeled in checkpoint outputs.');
    assert.match(payload?.recentOutputs?.[1] ?? '', /^Assistant:/, 'Expected assistant turns to be labeled in checkpoint outputs.');
    assert.match(payload?.openRisks?.[0] ?? '', /queued memory injection\(s\)/i, 'Expected pending manual injections to be surfaced as an open risk.');
    assert.match(payload?.notes ?? '', /exited gracefully/i, 'Expected graceful-exit note in shutdown checkpoint payload.');

    const memoryBlock = buildMemoryBlock([
        {
            factId: 'F1',
            entityKey: 'project/iranti/current_step',
            summary: 'current step is verify the host contract',
            value: { text: 'verify the host contract' },
            confidence: 95,
            source: 'test',
        },
        {
            factId: 'F2',
            entityKey: 'project/iranti/next_step',
            summary: 'next step is rerun the chat host regression',
            value: { instruction: 'rerun the chat host regression' },
            confidence: 93,
            source: 'test',
        },
    ]);
    assert.match(memoryBlock, /\[Iranti Retrieved Memory\]/, 'Expected chat memory blocks to use the shared structured memory title.');
    assert.match(memoryBlock, /F1 \| entity=project\/iranti \| key=current_step/, 'Expected chat memory blocks to surface stable fact IDs and parsed entity/key fields.');
    assert.match(memoryBlock, /Prefer the injected facts below before re-inference\./, 'Expected chat memory blocks to instruct the model to prefer injected facts.');
    assert.match(memoryBlock, /value: \{\"text\":\"verify the host contract\"\}/, 'Expected chat memory blocks to preserve structured values.');

    console.log('chat shutdown checkpoint tests passed');
}

main();
