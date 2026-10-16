import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserMeetingNotesTranscription } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/browser-meeting-notes-transcription.js';
import { parseMeetingNotesTranscriptSegment } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/meeting-notes-protocol.js';

class FakeRecognition {
    static instances = [];
    constructor() {
        FakeRecognition.instances.push(this);
        this.lang = '';
    }
    start() { this.onstart?.(); }
    abort() { this.aborted = true; }
    emit(text, isFinal = true, resultIndex = 0) {
        const result = [{ transcript: text }];
        result.isFinal = isFinal;
        const results = Array.from({ length: resultIndex + 1 }, () => ({ isFinal: false }));
        results[resultIndex] = result;
        this.onresult?.({ resultIndex, results });
    }
}

function harness({ microphone = true, enabled = true } = {}) {
    FakeRecognition.instances = [];
    const published = [];
    const secretary = {
        identity: 'meeting-secretary-job-1',
        attributes: { webmeetMeetingSecretary: 'true' },
    };
    const documentRef = new EventTarget();
    documentRef.visibilityState = 'visible';
    const windowRef = {
        document: documentRef,
        setTimeout,
        clearTimeout,
    };
    const room = {
        remoteParticipants: new Map([[secretary.identity, secretary]]),
        localParticipant: {
            async publishData(bytes, options) { published.push({ bytes, options }); },
        },
    };
    const service = new BrowserMeetingNotesTranscription({
        RecognitionClass: FakeRecognition,
        windowRef,
        navigatorRef: { language: 'ro-RO' },
        getRoom: () => room,
        getEnabled: () => enabled,
        getMicrophoneEnabled: () => microphone,
        restartDelayMs: 5,
    });
    return { service, published, room, documentRef };
}

test('publishes only final, deduplicated transcript segments to the secretary', async () => {
    const { service, published } = harness();
    assert.equal(service.sync(), true);
    const recognition = FakeRecognition.instances[0];
    recognition.emit('idee intermediară', false);
    recognition.emit('Propun să lansăm pilotul', true);
    recognition.emit('Propun să lansăm pilotul', true);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(published.length, 1);
    assert.deepEqual(published[0].options.destinationIdentities, ['meeting-secretary-job-1']);
    assert.equal(published[0].options.reliable, true);
    const parsed = parseMeetingNotesTranscriptSegment(new TextDecoder().decode(published[0].bytes));
    assert.equal(parsed.text, 'Propun să lansăm pilotul');
    assert.equal(parsed.sequence, 1);
    service.destroy();
});

test('retries the same final segment after a transient LiveKit publish failure', async () => {
    const { service, published, room } = harness();
    service.deliveryRetryMs = 5;
    let attempts = 0;
    room.localParticipant.publishData = async (bytes, options) => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary data-channel failure');
        published.push({ bytes, options });
    };
    service.sync();
    FakeRecognition.instances[0].emit('Decizia trebuie păstrată', true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(attempts, 2);
    assert.equal(published.length, 1);
    const parsed = parseMeetingNotesTranscriptSegment(new TextDecoder().decode(published[0].bytes));
    assert.equal(parsed.sequence, 1);
    assert.equal(parsed.text, 'Decizia trebuie păstrată');
    service.destroy();
});

test('keeps legitimate repeated speech from separate recognition results', async () => {
    const { service, published } = harness();
    service.sync();
    const recognition = FakeRecognition.instances[0];
    recognition.emit('Sunt de acord', true, 0);
    recognition.emit('Sunt de acord', true, 1);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(published.length, 2);
    service.destroy();
});

test('does not listen while the local microphone is muted', () => {
    const { service } = harness({ microphone: false });
    assert.equal(service.sync(), false);
    assert.equal(FakeRecognition.instances.length, 0);
    service.destroy();
});

test('stops when the secretary is unavailable', () => {
    const { service, room } = harness();
    service.sync();
    const recognition = FakeRecognition.instances[0];
    room.remoteParticipants.clear();
    assert.equal(service.sync(), false);
    assert.equal(recognition.aborted, true);
    service.destroy();
});
