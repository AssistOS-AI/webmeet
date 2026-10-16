import assert from 'node:assert/strict';
import test from 'node:test';

import { HolisticMeetingNotesAnalyzer } from '../lib/holistic-analyzer.mjs';

test('every revision reconciles its complete bounded discussion context with the current document', async () => {
    const calls = [];
    class FakeMainAgent {
        async executeSkill(skill, prompt, options) {
            calls.push({ skill, prompt: JSON.parse(prompt), context: options.context });
            return { result: '# Topic\n\n## Summary\n\nNotes' };
        }
    }
    const analyzer = new HolisticMeetingNotesAnalyzer({ MainAgent: FakeMainAgent });
    const first = { segmentId: 'one', text: 'First proposal' };
    const second = { segmentId: 'two', text: 'Later correction' };

    await analyzer.analyze({ journal: [first], currentMarkdown: '# First', participants: [], structurePrompt: 'First structure' });
    await analyzer.analyze({ journal: [first, second], currentMarkdown: '# Existing', participants: [], structurePrompt: 'Highlights\nActions' });

    assert.equal(calls[1].skill, 'meeting-notes');
    assert.deepEqual(calls[1].context.journal, [first, second]);
    assert.equal(calls[1].context.currentMarkdown, '# Existing');
    assert.equal(calls[1].context.structurePrompt, 'Highlights\nActions');
    assert.equal(calls[1].prompt.task, 'reconcile-complete-meeting-document');
});

test('long-meeting compaction carries previous memory into the replacement memory skill', async () => {
    const calls = [];
    class FakeMainAgent {
        async executeSkill(skill, prompt, options) {
            calls.push({ skill, prompt: JSON.parse(prompt), context: options.context });
            return { result: { memory: 'old context plus the next chronological range' } };
        }
    }
    const analyzer = new HolisticMeetingNotesAnalyzer({ MainAgent: FakeMainAgent });
    const memory = await analyzer.compact({
        previousMemory: 'old context',
        segments: [{ segmentId: 'next', text: 'a correction' }],
        currentMarkdown: '# Current notes',
        participants: [{ participantId: 'p1', displayName: 'Ana' }],
    });

    assert.equal(memory, 'old context plus the next chronological range');
    assert.equal(calls[0].skill, 'meeting-memory');
    assert.equal(calls[0].context.previousMemory, 'old context');
    assert.equal(calls[0].context.segments[0].segmentId, 'next');
});
