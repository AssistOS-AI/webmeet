import { resolveSpeechRecognitionLanguage } from './speechRecognitionLanguages.js';
import {
    MEETING_NOTES_TRANSCRIPT_TOPIC,
    buildMeetingNotesTranscriptSegment,
    isMeetingNotesSecretaryParticipant,
} from './meeting-notes-protocol.js';

const DEFAULT_RESTART_DELAY_MS = 750;
const DEFAULT_DELIVERY_RETRY_MS = 1_000;

function randomId() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

export class BrowserMeetingNotesTranscription {
    constructor(options = {}) {
        this.windowRef = options.windowRef || globalThis.window || null;
        this.navigatorRef = options.navigatorRef || globalThis.navigator || null;
        this.RecognitionClass = options.RecognitionClass
            || this.windowRef?.SpeechRecognition
            || this.windowRef?.webkitSpeechRecognition
            || null;
        this.getRoom = options.getRoom || (() => null);
        this.getEnabled = options.getEnabled || (() => false);
        this.getMicrophoneEnabled = options.getMicrophoneEnabled || (() => false);
        this.getLanguage = options.getLanguage || (() => 'auto');
        this.onStatus = options.onStatus || (() => {});
        this.restartDelayMs = Math.max(50, Number(options.restartDelayMs || DEFAULT_RESTART_DELAY_MS));
        this.deliveryRetryMs = Math.max(50, Number(options.deliveryRetryMs || DEFAULT_DELIVERY_RETRY_MS));
        this.recognition = null;
        this.restartTimer = null;
        this.deliveryTimer = null;
        this.deliveryPromise = null;
        this.deliveryQueue = [];
        this.finalResultIndexes = new WeakMap();
        this.destroyed = false;
        this.shouldListen = false;
        this.sequence = 0;
        this.captureId = randomId();
        this.segmentStartedAt = '';
        this.status = 'paused';
        this.visibilityHandler = () => this.sync();
        this.windowRef?.document?.addEventListener?.('visibilitychange', this.visibilityHandler);
        if (typeof this.RecognitionClass !== 'function') this.setStatus('unsupported');
    }

    findSecretary(room = this.getRoom()) {
        for (const participant of room?.remoteParticipants?.values?.() || []) {
            if (isMeetingNotesSecretaryParticipant(participant)) return participant;
        }
        return null;
    }

    isVisible() {
        return this.windowRef?.document?.visibilityState !== 'hidden';
    }

    canListen() {
        return !this.destroyed
            && typeof this.RecognitionClass === 'function'
            && Boolean(this.getEnabled())
            && Boolean(this.getMicrophoneEnabled())
            && this.isVisible()
            && Boolean(this.findSecretary());
    }

    sync() {
        if (!this.getEnabled()) this.clearDeliveryQueue();
        const next = this.canListen();
        this.shouldListen = next;
        if (next) {
            if (!this.recognition && !this.restartTimer) this.start();
            this.flushDeliveryQueue();
        } else {
            this.stop({ abort: true });
            if (typeof this.RecognitionClass !== 'function') this.setStatus('unsupported');
            else this.setStatus('paused');
        }
        return next;
    }

    start() {
        if (!this.shouldListen || this.recognition || this.destroyed) return false;
        try {
            const recognition = new this.RecognitionClass();
            this.recognition = recognition;
            this.segmentStartedAt = new Date().toISOString();
            recognition.lang = resolveSpeechRecognitionLanguage(this.getLanguage(), this.navigatorRef?.language);
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.onstart = () => this.setStatus('listening');
            recognition.onresult = (event) => this.handleResult(event, recognition);
            recognition.onerror = (event) => this.handleError(event, recognition);
            recognition.onend = () => this.handleEnd(recognition);
            recognition.start();
            this.setStatus('starting');
            return true;
        } catch {
            this.recognition = null;
            this.setStatus('error');
            this.scheduleRestart();
            return false;
        }
    }

    handleResult(event, recognition) {
        if (this.recognition !== recognition) return;
        const results = event?.results || [];
        const startIndex = Number.isInteger(event?.resultIndex) ? event.resultIndex : 0;
        for (let index = startIndex; index < results.length; index += 1) {
            const result = results[index];
            if (result?.isFinal !== true) continue;
            const text = normalizeText(result?.[0]?.transcript);
            if (!text || this.wasFinalResultHandled(recognition, index)) continue;
            this.markFinalResultHandled(recognition, index);
            this.enqueueFinalSegment(text, recognition.lang);
        }
    }

    wasFinalResultHandled(recognition, index) {
        return this.finalResultIndexes.get(recognition)?.has(index) === true;
    }

    markFinalResultHandled(recognition, index) {
        let indexes = this.finalResultIndexes.get(recognition);
        if (!indexes) {
            indexes = new Set();
            this.finalResultIndexes.set(recognition, indexes);
        }
        indexes.add(index);
    }

    enqueueFinalSegment(text, language) {
        this.sequence += 1;
        const endedAt = new Date().toISOString();
        this.deliveryQueue.push(buildMeetingNotesTranscriptSegment({
            segmentId: `${this.captureId}:${this.sequence}`,
            sequence: this.sequence,
            text,
            language,
            startedAt: this.segmentStartedAt,
            endedAt,
        }));
        this.segmentStartedAt = endedAt;
        this.flushDeliveryQueue();
    }

    flushDeliveryQueue() {
        if (this.deliveryPromise || this.deliveryTimer || !this.deliveryQueue.length || this.destroyed) return;
        this.deliveryPromise = this.publishSegment(this.deliveryQueue[0])
            .then(() => {
                this.deliveryQueue.shift();
                if (this.shouldListen) this.setStatus('listening');
            })
            .catch(() => {
                this.setStatus('reconnecting');
                this.scheduleDeliveryRetry();
            })
            .finally(() => {
                this.deliveryPromise = null;
                if (!this.deliveryTimer) queueMicrotask(() => this.flushDeliveryQueue());
            });
    }

    scheduleDeliveryRetry() {
        if (this.deliveryTimer || this.destroyed || !this.deliveryQueue.length) return;
        this.deliveryTimer = this.windowRef?.setTimeout?.(() => {
            this.deliveryTimer = null;
            this.flushDeliveryQueue();
        }, this.deliveryRetryMs) || null;
    }

    clearDeliveryQueue() {
        if (this.deliveryTimer) {
            this.windowRef?.clearTimeout?.(this.deliveryTimer);
            this.deliveryTimer = null;
        }
        this.deliveryQueue = [];
    }

    async publishSegment(segment) {
        const room = this.getRoom();
        const secretary = this.findSecretary(room);
        const localParticipant = room?.localParticipant;
        if (!secretary?.identity || typeof localParticipant?.publishData !== 'function') {
            throw new Error('Meeting Secretary is unavailable.');
        }
        await localParticipant.publishData(new TextEncoder().encode(JSON.stringify(segment)), {
            reliable: true,
            topic: MEETING_NOTES_TRANSCRIPT_TOPIC,
            destinationIdentities: [String(secretary.identity)],
        });
    }

    handleError(event, recognition) {
        if (this.recognition !== recognition) return;
        const code = String(event?.error || '').trim();
        if (code === 'aborted' || code === 'no-speech') return;
        this.setStatus(code === 'not-allowed' || code === 'service-not-allowed' ? 'error' : 'reconnecting');
    }

    handleEnd(recognition) {
        if (this.recognition !== recognition) return;
        this.recognition = null;
        if (this.shouldListen && !this.destroyed) this.scheduleRestart();
        else this.setStatus('paused');
    }

    scheduleRestart() {
        if (!this.shouldListen || this.restartTimer || this.destroyed) return;
        this.setStatus('reconnecting');
        this.restartTimer = this.windowRef?.setTimeout?.(() => {
            this.restartTimer = null;
            if (this.shouldListen) this.start();
        }, this.restartDelayMs) || null;
    }

    stop({ abort = false } = {}) {
        if (this.restartTimer) {
            this.windowRef?.clearTimeout?.(this.restartTimer);
            this.restartTimer = null;
        }
        const recognition = this.recognition;
        this.recognition = null;
        if (!recognition) return;
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        try {
            if (abort) recognition.abort?.();
            else recognition.stop?.();
        } catch (_) {}
    }

    setStatus(status) {
        const next = String(status || 'paused');
        if (next === this.status) return;
        this.status = next;
        this.onStatus(next);
    }

    destroy() {
        this.destroyed = true;
        this.shouldListen = false;
        this.stop({ abort: true });
        this.clearDeliveryQueue();
        this.windowRef?.document?.removeEventListener?.('visibilitychange', this.visibilityHandler);
    }
}

export function createBrowserMeetingNotesTranscription(options = {}) {
    return new BrowserMeetingNotesTranscription(options);
}
