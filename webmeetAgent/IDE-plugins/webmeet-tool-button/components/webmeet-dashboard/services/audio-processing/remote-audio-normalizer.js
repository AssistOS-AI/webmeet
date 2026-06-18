import { analyzeTimeDomainSamples } from './audio-level-analyzer.js';

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

export class RemoteAudioNormalizer {
    constructor(options = {}) {
        this.isEnabled = typeof options.isEnabled === 'function' ? options.isEnabled : (() => true);
        this.hasManualOverride = typeof options.hasManualOverride === 'function' ? options.hasManualOverride : (() => false);
        this.onMultiplierChange = typeof options.onMultiplierChange === 'function' ? options.onMultiplierChange : (() => {});
        this.entries = new Map();
    }

    start(mediaElement, participantId) {
        if (!mediaElement || this.entries.has(mediaElement)) return;
        const AudioContextRef = globalThis.AudioContext || globalThis.webkitAudioContext || null;
        const stream = mediaElement.srcObject;
        if (!AudioContextRef || !stream?.getAudioTracks?.().length) return;
        let audioContext = null;
        let source = null;
        let analyser = null;
        try {
            audioContext = new AudioContextRef({ sampleRate: 48000 });
            source = audioContext.createMediaStreamSource(stream);
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 2048;
            analyser.smoothingTimeConstant = 0.85;
            source.connect(analyser);
            if (audioContext.state === 'suspended') {
                void audioContext.resume().catch(() => {});
            }
        } catch (_) {
            try { source?.disconnect?.(); } catch (_) {}
            void audioContext?.close?.().catch?.(() => {});
            return;
        }
        const samples = new Float32Array(analyser.fftSize);
        const entry = {
            participantId: String(participantId || '').trim(),
            mediaElement,
            audioContext,
            source,
            analyser,
            samples,
            multiplier: 1,
            timer: null
        };
        entry.timer = globalThis.setInterval(() => this.updateEntry(entry), 500);
        this.entries.set(mediaElement, entry);
    }

    updateEntry(entry) {
        if (!entry?.mediaElement?.isConnected) {
            this.stop(entry?.mediaElement);
            return;
        }
        if (!this.isEnabled() || this.hasManualOverride(entry.participantId)) {
            this.setMultiplier(entry, 1);
            return;
        }
        entry.analyser.getFloatTimeDomainData(entry.samples);
        const metrics = analyzeTimeDomainSamples(entry.samples);
        if (metrics.rmsDb < -50) return;
        const targetDb = -22;
        const desired = clamp(10 ** ((targetDb - metrics.rmsDb) / 20), 0.75, 1.25);
        const amount = desired < entry.multiplier ? 0.3 : 0.12;
        this.setMultiplier(entry, entry.multiplier + ((desired - entry.multiplier) * amount));
    }

    setMultiplier(entry, value) {
        const multiplier = clamp(Number(value) || 1, 0.75, 1.25);
        if (Math.abs(multiplier - entry.multiplier) < 0.005) return;
        entry.multiplier = multiplier;
        this.onMultiplierChange(entry.mediaElement, multiplier, entry.participantId);
    }

    getMultiplier(mediaElement) {
        return this.entries.get(mediaElement)?.multiplier || 1;
    }

    refreshParticipant(participantId) {
        const id = String(participantId || '').trim();
        for (const entry of this.entries.values()) {
            if (entry.participantId !== id) continue;
            if (!this.isEnabled() || this.hasManualOverride(id)) {
                this.setMultiplier(entry, 1);
            }
        }
    }

    stop(mediaElement) {
        const entry = this.entries.get(mediaElement);
        if (!entry) return;
        this.entries.delete(mediaElement);
        globalThis.clearInterval(entry.timer);
        try { entry.source.disconnect(); } catch (_) {}
        try { entry.analyser.disconnect(); } catch (_) {}
        void entry.audioContext.close().catch(() => {});
    }

    stopParticipant(participantId) {
        const id = String(participantId || '').trim();
        for (const [mediaElement, entry] of this.entries.entries()) {
            if (entry.participantId === id) this.stop(mediaElement);
        }
    }

    stopAll() {
        for (const mediaElement of [...this.entries.keys()]) {
            this.stop(mediaElement);
        }
    }
}
