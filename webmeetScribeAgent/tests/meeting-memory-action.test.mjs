import assert from 'node:assert/strict';
import test from 'node:test';

import { action } from '../skills/meeting-memory/src/index.mjs';

const context = {
    previousMemory: 'Admin discussed GPU memory and local models.',
    segments: [{ segmentId: 'next', text: 'Admin moved to autocomplete setup.' }],
    currentMarkdown: '# Local models',
    participants: [{ participantId: 'admin', displayName: 'Admin' }],
};

function agentReturning(memory) {
    return {
        async executePrompt() {
            return { memory };
        },
    };
}

test('meeting-memory accepts bounded structured memory without lexical topic matching', async () => {
    const result = await action({
        context,
        llmAgent: agentReturning('A compact cumulative record.'),
    });
    assert.deepEqual(result, { memory: 'A compact cumulative record.' });
});

test('meeting-memory rejects empty or oversized memory', async () => {
    await assert.rejects(
        action({ context, llmAgent: agentReturning('') }),
        /empty memory/,
    );
    await assert.rejects(
        action({ context, llmAgent: agentReturning('x'.repeat(4_001)) }),
        /oversized memory/,
    );
});
