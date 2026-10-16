import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
    VoiceResponsiveAvatarController,
    VoiceExpressionClassifier,
    calculateSpectralFlux,
    classifyVoiceExpression,
    normalizeAvatarRuntimeState
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/audio-processing/voice-responsive-avatar.js';
import { getMeydaVendorUrl } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/audio-processing/meyda-loader.js';

const baseline = Object.freeze({
    rms: 1,
    energy: 1,
    zcr: 1,
    spectralCentroid: 1,
    spectralFlux: 1,
    spectralFlatness: 1,
    spectralRolloff: 1
});

const require = createRequire(import.meta.url);

test('maps calibrated acoustic features conservatively to supported AxiFace states', () => {
    assert.equal(classifyVoiceExpression({
        ...baseline,
        rms: 2.5,
        spectralFlux: 1.8,
        spectralCentroid: 1.4
    }, baseline).emotion, 'alert');
    assert.equal(classifyVoiceExpression({
        ...baseline,
        rms: 2,
        spectralFlux: 1.4,
        spectralCentroid: 1.1
    }, baseline).emotion, 'happy');
    assert.equal(classifyVoiceExpression({
        ...baseline,
        rms: 1.2,
        spectralFlux: 1.4,
        zcr: 1.4
    }, baseline, { speechTransitions: 3 }).emotion, 'confused');
    assert.equal(classifyVoiceExpression({
        ...baseline,
        rms: 0.5,
        spectralFlux: 0.5
    }, baseline).emotion, 'speaking');
});

test('keeps strong expression candidates behind calibration and stabilization', () => {
    const classifier = new VoiceExpressionClassifier({
        calibrationFrames: 2,
        requiredCandidateFrames: 3,
        minimumStateMs: 0
    });
    const calibration = { ...baseline };
    assert.equal(classifier.observe(calibration, { now: 1 }).emotion, 'speaking');
    assert.equal(classifier.observe(calibration, { now: 2 }).emotion, 'speaking');

    const alert = { ...baseline, rms: 2.5, spectralFlux: 1.8, spectralCentroid: 1.4 };
    assert.equal(classifier.observe(alert, { now: 3 }).emotion, 'speaking');
    assert.equal(classifier.observe(alert, { now: 4 }).emotion, 'speaking');
    let result = classifier.observe(alert, { now: 5 });
    for (let index = 0; index < 15 && result.emotion !== 'alert'; index += 1) {
        result = classifier.observe(alert, { now: 6 + index });
    }
    assert.equal(result.emotion, 'alert');
});

test('default classifier reacts to a sustained expression within two seconds', () => {
    const classifier = new VoiceExpressionClassifier();
    let now = 100;
    let result = null;
    for (let index = 0; index < 8; index += 1) {
        result = classifier.observe({ ...baseline }, { now });
        now += 100;
    }
    assert.equal(result.emotion, 'speaking');

    const alert = { ...baseline, rms: 2.5, spectralFlux: 1.8, spectralCentroid: 1.4 };
    while (now <= 2000 && result.emotion !== 'alert') {
        result = classifier.observe(alert, { now });
        now += 100;
    }

    assert.equal(result.emotion, 'alert');
    assert.ok(now <= 2100);
});

test('holds an accepted expressive state for at least 1.5 seconds before speaking fallback', () => {
    const classifier = new VoiceExpressionClassifier({
        calibrationFrames: 1,
        requiredCandidateFrames: 2,
        minimumStateMs: 0
    });
    classifier.baseline = { ...baseline };
    classifier.currentEmotion = 'happy';
    classifier.currentSince = 1000;
    const ordinarySpeech = { ...baseline };

    let result = null;
    for (let now = 1100; now < 2500; now += 100) {
        result = classifier.observe(ordinarySpeech, { now });
        assert.equal(result.emotion, 'happy');
    }

    for (let now = 2500; now <= 3200; now += 100) {
        result = classifier.observe(ordinarySpeech, { now });
    }
    assert.equal(result.emotion, 'speaking');
});

test('allows a stable expressive state to replace another without the speaking release hold', () => {
    const classifier = new VoiceExpressionClassifier({
        calibrationFrames: 1,
        requiredCandidateFrames: 2,
        minimumStateMs: 0
    });
    classifier.baseline = { ...baseline };
    classifier.currentEmotion = 'happy';
    classifier.currentSince = 1000;
    const alert = { ...baseline, rms: 2.5, spectralFlux: 1.8, spectralCentroid: 1.4 };

    assert.equal(classifier.observe(alert, { now: 1100 }).emotion, 'happy');
    assert.equal(classifier.observe(alert, { now: 1200 }).emotion, 'happy');
    assert.equal(classifier.observe(alert, { now: 1300 }).emotion, 'happy');
    const result = classifier.observe(alert, { now: 1400 });

    assert.equal(result.emotion, 'alert');
});

test('normalizes only public runtime state and drops classifier confidence', () => {
    assert.deepEqual(normalizeAvatarRuntimeState({
        emotion: 'happy',
        intensity: 2,
        speaking: true,
        confidence: 0.9,
        samples: [1, 2]
    }), {
        emotion: 'happy',
        intensity: 1,
        speaking: true
    });
    assert.equal(normalizeAvatarRuntimeState({ emotion: 'thinking' }), null);
});

test('calculates normalized spectral flux without the broken Meyda 5 spectralFlux extractor', () => {
    assert.equal(calculateSpectralFlux([1, 2, 3], [1, 2, 3]), 0);
    assert.equal(calculateSpectralFlux([2, 1, 5], [1, 2, 3]), 0.5);
    assert.equal(calculateSpectralFlux([1, 2], null), 0);
});

test('derives speaking and listening from LiveKit activity without starting server analysis', () => {
    const states = [];
    const microphoneTrack = { enabled: true, readyState: 'live' };
    const controller = new VoiceResponsiveAvatarController({
        getRoom: () => ({
            localParticipant: {
                trackPublications: new Map([['microphone', {
                    source: 'microphone',
                    isMuted: false,
                    track: { mediaStreamTrack: microphoneTrack }
                }]])
            }
        }),
        getExpressionMode: () => 'audio',
        onState: (state) => states.push(state),
        AudioContextRef: null,
        setTimeoutRef: (callback) => {
            callback();
            return 1;
        },
        clearTimeoutRef: () => {}
    });

    controller.setLiveKitState({
        microphoneAvailable: true,
        localSpeaking: true,
        remoteSpeaking: false
    });
    controller.setLiveKitState({ localSpeaking: false, remoteSpeaking: true });
    controller.setLiveKitState({ localSpeaking: false, remoteSpeaking: false });

    assert.deepEqual(states.map((state) => state?.emotion), ['speaking', 'listening', 'neutral']);
    assert.ok(states.every((state) => !('confidence' in state)));
});

test('manual mode clears the transient automatic state', async () => {
    const states = [];
    let mode = 'audio';
    const controller = new VoiceResponsiveAvatarController({
        getRoom: () => null,
        getExpressionMode: () => mode,
        onState: (state) => states.push(state),
        setTimeoutRef: () => 1,
        clearTimeoutRef: () => {}
    });

    controller.setLiveKitState({ microphoneAvailable: true, localSpeaking: true });
    mode = 'manual';
    await controller.sync();

    assert.equal(states[0]?.emotion, 'speaking');
    assert.equal(states.at(-1), null);
});

test('mute remains authoritative when a delayed active-speaker event still reports local speech', () => {
    const states = [];
    const controller = new VoiceResponsiveAvatarController({
        getRoom: () => null,
        getExpressionMode: () => 'audio',
        onState: (state) => states.push(state),
        setTimeoutRef: (callback) => {
            callback();
            return 1;
        },
        clearTimeoutRef: () => {}
    });

    controller.setLiveKitState({ microphoneAvailable: true, localSpeaking: true });
    controller.setLiveKitState({ microphoneAvailable: false, localSpeaking: false });
    controller.setLiveKitState({ localSpeaking: true });

    assert.deepEqual(states.map((state) => state?.emotion), ['speaking', 'neutral']);
    assert.equal(controller.currentState?.speaking, false);
});

test('brief LiveKit speaking gaps preserve the active voice expression until the release delay', () => {
    const states = [];
    const pendingTimers = [];
    const controller = new VoiceResponsiveAvatarController({
        getRoom: () => null,
        getExpressionMode: () => 'audio',
        onState: (state) => states.push(state),
        AudioContextRef: null,
        setTimeoutRef: (callback) => {
            pendingTimers.push(callback);
            return pendingTimers.length;
        },
        clearTimeoutRef: () => {}
    });

    controller.microphoneAvailable = true;
    controller.microphoneTrack = { enabled: true, readyState: 'live' };
    controller.startedTrack = controller.microphoneTrack;
    controller.timer = 1;
    controller.localSpeaking = true;
    controller.analysisState = {
        emotion: 'happy',
        intensity: 0.8,
        speaking: true
    };
    controller.reconcileState();
    controller.setLiveKitState({ localSpeaking: false, remoteSpeaking: false });

    assert.deepEqual(states.map((state) => state?.emotion), ['happy']);
    assert.equal(controller.analysisState?.emotion, 'happy');

    controller.setLiveKitState({ localSpeaking: true, remoteSpeaking: false });
    assert.deepEqual(states.map((state) => state?.emotion), ['happy']);
    assert.equal(controller.currentState?.speaking, true);
});

test('local audio activity keeps continuous speech active when LiveKit briefly drops active-speaker state', () => {
    const states = [];
    const controller = new VoiceResponsiveAvatarController({
        getExpressionMode: () => 'audio',
        onState: (state) => states.push(state),
        clearTimeoutRef: () => {}
    });
    controller.microphoneAvailable = true;
    controller.localSpeaking = true;
    controller.updateLocalAudioActivity(0.03);
    controller.analysisState = {
        emotion: 'happy',
        intensity: 0.8,
        speaking: true
    };
    controller.reconcileState();

    controller.localSpeaking = false;
    for (let index = 0; index < 20; index += 1) {
        controller.updateLocalAudioActivity(0.03);
        controller.reconcileState();
    }

    assert.equal(controller.localAudioSpeaking, true);
    assert.deepEqual(states.map((state) => state?.emotion), ['happy']);
});

test('audio sampling continues while the microphone is live even when LiveKit omits the local active speaker', () => {
    const states = [];
    const controller = new VoiceResponsiveAvatarController({
        getExpressionMode: () => 'audio',
        onState: (state) => states.push(state),
        clearTimeoutRef: () => {},
        classifier: {
            observe() {
                return { emotion: 'happy', intensity: 0.8, speaking: true };
            },
            reset() {}
        }
    });
    controller.microphoneAvailable = true;
    controller.localSpeaking = false;
    controller.samples = new Float32Array(8);
    controller.analyser = {
        getFloatTimeDomainData(samples) {
            samples.fill(0.03);
        }
    };
    const meyda = {
        extract() {
            return {
                rms: 0.03,
                energy: 1,
                zcr: 1,
                spectralCentroid: 1,
                spectralFlatness: 1,
                spectralRolloff: 1,
                amplitudeSpectrum: new Float32Array([1, 1, 1, 1])
            };
        }
    };

    controller.sample(meyda);
    controller.sample(meyda);

    assert.equal(controller.localAudioSpeaking, true);
    assert.deepEqual(states.map((state) => state?.emotion), ['happy']);
});

test('local audio activity releases speech after sustained silence but mute wins immediately', () => {
    const controller = new VoiceResponsiveAvatarController({
        getExpressionMode: () => 'audio',
        clearTimeoutRef: () => {}
    });
    controller.microphoneAvailable = true;
    controller.localSpeaking = true;
    controller.updateLocalAudioActivity(0.03);
    controller.localSpeaking = false;

    for (let index = 0; index < 7; index += 1) {
        controller.updateLocalAudioActivity(0);
    }
    assert.equal(controller.localAudioSpeaking, true);

    controller.updateLocalAudioActivity(0);
    assert.equal(controller.localAudioSpeaking, false);

    controller.localSpeaking = true;
    controller.updateLocalAudioActivity(0.03);
    controller.setLiveKitState({ microphoneAvailable: false, localSpeaking: false });
    assert.equal(controller.localAudioSpeaking, false);
    assert.equal(controller.currentState?.emotion, 'neutral');
});

test('LiveKit activity updates do not overwrite a stable local analysis expression', () => {
    const states = [];
    const controller = new VoiceResponsiveAvatarController({
        getRoom: () => null,
        getExpressionMode: () => 'audio',
        onState: (state) => states.push(state),
        AudioContextRef: null,
        clearTimeoutRef: () => {}
    });

    controller.microphoneAvailable = true;
    controller.microphoneTrack = { enabled: true, readyState: 'live' };
    controller.localSpeaking = true;
    controller.analysisState = {
        emotion: 'happy',
        intensity: 0.8,
        speaking: true,
        confidence: 0.75
    };
    controller.reconcileState();
    controller.setLiveKitState({ localSpeaking: true, remoteSpeaking: false });

    assert.deepEqual(states.map((state) => state?.emotion), ['happy']);
    assert.equal(controller.currentState?.emotion, 'happy');
});

test('publishes meaningful intensity changes at a bounded update rate', () => {
    const states = [];
    let now = 1000;
    const controller = new VoiceResponsiveAvatarController({
        now: () => now,
        onState: (state) => states.push(state)
    });

    controller.emitState({ emotion: 'speaking', intensity: 0.4, speaking: true });
    now += 50;
    controller.emitState({ emotion: 'speaking', intensity: 0.7, speaking: true });
    now += 150;
    controller.emitState({ emotion: 'speaking', intensity: 0.7, speaking: true });
    now += 150;
    controller.emitState({ emotion: 'speaking', intensity: 0.74, speaking: true });

    assert.deepEqual(states.map((state) => state.intensity), [0.4, 0.7]);
});

test('retries analyser initialization after a transient setup failure', async () => {
    let loadAttempts = 0;
    const errors = [];
    class FakeAudioContext {
        constructor() {
            this.state = 'running';
            this.sampleRate = 48_000;
        }

        createMediaStreamSource() {
            return { connect() {}, disconnect() {} };
        }

        createAnalyser() {
            return { fftSize: 0, smoothingTimeConstant: 0 };
        }

        async close() {}
    }
    class FakeMediaStream {
        constructor(tracks) {
            this.tracks = tracks;
        }
    }
    const controller = new VoiceResponsiveAvatarController({
        AudioContextRef: FakeAudioContext,
        MediaStreamRef: FakeMediaStream,
        loadMeyda: async () => {
            loadAttempts += 1;
            if (loadAttempts === 1) throw new Error('temporary load failure');
            return { bufferSize: 0, sampleRate: 0 };
        },
        setIntervalRef: () => 1,
        clearIntervalRef: () => {},
        clearTimeoutRef: () => {},
        onError: (error) => errors.push(error)
    });
    const track = { enabled: true, readyState: 'live' };

    await controller.start(track);
    await controller.start(track);

    assert.equal(loadAttempts, 2);
    assert.equal(errors.length, 1);
    assert.equal(controller.startedTrack, track);
    assert.equal(controller.timer, 1);
});

test('disconnect resets the LiveKit authority and cannot leave the avatar speaking', () => {
    const states = [];
    const controller = new VoiceResponsiveAvatarController({
        getExpressionMode: () => 'audio',
        onState: (state) => states.push(state),
        clearIntervalRef: () => {},
        clearTimeoutRef: () => {}
    });

    controller.microphoneAvailable = true;
    controller.localSpeaking = true;
    controller.emitState({ emotion: 'speaking', intensity: 0.5, speaking: true });
    controller.resetLiveKitState({ clearRuntimeState: false });

    assert.deepEqual(states.map((state) => state?.emotion), ['speaking', 'neutral']);
    assert.equal(controller.microphoneAvailable, false);
    assert.equal(controller.localSpeaking, false);
});

test('default browser timer functions preserve their global receiver during cleanup', () => {
    const originalClearInterval = globalThis.clearInterval;
    const originalClearTimeout = globalThis.clearTimeout;
    const cleared = [];
    try {
        globalThis.clearInterval = function clearIntervalWithReceiver(timer) {
            assert.equal(this, globalThis);
            cleared.push(['interval', timer]);
        };
        globalThis.clearTimeout = function clearTimeoutWithReceiver(timer) {
            assert.equal(this, globalThis);
            cleared.push(['timeout', timer]);
        };
        const controller = new VoiceResponsiveAvatarController();
        controller.timer = 11;
        controller.neutralTimer = 12;

        controller.stop();

        assert.deepEqual(cleared, [
            ['interval', 11],
            ['timeout', 12]
        ]);
    } finally {
        globalThis.clearInterval = originalClearInterval;
        globalThis.clearTimeout = originalClearTimeout;
    }
});

test('loads Meyda only from the pinned local vendor bundle', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const vendorRoot = path.join(repoRoot, 'IDE-plugins/webmeet-tool-button/vendor/meyda');
    const [packageJson, notices, license, bundle] = await Promise.all([
        fs.readFile(path.join(vendorRoot, 'package.json'), 'utf8'),
        fs.readFile(path.join(vendorRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
        fs.readFile(path.join(vendorRoot, 'LICENSE'), 'utf8'),
        fs.readFile(path.join(vendorRoot, 'dist/meyda.min.js'), 'utf8')
    ]);
    assert.equal(JSON.parse(packageJson).version, '5.6.3');
    assert.match(notices, /sha512-fAdwfzIi1WDoL0idUQvCD7dZ7EN74FYH83G\+jZQO3Nr9yOEBtzFvcMg2KLdLlu6psSP8XFlO0kYynG5o\/E681Q==/);
    assert.match(license, /MIT License/);
    assert.ok(bundle.length > 10_000);
    assert.match(getMeydaVendorUrl(), /\/vendor\/meyda\/dist\/meyda\.min\.js$/);
    assert.doesNotMatch(getMeydaVendorUrl(), /^https?:\/\//);

    const meyda = require(path.join(vendorRoot, 'dist/meyda.min.js'));
    meyda.bufferSize = 2048;
    const extracted = meyda.extract([
        'rms',
        'zcr',
        'spectralCentroid',
        'spectralFlatness',
        'spectralRolloff',
        'amplitudeSpectrum'
    ], new Float32Array(2048));
    assert.equal(extracted.amplitudeSpectrum.length, 1024);
});
