import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const audioProcessingPath = path.join(
    repoRoot,
    'IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/audio-processing/microphone-track-factory.js'
);
const rnnoiseWorkletPath = path.join(
    repoRoot,
    'IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/audio-processing/rnnoise-worklet.js'
);
const mediaControllerPath = path.join(
    repoRoot,
    'IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/webmeet-media-controller.js'
);
const dashboardPath = path.join(
    repoRoot,
    'IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/webmeet-dashboard-modal.js'
);

test('RNNoise initialization timeout disposes the worklet node', async () => {
    const factorySource = await fs.readFile(audioProcessingPath, 'utf8');
    const workletSource = await fs.readFile(rnnoiseWorkletPath, 'utf8');

    assert.match(factorySource, /function disposeWorkletNode/);
    assert.match(factorySource, /postMessage\?\.\(\{ type: 'dispose' \}\)/);
    assert.match(factorySource, /RNNoise voice processing did not initialize in time/);
    assert.match(workletSource, /this\.port\.onmessage/);
    assert.match(workletSource, /dispose\(\)/);
    assert.match(workletSource, /denoiseState\.destroy/);
    assert.match(workletSource, /if \(this\.disposed\) return false/);
});

test('unsupported enhanced voice processing is persisted as standard', async () => {
    const controllerSource = await fs.readFile(mediaControllerPath, 'utf8');
    const dashboardSource = await fs.readFile(dashboardPath, 'utf8');

    assert.match(controllerSource, /onSettingsChange/);
    assert.match(controllerSource, /replaceUnsupportedVoiceProcessingMode\('standard', 'enhanced-unsupported'\)/);
    assert.match(controllerSource, /replaceUnsupportedVoiceProcessingMode\('standard', 'enhanced-failed'\)/);
    assert.match(dashboardSource, /onSettingsChange: \(settings\) =>/);
    assert.match(dashboardSource, /this\.persistMediaSettings\(\)/);
});
