import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaSettingsMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/media-settings-methods.js';

function createSettings() {
    const calls = { persisted: [], applied: [], errors: [], stopped: 0, started: 0 };
    const presenter = {
        ...mediaSettingsMethods,
        state: { mediaSettings: { outputVolume: 1 }, mediaSettingsDraft: null, mediaSettingsPanelVisible: true },
        normalizeMediaSettings: (settings) => ({ ...settings }),
        getMediaSettingsValidationError: () => '',
        renderMediaSettingsPanel() {},
        mediaController: { setSettings: (settings) => calls.applied.push({ ...settings }) },
        persistMediaSettings() { calls.persisted.push({ ...this.state.mediaSettings }); },
        participantLayoutController: { getParticipantIds: () => [] },
        applyOutputVolumePreviewToAllAudioElements() {},
        async applyAudioOutputDeviceToAllTracks() {},
        async reapplyActiveInputDevices() { return []; },
        async collectMediaDeviceWarnings(settings, options) {
            assert.equal(options.testMicrophone, false);
            return [];
        },
        setError: (message) => calls.errors.push(message),
        async stopMicrophoneTest() { calls.stopped++; },
        async startMicrophoneTest() { calls.started++; },
        closeMediaSettingsDialog() {},
        applyMobilePanelState() {}
    };
    return { presenter, calls };
}

test('media changes persist without closing settings or restarting an unrelated microphone test', async () => {
    const { presenter, calls } = createSettings();
    globalThis.window = globalThis;
    presenter.state.microphoneTest = { active: true };
    presenter.state.mediaSettingsDraft = { outputVolume: 0.5 };
    await presenter.applyMediaSettings();
    assert.deepEqual(calls.persisted, [{ outputVolume: 0.5 }]);
    assert.equal(presenter.state.mediaSettingsPanelVisible, true);
    assert.equal(calls.stopped, 0);
    await presenter.applyMediaSettings();
    assert.equal(calls.persisted.length, 1);
});

test('changes during device reconfiguration are serialized and the last selection is retained', async () => {
    const { presenter, calls } = createSettings();
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    let count = 0;
    presenter.reapplyActiveInputDevices = async () => {
        if (++count === 1) await waiting;
        return [];
    };
    presenter.state.mediaSettingsDraft = { outputVolume: 0.5 };
    const first = presenter.applyMediaSettings();
    presenter.state.mediaSettingsDraft = { outputVolume: 0.2 };
    const second = presenter.applyMediaSettings();
    release();
    await Promise.all([first, second]);
    assert.deepEqual(calls.persisted.map((settings) => settings.outputVolume), [0.5, 0.2]);
    assert.equal(presenter.state.mediaSettings.outputVolume, 0.2);
    assert.equal(presenter.state.mediaSettingsApplying, false);
});

test('closing settings flushes a pending slider change before clearing the draft', async () => {
    const { presenter, calls } = createSettings();
    presenter.state.mediaSettingsDraft = { outputVolume: 0.3 };
    presenter.scheduleMediaSettingsApply();
    await presenter.closeMediaSettings();
    assert.deepEqual(calls.persisted, [{ outputVolume: 0.3 }]);
    assert.equal(presenter.state.mediaSettingsDraft, null);
    assert.equal(presenter.state.mediaSettingsPanelVisible, false);
});

test('invalid settings are not persisted and runtime failures remain visible', async () => {
    const { presenter, calls } = createSettings();
    presenter.state.mediaSettingsDraft = { outputVolume: 0.4 };
    presenter.getMediaSettingsValidationError = () => 'Choose a background image.';
    await presenter.applyMediaSettings();
    assert.deepEqual(calls.persisted, []);
    presenter.getMediaSettingsValidationError = () => '';
    presenter.reapplyActiveInputDevices = async () => { throw new Error('Microphone disconnected.'); };
    await presenter.applyMediaSettings();
    assert.deepEqual(calls.persisted, []);
    assert.equal(presenter.state.mediaSettings.outputVolume, 1);
    assert.deepEqual(calls.errors, ['Choose a background image.', 'Microphone disconnected.']);
});

test('input events automatically coalesce multiple changes into the latest preferences', async () => {
    const { presenter, calls } = createSettings();
    const input = new EventTarget();
    presenter.videoInputSelect = input;
    presenter.collectMediaSettingsFromInputs = () => ({ outputVolume: 1, videoInputDeviceId: input.value });
    presenter.registerMediaSettingsInputHandlers();
    input.value = 'camera-one';
    input.dispatchEvent(new Event('change'));
    input.value = 'camera-two';
    input.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(calls.persisted.length, 1);
    assert.equal(calls.persisted[0].videoInputDeviceId, 'camera-two');
});

test('microphone preferences restart an active test while preserving the open modal', async () => {
    const { presenter, calls } = createSettings();
    presenter.state.microphoneTest = { active: true };
    presenter.state.mediaSettingsDraft = { outputVolume: 1, audioInputDeviceId: 'usb-microphone' };
    await presenter.applyMediaSettings();
    assert.equal(calls.stopped, 1);
    assert.equal(calls.started, 1);
    assert.equal(presenter.state.mediaSettingsPanelVisible, true);
});

test('reset restores first-load defaults and persists them without changing language or avatar', async () => {
    const { presenter, calls } = createSettings();
    globalThis.window = globalThis;
    presenter.state.webMeetAvatarOverride = { style: 'robot-soft' };
    presenter.state.mediaSettingsDraft = {
        audioInputDeviceId: 'usb', outputVolume: 0.1, cameraQuality: 'h1080',
        backgroundMode: 'image', backgroundImageDataUrl: 'data:image/png;base64,test',
        speechRecognitionLanguage: 'ro-RO'
    };
    presenter.scheduleMediaSettingsApply();
    await presenter.resetMediaSettings();
    assert.deepEqual(presenter.state.mediaSettings, {
        ...presenter.getDefaultMediaSettings(), speechRecognitionLanguage: 'ro-RO'
    });
    assert.deepEqual(calls.persisted, [presenter.state.mediaSettings]);
    assert.deepEqual(presenter.state.webMeetAvatarOverride, { style: 'robot-soft' });
    assert.equal(presenter.state.mediaSettingsPanelVisible, true);
});

test('reset supersedes preferences queued while a media update is in progress', async () => {
    const { presenter, calls } = createSettings();
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    let count = 0;
    presenter.reapplyActiveInputDevices = async () => {
        if (++count === 1) await waiting;
        return [];
    };
    presenter.state.mediaSettingsDraft = { outputVolume: 0.2, speechRecognitionLanguage: 'ro-RO' };
    const applying = presenter.applyMediaSettings();
    const resetting = presenter.resetMediaSettings();
    release();
    await Promise.all([applying, resetting]);
    assert.equal(calls.persisted.length, 2);
    assert.deepEqual(calls.persisted.at(-1), {
        ...presenter.getDefaultMediaSettings(), speechRecognitionLanguage: 'ro-RO'
    });
});
