import { loadVendoredMeyda } from './meyda-loader.js';

const FEATURE_NAMES = Object.freeze([
    'rms',
    'energy',
    'zcr',
    'spectralCentroid',
    'spectralFlux',
    'spectralFlatness',
    'spectralRolloff'
]);

const MEYDA_FEATURE_NAMES = Object.freeze([
    'rms',
    'energy',
    'zcr',
    'spectralCentroid',
    'spectralFlatness',
    'spectralRolloff',
    'amplitudeSpectrum'
]);

const SPEECH_RELEASE_DELAY_MS = 1500;
const VOICE_EXPRESSIONS = new Set(['happy', 'alert', 'confused']);
const LOCAL_VOICE_RMS_FLOOR = 0.008;
const LOCAL_VOICE_START_FRAMES = 2;
const LOCAL_VOICE_RELEASE_FRAMES = 8;
const INTENSITY_UPDATE_THRESHOLD = 0.08;
const INTENSITY_UPDATE_INTERVAL_MS = 150;
const DEFAULT_CALIBRATION_FRAMES = 8;
const DEFAULT_CANDIDATE_FRAMES = 2;
const DEFAULT_MINIMUM_STATE_MS = 450;
const FEATURE_WINDOW_FRAMES = 6;
const EXPRESSIVE_STATE_MINIMUM_MS = 1500;
const EXPRESSIVE_RELEASE_FRAMES = 8;
const EXPRESSIVE_TRANSITION_FRAMES = 4;

function clamp(value, min = 0, max = 1) {
    return Math.min(max, Math.max(min, Number(value) || 0));
}

function positive(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function ratio(value, baseline, fallback = 1) {
    const base = positive(baseline);
    if (base <= 0.000001) return fallback;
    return positive(value) / base;
}

function average(entries, key) {
    if (!entries.length) return 0;
    return entries.reduce((sum, entry) => sum + positive(entry?.[key]), 0) / entries.length;
}

export function normalizeAvatarRuntimeState(value = null) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const emotion = String(value.emotion || '').trim();
    if (!['neutral', 'listening', 'speaking', 'happy', 'confused', 'alert', 'sleepy'].includes(emotion)) {
        return null;
    }
    return {
        emotion,
        intensity: clamp(value.intensity, 0, 1),
        speaking: Boolean(value.speaking)
    };
}

export function aggregateVoiceFeatures(entries = []) {
    const values = Array.isArray(entries) ? entries.filter(Boolean) : [];
    return Object.fromEntries(FEATURE_NAMES.map((key) => [key, average(values, key)]));
}

export function calculateSpectralFlux(currentSpectrum = null, previousSpectrum = null) {
    if (!currentSpectrum?.length || !previousSpectrum?.length) return 0;
    const length = Math.min(currentSpectrum.length, previousSpectrum.length);
    let positiveDelta = 0;
    let previousEnergy = 0;
    for (let index = 0; index < length; index += 1) {
        const current = positive(currentSpectrum[index]);
        const previous = positive(previousSpectrum[index]);
        positiveDelta += Math.max(0, current - previous);
        previousEnergy += previous;
    }
    return positiveDelta / Math.max(previousEnergy, 0.000001);
}

export function classifyVoiceExpression(features = {}, baseline = {}, context = {}) {
    const rmsRatio = ratio(features.rms, baseline.rms);
    const fluxRatio = ratio(features.spectralFlux, baseline.spectralFlux);
    const centroidRatio = ratio(features.spectralCentroid, baseline.spectralCentroid);
    const flatnessRatio = ratio(features.spectralFlatness, baseline.spectralFlatness);
    const zcrRatio = ratio(features.zcr, baseline.zcr);
    const activation = clamp(((rmsRatio - 0.65) / 1.55) * 0.55
        + ((fluxRatio - 0.7) / 1.5) * 0.30
        + ((centroidRatio - 0.75) / 1.2) * 0.15);
    const fragmentCount = Math.max(0, Number(context.speechTransitions || 0));

    if (activation > 0.78 && centroidRatio > 1.18 && fluxRatio > 1.25) {
        return { emotion: 'alert', intensity: activation, confidence: 0.82 };
    }
    if (
        activation > 0.58
        && fluxRatio > 1.12
        && centroidRatio < 1.22
        && flatnessRatio < 1.25
    ) {
        return { emotion: 'happy', intensity: activation, confidence: 0.72 };
    }
    if (
        activation >= 0.25
        && activation <= 0.68
        && zcrRatio > 1.22
        && fluxRatio > 1.22
        && fragmentCount >= 3
    ) {
        return { emotion: 'confused', intensity: Math.max(0.4, activation), confidence: 0.68 };
    }
    return { emotion: 'speaking', intensity: Math.max(0.35, activation), confidence: 0.6 };
}

export class VoiceExpressionClassifier {
    constructor(options = {}) {
        this.calibrationFrames = Number.isFinite(options.calibrationFrames)
            ? options.calibrationFrames
            : DEFAULT_CALIBRATION_FRAMES;
        this.requiredCandidateFrames = Number.isFinite(options.requiredCandidateFrames)
            ? options.requiredCandidateFrames
            : DEFAULT_CANDIDATE_FRAMES;
        this.minimumStateMs = Number.isFinite(options.minimumStateMs)
            ? options.minimumStateMs
            : DEFAULT_MINIMUM_STATE_MS;
        this.frames = [];
        this.baseline = null;
        this.calibration = [];
        this.candidate = '';
        this.candidateFrames = 0;
        this.currentEmotion = 'speaking';
        this.currentSince = 0;
    }

    reset() {
        this.frames = [];
        this.baseline = null;
        this.calibration = [];
        this.candidate = '';
        this.candidateFrames = 0;
        this.currentEmotion = 'speaking';
        this.currentSince = 0;
    }

    observe(features = {}, context = {}) {
        const now = Number(context.now || Date.now());
        this.frames.push(features);
        if (this.frames.length > FEATURE_WINDOW_FRAMES) this.frames.shift();
        const aggregate = aggregateVoiceFeatures(this.frames);

        if (!this.baseline) {
            this.calibration.push(features);
            if (this.calibration.length < this.calibrationFrames) {
                return { emotion: 'speaking', intensity: 0.5, speaking: true, confidence: 0 };
            }
            this.baseline = aggregateVoiceFeatures(this.calibration);
        }

        const result = classifyVoiceExpression(aggregate, this.baseline, context);
        const nextEmotion = String(result.emotion || 'speaking');
        if (nextEmotion === this.candidate) {
            this.candidateFrames += 1;
        } else {
            this.candidate = nextEmotion;
            this.candidateFrames = 1;
        }

        const currentIsExpressive = VOICE_EXPRESSIONS.has(this.currentEmotion);
        const releasingToSpeaking = currentIsExpressive && nextEmotion === 'speaking';
        const switchingExpressiveState = currentIsExpressive
            && VOICE_EXPRESSIONS.has(nextEmotion)
            && nextEmotion !== this.currentEmotion;
        const requiredFrames = releasingToSpeaking
            ? Math.max(this.requiredCandidateFrames, EXPRESSIVE_RELEASE_FRAMES)
            : switchingExpressiveState
                ? Math.max(this.requiredCandidateFrames, EXPRESSIVE_TRANSITION_FRAMES)
                : this.requiredCandidateFrames;
        const minimumStateMs = releasingToSpeaking
            ? Math.max(this.minimumStateMs, EXPRESSIVE_STATE_MINIMUM_MS)
            : this.minimumStateMs;
        const maySwitch = this.candidateFrames >= requiredFrames
            && (!this.currentSince || now - this.currentSince >= minimumStateMs);
        if (maySwitch && nextEmotion !== this.currentEmotion) {
            this.currentEmotion = nextEmotion;
            this.currentSince = now;
        }

        for (const key of FEATURE_NAMES) {
            const value = positive(aggregate[key]);
            this.baseline[key] = (positive(this.baseline[key]) * 0.995) + (value * 0.005);
        }

        return {
            emotion: this.currentEmotion,
            intensity: result.intensity,
            speaking: true,
            confidence: this.currentEmotion === nextEmotion ? result.confidence : 0.5
        };
    }
}

function getLocalMicrophoneTrack(room) {
    const localParticipant = room?.localParticipant || null;
    if (!localParticipant) return null;
    const publications = Array.from(localParticipant.trackPublications?.values?.() || []);
    const publication = publications.find((entry) => {
        const source = String(entry?.source || '').toLowerCase();
        const kind = String(entry?.kind || entry?.track?.kind || entry?.track?.mediaStreamTrack?.kind || '').toLowerCase();
        return source ? source.includes('microphone') : kind === 'audio';
    });
    const track = publication?.track?.mediaStreamTrack || publication?.track?.mediaStream?.getAudioTracks?.()[0] || null;
    if (
        publication?.isMuted
        || publication?.track?.isMuted
        || track?.enabled === false
        || String(track?.readyState || '').toLowerCase() === 'ended'
    ) {
        return null;
    }
    return track;
}

export class VoiceResponsiveAvatarController {
    constructor(options = {}) {
        this.getRoom = options.getRoom || (() => null);
        this.getExpressionMode = options.getExpressionMode || (() => 'audio');
        this.onState = options.onState || (() => {});
        this.onError = options.onError || (() => {});
        this.loadMeyda = options.loadMeyda || loadVendoredMeyda;
        this.AudioContextRef = options.AudioContextRef || globalThis.AudioContext || globalThis.webkitAudioContext;
        this.MediaStreamRef = options.MediaStreamRef || globalThis.MediaStream;
        this.setIntervalRef = options.setIntervalRef || ((...args) => globalThis.setInterval(...args));
        this.clearIntervalRef = options.clearIntervalRef || ((...args) => globalThis.clearInterval(...args));
        this.setTimeoutRef = options.setTimeoutRef || ((...args) => globalThis.setTimeout(...args));
        this.clearTimeoutRef = options.clearTimeoutRef || ((...args) => globalThis.clearTimeout(...args));
        this.now = options.now || (() => Date.now());
        this.classifier = options.classifier || new VoiceExpressionClassifier();
        this.microphoneAvailable = false;
        this.microphoneTrack = null;
        this.localSpeaking = false;
        this.localAudioSpeaking = false;
        this.localVoiceFrames = 0;
        this.localSilenceFrames = 0;
        this.localNoiseFloor = 0.002;
        this.remoteSpeaking = false;
        this.analysisState = null;
        this.speechTransitions = [];
        this.currentState = null;
        this.audioContext = null;
        this.sourceNode = null;
        this.analyser = null;
        this.samples = null;
        this.previousSpectrum = null;
        this.timer = null;
        this.neutralTimer = null;
        this.startGeneration = 0;
        this.startedTrack = null;
        this.lastStateEmittedAt = 0;
    }

    setLiveKitState(state = {}) {
        if (Object.prototype.hasOwnProperty.call(state, 'microphoneAvailable')) {
            this.microphoneAvailable = Boolean(state.microphoneAvailable);
            if (!this.microphoneAvailable) {
                this.microphoneTrack = null;
                this.analysisState = null;
            }
        }
        if (Object.prototype.hasOwnProperty.call(state, 'microphoneTrack')) {
            this.microphoneTrack = state.microphoneTrack || null;
        }
        const nextLocalSpeaking = Object.prototype.hasOwnProperty.call(state, 'localSpeaking')
            ? Boolean(state.localSpeaking)
            : this.localSpeaking;
        if (nextLocalSpeaking !== this.localSpeaking) {
            this.speechTransitions.push(this.now());
            this.speechTransitions = this.speechTransitions.filter((timestamp) => this.now() - timestamp <= 4000);
        }
        this.localSpeaking = nextLocalSpeaking;
        if (Object.prototype.hasOwnProperty.call(state, 'remoteSpeaking')) {
            this.remoteSpeaking = Boolean(state.remoteSpeaking);
        }
        this.reconcileState();
        void this.sync();
    }

    getMode() {
        return String(this.getExpressionMode?.() || '').trim() === 'manual' ? 'manual' : 'audio';
    }

    isLocalSpeechActive() {
        return this.microphoneAvailable && (this.localSpeaking || this.localAudioSpeaking);
    }

    updateLocalAudioActivity(rmsValue) {
        const rms = positive(rmsValue);
        const wasSpeaking = this.localAudioSpeaking;
        if (!this.microphoneAvailable) {
            this.localAudioSpeaking = false;
            this.localVoiceFrames = 0;
            this.localSilenceFrames = 0;
            return wasSpeaking;
        }

        const voiceThreshold = Math.max(LOCAL_VOICE_RMS_FLOOR, this.localNoiseFloor * 2.5);
        if (this.localSpeaking || rms >= voiceThreshold) {
            this.localVoiceFrames += 1;
            this.localSilenceFrames = 0;
            if (this.localSpeaking || this.localVoiceFrames >= LOCAL_VOICE_START_FRAMES) {
                this.localAudioSpeaking = true;
            }
        } else {
            this.localVoiceFrames = 0;
            this.localSilenceFrames += 1;
            if (!this.localAudioSpeaking) {
                this.localNoiseFloor = (this.localNoiseFloor * 0.98) + (rms * 0.02);
            }
            if (this.localSilenceFrames >= LOCAL_VOICE_RELEASE_FRAMES) {
                this.localAudioSpeaking = false;
            }
        }
        return wasSpeaking !== this.localAudioSpeaking;
    }

    reconcileState() {
        this.clearTimeoutRef(this.neutralTimer);
        this.neutralTimer = null;
        if (this.getMode() !== 'audio') return;
        if (!this.microphoneAvailable) {
            this.analysisState = null;
            this.emitState({ emotion: 'neutral', intensity: 0.3, speaking: false });
            return;
        }
        if (this.isLocalSpeechActive()) {
            this.emitState(this.analysisState || {
                emotion: 'speaking',
                intensity: 0.5,
                speaking: true
            });
            return;
        }
        if (this.remoteSpeaking) {
            this.analysisState = null;
            this.emitState({ emotion: 'listening', intensity: 0.45, speaking: false });
            return;
        }
        this.neutralTimer = this.setTimeoutRef(() => {
            this.neutralTimer = null;
            if (
                this.microphoneAvailable
                && !this.isLocalSpeechActive()
                && !this.remoteSpeaking
                && this.getMode() === 'audio'
            ) {
                this.analysisState = null;
                this.emitState({ emotion: 'neutral', intensity: 0.3, speaking: false });
            }
        }, SPEECH_RELEASE_DELAY_MS);
    }

    emitState(state) {
        const normalized = normalizeAvatarRuntimeState(state);
        if (!normalized) return;
        const now = this.now();
        const sameSemanticState = Boolean(
            this.currentState
            && this.currentState.emotion === normalized.emotion
            && this.currentState.speaking === normalized.speaking
        );
        const intensityChanged = sameSemanticState
            && Math.abs(this.currentState.intensity - normalized.intensity) >= INTENSITY_UPDATE_THRESHOLD;
        if (
            sameSemanticState
            && (!intensityChanged || now - this.lastStateEmittedAt < INTENSITY_UPDATE_INTERVAL_MS)
        ) {
            return;
        }
        this.currentState = normalized;
        this.lastStateEmittedAt = now;
        this.onState({ ...normalized });
    }

    async sync() {
        if (this.getMode() !== 'audio') {
            this.stop({ clearRuntimeState: true });
            return;
        }
        if (!this.microphoneAvailable) {
            this.stop({ clearRuntimeState: false });
            this.reconcileState();
            return;
        }
        const track = this.microphoneTrack || getLocalMicrophoneTrack(this.getRoom());
        if (!track || String(track.readyState || '').toLowerCase() === 'ended') {
            this.stop({ clearRuntimeState: false });
            this.microphoneAvailable = false;
            this.microphoneTrack = null;
            this.reconcileState();
            return;
        }
        if (this.startedTrack === track && this.timer) return;
        await this.start(track);
    }

    async start(track) {
        this.stop({ clearRuntimeState: false });
        if (!this.AudioContextRef || !this.MediaStreamRef) return;
        const generation = ++this.startGeneration;
        let audioContext = null;
        let sourceNode = null;
        try {
            const meyda = await this.loadMeyda();
            if (generation !== this.startGeneration || this.getMode() !== 'audio') return;
            audioContext = new this.AudioContextRef();
            const stream = new this.MediaStreamRef([track]);
            sourceNode = audioContext.createMediaStreamSource(stream);
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 2048;
            analyser.smoothingTimeConstant = 0;
            meyda.bufferSize = analyser.fftSize;
            meyda.sampleRate = audioContext.sampleRate;
            sourceNode.connect(analyser);
            if (audioContext.state === 'suspended') {
                await audioContext.resume().catch(() => {});
            }
            if (generation !== this.startGeneration) {
                try { sourceNode.disconnect(); } catch (_) {}
                await audioContext.close().catch(() => {});
                return;
            }
            this.audioContext = audioContext;
            this.sourceNode = sourceNode;
            this.analyser = analyser;
            this.samples = new Float32Array(analyser.fftSize);
            this.previousSpectrum = null;
            this.startedTrack = track;
            this.classifier.reset();
            this.timer = this.setIntervalRef(() => this.sample(meyda), 100);
        } catch (error) {
            try { sourceNode?.disconnect?.(); } catch (_) {}
            await audioContext?.close?.().catch?.(() => {});
            this.onError(error);
        }
    }

    sample(meyda) {
        if (!this.analyser || !this.samples || !this.microphoneAvailable || this.getMode() !== 'audio') return;
        try {
            this.analyser.getFloatTimeDomainData(this.samples);
            const extracted = meyda.extract(MEYDA_FEATURE_NAMES, this.samples) || {};
            const spectrum = extracted.amplitudeSpectrum || null;
            const features = {
                ...extracted,
                spectralFlux: calculateSpectralFlux(spectrum, this.previousSpectrum)
            };
            delete features.amplitudeSpectrum;
            this.previousSpectrum = spectrum ? new Float32Array(spectrum) : null;
            const activityChanged = this.updateLocalAudioActivity(features.rms);
            if (!this.isLocalSpeechActive()) {
                if (activityChanged) this.reconcileState();
                return;
            }
            const result = this.classifier.observe(features, {
                now: this.now(),
                speechTransitions: this.speechTransitions.length
            });
            if (VOICE_EXPRESSIONS.has(result.emotion) || result.emotion === 'speaking') {
                this.analysisState = result;
                this.reconcileState();
            }
        } catch (error) {
            this.onError(error);
        }
    }

    stop(options = {}) {
        this.startGeneration += 1;
        this.clearIntervalRef(this.timer);
        this.clearTimeoutRef(this.neutralTimer);
        this.timer = null;
        this.neutralTimer = null;
        try { this.sourceNode?.disconnect?.(); } catch (_) {}
        void this.audioContext?.close?.().catch?.(() => {});
        this.audioContext = null;
        this.sourceNode = null;
        this.analyser = null;
        this.samples = null;
        this.previousSpectrum = null;
        this.startedTrack = null;
        this.analysisState = null;
        this.localAudioSpeaking = false;
        this.localVoiceFrames = 0;
        this.localSilenceFrames = 0;
        this.localNoiseFloor = 0.002;
        this.classifier.reset();
        if (options.clearRuntimeState && this.currentState) {
            this.currentState = null;
            this.lastStateEmittedAt = 0;
            this.onState(null);
        }
    }

    resetLiveKitState(options = {}) {
        this.microphoneAvailable = false;
        this.microphoneTrack = null;
        this.localSpeaking = false;
        this.localAudioSpeaking = false;
        this.localVoiceFrames = 0;
        this.localSilenceFrames = 0;
        this.remoteSpeaking = false;
        this.analysisState = null;
        this.speechTransitions = [];
        this.stop({ clearRuntimeState: Boolean(options.clearRuntimeState) });
        if (!options.clearRuntimeState && this.getMode() === 'audio') {
            this.emitState({ emotion: 'neutral', intensity: 0.3, speaking: false });
        }
    }

    destroy() {
        this.stop({ clearRuntimeState: true });
    }
}
