import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    AdaptiveGainController,
    analyzeTimeDomainSamples,
    classifyAudioHealth,
    createAudioLevelMonitor,
    detectHumFrequency
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/audio-processing/audio-level-analyzer.js';

function samples(amplitude, length = 1000) {
    return Float32Array.from({ length }, (_, index) => (index % 2 ? amplitude : -amplitude));
}

test('audio level analysis identifies normal speech and clipping', () => {
    const normal = analyzeTimeDomainSamples(samples(0.125));
    assert.ok(normal.rmsDb > -19 && normal.rmsDb < -17);
    assert.equal(normal.clipping, false);

    const clipping = analyzeTimeDomainSamples(samples(0.99));
    assert.equal(clipping.clipping, true);
    assert.ok(clipping.peakDb > -1);
});

test('adaptive gain rises slowly for quiet speech, ignores silence, and drops quickly on clipping', () => {
    const controller = new AdaptiveGainController();
    const quietGain = controller.update({ speaking: true, rmsDb: -36, clipping: false });
    assert.ok(quietGain > 1 && quietGain < 1.1);

    assert.equal(controller.update({ speaking: false, rmsDb: -80, clipping: false }), quietGain);

    const clippedGain = controller.update({ speaking: true, rmsDb: -2, clipping: true });
    assert.ok(clippedGain < quietGain);
    assert.ok(clippedGain >= 0.7);
});

test('audio health prioritizes network, clipping, noise, and quiet speech', () => {
    assert.equal(classifyAudioHealth({ networkUnstable: true }), 'Network unstable');
    assert.equal(classifyAudioHealth({ clipping: true }), 'Clipping');
    assert.equal(classifyAudioHealth({ noiseFloorDb: -35 }), 'Noisy');
    assert.equal(classifyAudioHealth({ noiseFloorDb: -60, speaking: true, rmsDb: -35 }), 'Quiet');
    assert.equal(classifyAudioHealth({ noiseFloorDb: -60, speaking: true, rmsDb: -18 }), 'Good');
});

test('hum detection distinguishes sustained 50 and 60 hertz candidates from a flat spectrum', () => {
    const sampleRate = 48000;
    const frequencyData = new Float32Array(4096).fill(-100);
    const setFrequency = (frequency, magnitude) => {
        const bin = Math.round(frequency / ((sampleRate / 2) / frequencyData.length));
        frequencyData[bin] = magnitude;
    };

    setFrequency(50, -35);
    assert.equal(detectHumFrequency(frequencyData, sampleRate), '50');

    frequencyData.fill(-100);
    setFrequency(60, -30);
    assert.equal(detectHumFrequency(frequencyData, sampleRate), '60');

    frequencyData.fill(-100);
    assert.equal(detectHumFrequency(frequencyData, sampleRate), 'off');
});

test('audio monitor requires sustained hum before activating the automatic filter', () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let sample = null;
    const sampleRate = 48000;
    const frequencyData = new Float32Array(4096).fill(-100);
    const bin = Math.round(50 / ((sampleRate / 2) / frequencyData.length));
    frequencyData[bin] = -30;
    const analyser = {
        fftSize: 0,
        frequencyBinCount: 4096,
        smoothingTimeConstant: 0,
        getFloatTimeDomainData(data) { data.fill(0); },
        getFloatFrequencyData(data) { data.set(frequencyData); },
        disconnect() {}
    };

    globalThis.setInterval = (callback) => {
        sample = callback;
        return 1;
    };
    globalThis.clearInterval = () => {};
    try {
        const monitor = createAudioLevelMonitor({
            sampleRate,
            createAnalyser: () => analyser
        }, {
            connect() {}
        });
        for (let index = 0; index < 7; index += 1) sample();
        assert.equal(monitor.getMetrics().humFrequency, 'off');
        sample();
        assert.equal(monitor.getMetrics().humFrequency, '50');
        monitor.stop();
    } finally {
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
    }
});
