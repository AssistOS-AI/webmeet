import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createMicrophoneTestSession } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/audio-processing/microphone-test-session.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const pluginRoot = path.join(repoRoot, 'IDE-plugins/webmeet-tool-button');

test('microphone test session captures processed audio and cleans up resources', async () => {
    let receivedSettings = null;
    let cleanupCalls = 0;
    const session = createMicrophoneTestSession({
        audioInputDeviceId: 'mic-1',
        microphoneGain: 1.2,
        voiceProcessingMode: 'auto',
        humFilter: 'auto'
    }, {
        createProcessedMicrophoneTrack: async (settings) => {
            receivedSettings = settings;
            return {
                processedStream: { id: 'processed-stream' },
                getMetrics: () => ({ rmsDb: -18, speaking: true, clipping: false }),
                cleanup: async () => { cleanupCalls += 1; }
            };
        }
    });

    await session.start();

    assert.equal(receivedSettings.audioInputDeviceId, 'mic-1');
    assert.equal(receivedSettings.microphoneGain, 1.2);
    assert.equal(receivedSettings.voiceProcessingMode, 'auto');
    assert.equal(receivedSettings.humFilter, 'auto');
    assert.equal(session.getStream().id, 'processed-stream');
    assert.equal(session.getMetrics().rmsDb, -18);

    await session.stop();

    assert.equal(cleanupCalls, 1);
    assert.equal(session.getStream(), null);
});

test('microphone test session records a playback sample and revokes it on stop', async () => {
    const revoked = [];
    class FakeMediaRecorder {
        constructor(stream) {
            this.stream = stream;
            this.state = 'inactive';
            this.mimeType = 'audio/webm';
        }

        start() {
            this.state = 'recording';
            this.ondataavailable?.({ data: new Blob(['sample'], { type: this.mimeType }) });
        }

        stop() {
            this.state = 'inactive';
            this.onstop?.();
        }
    }

    const session = createMicrophoneTestSession({}, {
        createProcessedMicrophoneTrack: async () => ({
            processedStream: { id: 'processed-stream' },
            cleanup: async () => {}
        }),
        MediaRecorder: FakeMediaRecorder,
        urlApi: {
            createObjectURL: () => 'blob:sample',
            revokeObjectURL: (url) => revoked.push(url)
        },
        setTimeout: (callback) => {
            callback();
            return 1;
        },
        clearTimeout: () => {}
    });

    await session.start();
    const sample = await session.recordSample(5000);

    assert.equal(sample.url, 'blob:sample');
    assert.equal(sample.blob.type, 'audio/webm');

    await session.stop();

    assert.deepEqual(revoked, ['blob:sample']);
});

test('WebMeet microphone test UI is wired to processed audio settings lifecycle', async () => {
    const dashboardHtml = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashboard/webmeet-dashboard.html'),
        'utf8'
    );
    const dashboardSource = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashboard/webmeet-dashboard.js'),
        'utf8'
    );
    const mediaSettingsSource = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashboard/controllers/media-settings-methods.js'),
        'utf8'
    );
    const sessionSource = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashboard/services/audio-processing/microphone-test-session.js'),
        'utf8'
    );

    assert.match(dashboardHtml, /id="webmeetMicrophoneTestToggleButton"/);
    assert.match(dashboardHtml, /id="webmeetMicrophoneTestRecordButton"/);
    assert.match(dashboardHtml, /id="webmeetMicrophoneTestPlayButton"/);
    assert.match(dashboardHtml, /id="webmeetMicrophoneTestMeterBar"/);
    assert.match(dashboardHtml, /Tests the processed microphone signal WebMeet sends to other participants/);
    assert.match(dashboardSource, /microphoneTest:\s*\{/);
    assert.match(dashboardSource, /this\.microphoneTestToggleButton = this\.element\.querySelector\('#webmeetMicrophoneTestToggleButton'\)/);
    assert.match(mediaSettingsSource, /createMicrophoneTestSession\(this\.getMicrophoneTestSettings\(\)\)/);
    assert.match(mediaSettingsSource, /await this\.stopMicrophoneTest\(\)/);
    assert.match(mediaSettingsSource, /scheduleMicrophoneTestRestart/);
    assert.match(sessionSource, /import \{ createProcessedMicrophoneTrack \}/);
    assert.match(sessionSource, /capture = await createCapture\(settings\)/);
});
