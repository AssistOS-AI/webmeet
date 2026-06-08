import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mediaSettingsMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/controllers/media-settings-methods.js';

function createHarness() {
    return { ...mediaSettingsMethods };
}

test('media device normalization removes browser virtual defaults and concrete duplicates', () => {
    const harness = createHarness();
    const devices = harness.normalizeEnumeratedMediaDevices([
        {
            kind: 'audioinput',
            deviceId: 'default',
            groupId: 'mic-group',
            label: 'Default - Studio Microphone'
        },
        {
            kind: 'audioinput',
            deviceId: 'communications',
            groupId: 'mic-group',
            label: 'Communications - Studio Microphone'
        },
        {
            kind: 'audioinput',
            deviceId: 'mic-1',
            groupId: 'mic-group',
            label: 'Studio Microphone'
        },
        {
            kind: 'audioinput',
            deviceId: 'mic-1-copy',
            groupId: 'mic-group',
            label: 'Studio Microphone'
        },
        {
            kind: 'audioinput',
            deviceId: 'mic-2',
            groupId: 'other-mic-group',
            label: 'USB Microphone'
        },
        {
            kind: 'audiooutput',
            deviceId: 'default',
            groupId: 'speaker-group',
            label: 'Default - Studio Speakers'
        },
        {
            kind: 'audiooutput',
            deviceId: 'speaker-1',
            groupId: 'speaker-group',
            label: 'Studio Speakers'
        },
        {
            kind: 'videoinput',
            deviceId: 'camera-1',
            groupId: 'camera-group',
            label: 'HD Camera'
        }
    ]);

    assert.deepEqual(
        devices.audioInput.map((device) => device.deviceId),
        ['mic-1', 'mic-2']
    );
    assert.deepEqual(
        devices.audioOutput.map((device) => device.deviceId),
        ['speaker-1']
    );
    assert.deepEqual(
        devices.videoInput.map((device) => device.deviceId),
        ['camera-1']
    );
});

test('media setting normalization treats saved default device ids as browser default selection', () => {
    const harness = createHarness();
    const settings = harness.normalizeMediaSettings({
        audioInputDeviceId: 'default',
        videoInputDeviceId: 'camera-1',
        audioOutputDeviceId: 'communications'
    });

    assert.equal(settings.audioInputDeviceId, '');
    assert.equal(settings.videoInputDeviceId, 'camera-1');
    assert.equal(settings.audioOutputDeviceId, '');
});
