import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createMeetingAnalysisSnapshot,
    selectMeetingAnalysisTargetCount,
    selectMeetingMemoryCompaction,
} from '../lib/context-window.mjs';

test('analysis checkpoints never mark segments that arrived after the snapshot', () => {
    const state = {
        segments: [{ segmentId: 'one', text: 'first' }],
        compactedSegmentCount: 0,
        currentMarkdown: '# Current',
        documentSnapshot: {
            documentId: 'document-1',
            heads: ['head-1'],
            stateBase64: 'snapshot',
            markdown: '# Current',
        },
    };
    const snapshot = createMeetingAnalysisSnapshot(state);
    state.segments.push({ segmentId: 'two', text: 'arrived during analysis' });

    assert.equal(snapshot.targetSegmentCount, 1);
    assert.deepEqual(snapshot.journal.map((entry) => entry.segmentId), ['one']);
    assert.deepEqual(snapshot.newSegmentIds, ['one']);
    assert.deepEqual(snapshot.documentSnapshot, state.documentSnapshot);
    state.documentSnapshot.heads.push('head-2');
    assert.deepEqual(snapshot.documentSnapshot.heads, ['head-1']);
    assert.equal(state.segments.length - snapshot.targetSegmentCount, 1);
});

test('a captured analysis checkpoint excludes text received while earlier work is running', () => {
    const state = {
        segments: [
            { segmentId: 'one', text: 'first topic' },
            { segmentId: 'two', text: 'newer topic' },
        ],
        analyzedSegmentCount: 0,
        compactedSegmentCount: 0,
    };
    const snapshot = createMeetingAnalysisSnapshot(state, { targetSegmentCount: 1 });
    assert.equal(snapshot.targetSegmentCount, 1);
    assert.deepEqual(snapshot.journal.map((entry) => entry.segmentId), ['one']);
    assert.deepEqual(snapshot.newSegmentIds, ['one']);
});

test('long raw journals compact oldest ranges while retaining recent raw context', () => {
    const state = {
        segments: Array.from({ length: 20 }, (_, index) => ({
            segmentId: `segment-${index}`,
            text: 'context '.repeat(20),
        })),
        compactedSegmentCount: 0,
        analyzedSegmentCount: 20,
    };
    const selection = selectMeetingMemoryCompaction(state, {
        maxRawBytes: 1_000,
        maxBatchBytes: 600,
    });
    assert.ok(selection);
    assert.equal(selection.start, 0);
    assert.ok(selection.end > selection.start);
    assert.ok(selection.end < state.segments.length);
});

test('memory compaction never consumes transcript that is still pending publication', () => {
    const state = {
        segments: Array.from({ length: 12 }, (_, index) => ({
            segmentId: `segment-${index}`,
            text: 'long pending context '.repeat(20),
        })),
        compactedSegmentCount: 4,
        analyzedSegmentCount: 6,
    };
    const selection = selectMeetingMemoryCompaction(state, {
        maxRawBytes: 100,
        maxBatchBytes: 2_000,
    });

    assert.ok(selection);
    assert.equal(selection.start, 4);
    assert.ok(selection.end <= state.analyzedSegmentCount);
    assert.deepEqual(
        selection.segments.map((entry) => entry.segmentId),
        state.segments.slice(selection.start, selection.end).map((entry) => entry.segmentId),
    );
});

test('legacy recovery state does not compact farther when compacted cursor passed analyzed cursor', () => {
    const state = {
        segments: Array.from({ length: 12 }, (_, index) => ({
            segmentId: `segment-${index}`,
            text: 'context '.repeat(30),
        })),
        compactedSegmentCount: 8,
        analyzedSegmentCount: 5,
    };

    assert.equal(selectMeetingMemoryCompaction(state, { maxRawBytes: 100 }), null);
});

test('one analysis checkpoint leaves an oversized new backlog for later sequential revisions', () => {
    const state = {
        segments: Array.from({ length: 12 }, (_, index) => ({
            segmentId: `pending-${index}`,
            text: 'new discussion '.repeat(20),
        })),
        analyzedSegmentCount: 0,
    };
    const target = selectMeetingAnalysisTargetCount(state, {
        maxRawBytes: 1_000,
        requestedTargetCount: state.segments.length,
    });
    assert.ok(target > 0);
    assert.ok(target < state.segments.length);
    assert.ok(Buffer.byteLength(JSON.stringify(state.segments.slice(0, target)), 'utf8') <= 1_000);
});
