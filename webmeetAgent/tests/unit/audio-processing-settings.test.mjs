import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeHumFilter,
    normalizeMicrophoneGain,
    normalizeVoiceProcessingMode,
    usesAudioGraph
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/audio-processing/settings.js';

test('voice processing mode normalization defaults to enhanced', () => {
    assert.equal(normalizeVoiceProcessingMode('enhanced'), 'enhanced');
    assert.equal(normalizeVoiceProcessingMode('standard'), 'standard');
    assert.equal(normalizeVoiceProcessingMode('off'), 'off');
    assert.equal(normalizeVoiceProcessingMode(''), 'enhanced');
    assert.equal(normalizeVoiceProcessingMode('unknown'), 'enhanced');
});

test('hum filter normalization accepts off, 50 and 60 hertz modes', () => {
    assert.equal(normalizeHumFilter('off'), 'off');
    assert.equal(normalizeHumFilter('50'), '50');
    assert.equal(normalizeHumFilter('50hz'), '50');
    assert.equal(normalizeHumFilter('60HZ'), '60');
    assert.equal(normalizeHumFilter('120'), 'off');
});

test('microphone gain normalization clamps to supported range', () => {
    assert.equal(normalizeMicrophoneGain(undefined), 1);
    assert.equal(normalizeMicrophoneGain(-1), 0);
    assert.equal(normalizeMicrophoneGain(0.75), 0.75);
    assert.equal(normalizeMicrophoneGain(3), 2);
});

test('audio graph is used only when processing steps are requested', () => {
    assert.equal(usesAudioGraph({ voiceProcessingMode: 'standard', humFilter: 'off', microphoneGain: 1 }), false);
    assert.equal(usesAudioGraph({ voiceProcessingMode: 'enhanced', humFilter: 'off', microphoneGain: 1 }), true);
    assert.equal(usesAudioGraph({ voiceProcessingMode: 'standard', humFilter: '50', microphoneGain: 1 }), true);
    assert.equal(usesAudioGraph({ voiceProcessingMode: 'off', humFilter: 'off', microphoneGain: 1.2 }), true);
});
