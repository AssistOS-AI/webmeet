import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const audioProcessingPath = path.join(
    repoRoot,
    'IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/services/audio-processing/microphone-track-factory.js'
);
const rnnoiseWorkletPath = path.join(
    repoRoot,
    'IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/services/audio-processing/rnnoise-worklet.js'
);
const mediaControllerPath = path.join(
    repoRoot,
    'IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/controllers/webmeet-media-controller.js'
);
const dashboardPath = path.join(
    repoRoot,
    'IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/webmeet-dashbaoard.js'
);
const dashboardHtmlPath = path.join(
    repoRoot,
    'IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/webmeet-dashbaoard.html'
);

test('RNNoise initialization timeout disposes the worklet node', async () => {
    const factorySource = await fs.readFile(audioProcessingPath, 'utf8');
    const workletSource = await fs.readFile(rnnoiseWorkletPath, 'utf8');

    assert.match(factorySource, /function disposeWorkletNode/);
    assert.match(factorySource, /postMessage\?\.\(\{ type: 'dispose' \}\)/);
    assert.match(factorySource, /RNNoise voice processing did not initialize in time/);
    assert.match(workletSource, /this\.port\.onmessage/);
    assert.match(workletSource, /rnnoise-sync\.js/);
    assert.match(workletSource, /createRNNWasmModuleSync/);
    assert.match(workletSource, /dispose\(\)/);
    assert.match(workletSource, /_rnnoise_destroy/);
    assert.match(workletSource, /_free\(this\.inputPtr\)/);
    assert.match(workletSource, /_free\(this\.outputPtr\)/);
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

test('automatic voice processing falls back without overwriting the automatic preference', async () => {
    const factorySource = await fs.readFile(audioProcessingPath, 'utf8');
    const controllerSource = await fs.readFile(mediaControllerPath, 'utf8');

    assert.match(factorySource, /const automatic = mode === 'auto'/);
    assert.match(factorySource, /const humFilter = automatic \? 'off'/);
    assert.match(factorySource, /const configuredGain = automatic \? 1/);
    assert.match(factorySource, /autoGainControl: automatic \? false/);
    assert.match(factorySource, /adaptiveGainController = new AdaptiveGainController/);
    assert.ok(factorySource.indexOf('currentNode = connectIfPresent(currentNode, gainNode)') < factorySource.indexOf('createDynamicsCompressor'));
    assert.match(controllerSource, /if \(mode === 'auto'\)/);
    assert.match(controllerSource, /await this\.enableMicrophoneWithMode\(room, 'standard'/);
    assert.ok(
        controllerSource.indexOf("await this.enableMicrophoneWithMode(room, 'standard'") < controllerSource.indexOf('this.scheduleDeferredMicrophoneProcessing(room)'),
        'auto mode should publish standard microphone audio before deferred processing'
    );
    assert.match(controllerSource, /scheduleDeferredMicrophoneProcessing\(room\)/);
    assert.match(controllerSource, /microphoneGain: 1/);
    assert.match(controllerSource, /humFilter: 'off'/);
    assert.doesNotMatch(controllerSource, /replaceUnsupportedVoiceProcessingMode\('standard', 'auto/);
});

test('manual audio controls switch automatic voice processing to custom instead of disabling controls', async () => {
    const factorySource = await fs.readFile(audioProcessingPath, 'utf8');
    const dashboardTemplate = await fs.readFile(dashboardHtmlPath, 'utf8');
    const mediaSettingsSource = await fs.readFile(path.join(
        repoRoot,
        'IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/controllers/media-settings-methods.js'
    ), 'utf8');

    assert.match(dashboardTemplate, /<option value="custom">Custom manual controls<\/option>/);
    assert.match(mediaSettingsSource, /switchAutomaticVoiceProcessingToCustom/);
    assert.match(mediaSettingsSource, /this\.voiceProcessingModeSelect\.value = 'custom'/);
    assert.doesNotMatch(mediaSettingsSource, /control\.disabled = automaticVoiceProcessing/);
    assert.match(factorySource, /\['standard', 'custom'\]\.includes\(mode\)/);
});

test('dashboard defaults microphone and output volume to eighty percent', async () => {
    const settingsSource = await fs.readFile(path.join(
        repoRoot,
        'IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/services/audio-processing/settings.js'
    ), 'utf8');
    const controllerSource = await fs.readFile(mediaControllerPath, 'utf8');
    const dashboardSource = await fs.readFile(dashboardPath, 'utf8');

    assert.match(settingsSource, /DEFAULT_MICROPHONE_GAIN = 0\.8/);
    assert.match(settingsSource, /DEFAULT_OUTPUT_VOLUME = 0\.8/);
    assert.match(controllerSource, /microphoneGain: DEFAULT_MICROPHONE_GAIN/);
    assert.match(controllerSource, /outputVolume: DEFAULT_OUTPUT_VOLUME/);
    assert.match(dashboardSource, /microphoneGain: DEFAULT_MICROPHONE_GAIN/);
    assert.match(dashboardSource, /outputVolume: DEFAULT_OUTPUT_VOLUME/);
});

test('dashboard audio defaults favor browser anti-feedback settings', async () => {
    const controllerSource = await fs.readFile(mediaControllerPath, 'utf8');
    const dashboardSource = await fs.readFile(dashboardPath, 'utf8');

    assert.match(controllerSource, /voiceProcessingMode: DEFAULT_VOICE_PROCESSING_MODE/);
    assert.match(controllerSource, /outputVolume: DEFAULT_OUTPUT_VOLUME/);
    assert.match(dashboardSource, /voiceProcessingMode: DEFAULT_VOICE_PROCESSING_MODE/);
    assert.match(dashboardSource, /outputVolume: DEFAULT_OUTPUT_VOLUME/);
});
