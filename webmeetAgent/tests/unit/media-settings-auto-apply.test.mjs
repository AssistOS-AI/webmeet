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

test('audio reset restores its defaults without changing video, language or avatar', async () => {
    const { presenter, calls } = createSettings();
    globalThis.window = globalThis;
    presenter.state.webMeetAvatarOverride = { style: 'robot-soft' };
    presenter.state.mediaSettingsDraft = {
        audioInputDeviceId: 'usb', outputVolume: 0.1, cameraQuality: 'h1080',
        backgroundMode: 'image', backgroundImageDataUrl: 'data:image/png;base64,test',
        speechRecognitionLanguage: 'ro-RO'
    };
    presenter.scheduleMediaSettingsApply();
    presenter.state.activeSettingsTab = 'audio';
    const videoSettings = { videoInputDeviceId: 'camera', cameraQuality: 'h1080', screenShareQuality: 'h720fps15', backgroundMode: 'image', backgroundBlurRadius: 20, backgroundImageDataUrl: 'data:image/png;base64,test', backgroundImageName: 'photo' };
    Object.assign(presenter.state.mediaSettingsDraft, videoSettings);
    await presenter.resetMediaSettings();
    assert.deepEqual(presenter.state.mediaSettings, {
        ...presenter.getDefaultMediaSettings(), ...videoSettings, speechRecognitionLanguage: 'ro-RO'
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
    presenter.state.activeSettingsTab = 'video';
    const resetting = presenter.resetMediaSettings();
    release();
    await Promise.all([applying, resetting]);
    assert.equal(calls.persisted.length, 2);
    const defaults = presenter.getDefaultMediaSettings();
    assert.equal(calls.persisted.at(-1).outputVolume, 0.2);
    assert.equal(calls.persisted.at(-1).speechRecognitionLanguage, 'ro-RO');
    for (const key of ['videoInputDeviceId', 'cameraQuality', 'screenShareQuality', 'backgroundMode', 'backgroundBlurRadius', 'backgroundImageDataUrl', 'backgroundImageName']) {
        assert.equal(calls.persisted.at(-1)[key], defaults[key]);
    }
});

test('rescan updates only the selected device category and never opens media capture', async () => {
    const { presenter, calls } = createSettings();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
        async enumerateDevices() { return [
            { kind: 'audioinput', deviceId: 'new-mic', label: 'USB Microphone' },
            { kind: 'audiooutput', deviceId: 'new-speaker', label: 'USB Speaker' },
            { kind: 'videoinput', deviceId: 'new-camera', label: 'USB Camera' }
        ]; },
        async getUserMedia() { assert.fail('Rescan must not start microphone or camera capture'); }
    } } });
    try {
        presenter.mediaDevices = { audioInput: [], audioOutput: [], videoInput: [{ deviceId: 'original-camera' }] };
        presenter.state.activeSettingsTab = 'audio';
        await presenter.rescanSettingsDevices();
        assert.equal(presenter.mediaDevices.audioInput[0].deviceId, 'new-mic');
        assert.equal(presenter.mediaDevices.audioOutput[0].deviceId, 'new-speaker');
        assert.equal(presenter.mediaDevices.videoInput[0].deviceId, 'original-camera');
        assert.match(calls.errors.at(-1), /^Audio devices refreshed:/);
        const audioInput = presenter.mediaDevices.audioInput;
        presenter.state.activeSettingsTab = 'video';
        await presenter.rescanSettingsDevices();
        assert.equal(presenter.mediaDevices.videoInput[0].deviceId, 'new-camera');
        assert.equal(presenter.mediaDevices.audioInput, audioInput);
        assert.match(calls.errors.at(-1), /^Video devices refreshed:/);
        assert.deepEqual(calls.persisted, []);
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
        else delete globalThis.navigator;
    }
});

test('device actions do not modify preferences from Voice commands or Avatar', async () => {
    const { presenter, calls } = createSettings();
    const original = presenter.state.mediaSettings;
    presenter.refreshMediaDevices = () => assert.fail('No device rescan outside device tabs');
    for (const tab of ['voice', 'avatar']) {
        presenter.state.activeSettingsTab = tab;
        await presenter.resetMediaSettings();
        await presenter.rescanSettingsDevices();
    }
    assert.equal(presenter.state.mediaSettings, original);
    assert.deepEqual(calls.persisted, []);
});
