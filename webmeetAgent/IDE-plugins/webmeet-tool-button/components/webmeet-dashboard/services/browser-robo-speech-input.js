import { resolveSpeechRecognitionLanguage } from './speechRecognitionLanguages.js';

const ROBO_PREFIX = '/robo ';
const FINALIZATION_TIMEOUT_MS = 1500;

function normalizeTranscript(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function getRecognitionErrorMessage(code) {
    switch (String(code || '').trim()) {
        case 'not-allowed':
        case 'service-not-allowed':
            return 'Microphone access was denied. Allow microphone access and try again.';
        case 'audio-capture':
            return 'No microphone is available for voice input.';
        case 'network':
            return 'Voice recognition could not reach the browser speech service.';
        case 'language-not-supported':
            return 'Voice recognition does not support the selected language.';
        default:
            return 'Voice recognition failed. Hold the microphone and try again.';
    }
}

function dispatchInput(input) {
    if (!input?.dispatchEvent) return;
    const EventClass = input.ownerDocument?.defaultView?.Event || globalThis.Event;
    if (typeof EventClass === 'function') {
        input.dispatchEvent(new EventClass('input', { bubbles: true }));
    }
}

export class BrowserRoboSpeechInput {
    constructor(options = {}) {
        this.input = options.input || null;
        this.button = options.button || null;
        this.status = options.status || null;
        this.onSubmit = typeof options.onSubmit === 'function' ? options.onSubmit : async () => {};
        this.onError = typeof options.onError === 'function' ? options.onError : () => {};
        this.getLanguage = typeof options.getLanguage === 'function' ? options.getLanguage : () => 'auto';
        this.windowRef = options.windowRef || globalThis.window || null;
        this.navigatorRef = options.navigatorRef || globalThis.navigator || null;
        this.RecognitionClass = options.RecognitionClass
            || this.windowRef?.SpeechRecognition
            || this.windowRef?.webkitSpeechRecognition
            || null;
        this.supported = typeof this.RecognitionClass === 'function';
        this.recognition = null;
        this.activePointerId = null;
        this.keyboardHeld = false;
        this.held = false;
        this.finalizeRequested = false;
        this.cancelled = false;
        this.busy = false;
        this.finalSegments = [];
        this.interimTranscript = '';
        this.previousReadOnly = false;
        this.suppressClick = false;
        this.suppressClickTimer = null;
        this.finalizationTimer = null;
        this.microphonePermissionPrepared = false;
        this.microphonePermissionPromise = null;
        this.destroyed = false;

        this.handleInput = () => this.sync();
        this.handlePointerDown = (event) => this.onPointerDown(event);
        this.handlePointerUp = (event) => this.onPointerUp(event);
        this.handlePointerCancel = (event) => this.onPointerCancel(event);
        this.handleKeyDown = (event) => this.onKeyDown(event);
        this.handleKeyUp = (event) => this.onKeyUp(event);
        this.handleClick = (event) => this.onClick(event);
        this.handleVisibilityChange = () => {
            if (this.input?.ownerDocument?.visibilityState === 'hidden') {
                this.cancelVoiceCapture();
            }
        };

        this.bind();
        this.sync();
    }

    bind() {
        this.input?.addEventListener?.('input', this.handleInput);
        this.button?.addEventListener?.('pointerdown', this.handlePointerDown);
        this.button?.addEventListener?.('keydown', this.handleKeyDown);
        this.button?.addEventListener?.('keyup', this.handleKeyUp);
        this.button?.addEventListener?.('click', this.handleClick);
        this.windowRef?.addEventListener?.('pointerup', this.handlePointerUp, true);
        this.windowRef?.addEventListener?.('pointercancel', this.handlePointerCancel, true);
        this.input?.ownerDocument?.addEventListener?.('visibilitychange', this.handleVisibilityChange);
    }

    isVoiceMode() {
        return !String(this.input?.value || '').trim();
    }

    sync() {
        if (!this.button || this.destroyed) return;
        if (this.busy) return;
        if (this.input?.disabled) {
            this.setButtonState('disabled');
            return;
        }
        if (this.held || this.finalizeRequested) {
            this.setButtonState(this.finalizeRequested ? 'finalizing' : 'listening');
            return;
        }
        if (this.isVoiceMode()) {
            this.setButtonState(this.supported ? 'microphone' : 'unsupported');
            return;
        }
        this.setButtonState('send');
    }

    setButtonState(mode) {
        if (!this.button) return;
        const state = String(mode || 'microphone');
        const labels = {
            microphone: 'Hold to speak a Robo command',
            listening: 'Listening… Release to run the Robo command',
            finalizing: 'Finishing voice command…',
            sending: 'Running Robo command…',
            send: 'Send message',
            disabled: 'Chat is unavailable for this room',
            unsupported: 'Voice input is unavailable in this browser'
        };
        this.button.dataset.mode = state;
        this.button.title = labels[state] || labels.microphone;
        this.button.setAttribute('aria-label', labels[state] || labels.microphone);
        this.button.setAttribute('aria-pressed', state === 'listening' ? 'true' : 'false');
        this.button.disabled = ['unsupported', 'disabled', 'finalizing', 'sending'].includes(state);
        if (state === 'send') {
            this.button.dataset.localAction = 'sendChat';
        } else {
            delete this.button.dataset.localAction;
            this.button.removeAttribute?.('data-local-action');
        }
        if (this.status) {
            this.status.textContent = state === 'listening'
                ? 'Listening for a Robo command.'
                : state === 'finalizing'
                    ? 'Finishing the Robo command.'
                    : state === 'sending'
                        ? 'Running the Robo command.'
                        : '';
        }
    }

    setInputValue(value) {
        if (!this.input) return;
        this.input.value = value;
        dispatchInput(this.input);
    }

    composeTranscript() {
        return normalizeTranscript([...this.finalSegments, this.interimTranscript].filter(Boolean).join(' '));
    }

    updateInputFromTranscript() {
        const transcript = this.composeTranscript();
        this.setInputValue(transcript ? `${ROBO_PREFIX}${transcript}` : ROBO_PREFIX);
    }

    onPointerDown(event) {
        if (event?.button != null && event.button !== 0) return;
        if (!this.isVoiceMode() || this.busy || this.held) return;
        event?.preventDefault?.();
        this.activePointerId = event?.pointerId ?? 'pointer';
        try {
            this.button?.setPointerCapture?.(event.pointerId);
        } catch (_) {
            // Window-level pointer listeners still complete the gesture.
        }
        this.beginVoiceCapture();
    }

    onPointerUp(event) {
        if (this.activePointerId == null) return;
        if (event?.pointerId != null && event.pointerId !== this.activePointerId) return;
        event?.preventDefault?.();
        this.activePointerId = null;
        this.armClickSuppression();
        this.endVoiceCapture();
    }

    onPointerCancel(event) {
        if (this.activePointerId == null) return;
        if (event?.pointerId != null && event.pointerId !== this.activePointerId) return;
        this.activePointerId = null;
        this.armClickSuppression();
        this.cancelVoiceCapture();
    }

    onKeyDown(event) {
        if (![' ', 'Enter'].includes(event?.key) || event?.repeat) return;
        if (!this.isVoiceMode() || this.busy || this.held) return;
        event.preventDefault();
        this.keyboardHeld = true;
        this.beginVoiceCapture();
    }

    onKeyUp(event) {
        if (!this.keyboardHeld || ![' ', 'Enter'].includes(event?.key)) return;
        event.preventDefault();
        this.keyboardHeld = false;
        this.armClickSuppression();
        this.endVoiceCapture();
    }

    onClick(event) {
        if (!this.suppressClick) return;
        event.preventDefault?.();
        event.stopPropagation?.();
        this.suppressClick = false;
    }

    armClickSuppression() {
        this.suppressClick = true;
        if (this.suppressClickTimer != null) {
            this.windowRef?.clearTimeout?.(this.suppressClickTimer);
        }
        const setTimer = this.windowRef?.setTimeout?.bind(this.windowRef) || globalThis.setTimeout;
        this.suppressClickTimer = setTimer?.(() => {
            this.suppressClick = false;
            this.suppressClickTimer = null;
        }, 500) ?? null;
    }

    beginVoiceCapture() {
        if (!this.supported) {
            this.onError('Voice input is unavailable in this browser.');
            return false;
        }
        this.held = true;
        this.finalizeRequested = false;
        this.cancelled = false;
        this.finalSegments = [];
        this.interimTranscript = '';
        this.previousReadOnly = Boolean(this.input?.readOnly);
        if (this.input) this.input.readOnly = true;
        this.updateInputFromTranscript();
        this.setButtonState('listening');
        return this.startRecognition();
    }

    async prepareMicrophonePermission() {
        if (!this.supported) return { status: 'unsupported', requested: false };
        if (this.microphonePermissionPrepared) return { status: 'granted', requested: false };
        if (this.microphonePermissionPromise) return this.microphonePermissionPromise;
        this.microphonePermissionPromise = this.requestMicrophonePermission()
            .finally(() => {
                this.microphonePermissionPromise = null;
            });
        return this.microphonePermissionPromise;
    }

    async requestMicrophonePermission() {
        const getUserMedia = this.navigatorRef?.mediaDevices?.getUserMedia;
        if (typeof getUserMedia !== 'function') {
            return { status: 'unsupported', requested: false };
        }

        let permissionState = '';
        try {
            const permission = await this.navigatorRef?.permissions?.query?.({ name: 'microphone' });
            permissionState = String(permission?.state || '').trim();
        } catch (_) {
            // Some supported browsers do not expose microphone through Permissions API.
        }
        if (permissionState === 'granted') {
            this.microphonePermissionPrepared = true;
            return { status: 'granted', requested: false };
        }
        if (permissionState === 'denied') {
            return { status: 'denied', requested: false };
        }

        let stream = null;
        try {
            stream = await getUserMedia.call(this.navigatorRef.mediaDevices, { audio: true, video: false });
            this.microphonePermissionPrepared = true;
            return { status: 'granted', requested: true };
        } catch (error) {
            const code = String(error?.name || error?.code || '').trim();
            if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(code)) {
                return { status: 'denied', requested: true };
            }
            return { status: 'error', requested: true };
        } finally {
            for (const track of stream?.getTracks?.() || []) {
                try {
                    track.stop();
                } catch (_) {}
            }
        }
    }

    startRecognition() {
        if (!this.held || this.cancelled || this.destroyed || this.recognition) return false;
        try {
            const recognition = new this.RecognitionClass();
            this.recognition = recognition;
            recognition.lang = resolveSpeechRecognitionLanguage(
                this.getLanguage(),
                this.navigatorRef?.language
            );
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.onresult = (event) => this.handleRecognitionResult(event);
            recognition.onerror = (event) => this.handleRecognitionError(event);
            recognition.onend = () => this.handleRecognitionEnd(recognition);
            recognition.start();
            return true;
        } catch (error) {
            this.recognition = null;
            this.failVoiceCapture(error?.message || 'Voice recognition could not start.');
            return false;
        }
    }

    handleRecognitionResult(event) {
        this.interimTranscript = '';
        const results = event?.results || [];
        const startIndex = Number.isInteger(event?.resultIndex) ? event.resultIndex : 0;
        for (let index = startIndex; index < results.length; index += 1) {
            const result = results[index];
            const transcript = normalizeTranscript(result?.[0]?.transcript);
            if (!transcript) continue;
            if (result.isFinal) {
                this.finalSegments.push(transcript);
            } else {
                this.interimTranscript = normalizeTranscript(`${this.interimTranscript} ${transcript}`);
            }
        }
        this.updateInputFromTranscript();
    }

    handleRecognitionError(event) {
        const code = String(event?.error || '').trim();
        if (this.cancelled || code === 'aborted') return;
        if (code === 'no-speech') return;
        this.failVoiceCapture(getRecognitionErrorMessage(code));
    }

    handleRecognitionEnd(recognition) {
        if (this.recognition !== recognition) return;
        this.recognition = null;
        this.clearFinalizationTimer();
        if (this.cancelled || this.destroyed) return;
        if (this.held && !this.finalizeRequested) {
            this.startRecognition();
            return;
        }
        if (this.finalizeRequested) {
            void this.finalizeAndSubmit();
        }
    }

    endVoiceCapture() {
        if (!this.held || this.cancelled) return;
        this.held = false;
        this.finalizeRequested = true;
        this.setButtonState('finalizing');
        if (!this.recognition) {
            void this.finalizeAndSubmit();
            return;
        }
        try {
            this.recognition.stop();
            this.scheduleFinalizationFallback();
        } catch (_) {
            this.recognition = null;
            void this.finalizeAndSubmit();
        }
    }

    scheduleFinalizationFallback() {
        this.clearFinalizationTimer();
        const setTimer = this.windowRef?.setTimeout?.bind(this.windowRef) || globalThis.setTimeout;
        this.finalizationTimer = setTimer?.(() => {
            this.finalizationTimer = null;
            const recognition = this.recognition;
            this.recognition = null;
            if (recognition) {
                recognition.onresult = null;
                recognition.onerror = null;
                recognition.onend = null;
                try {
                    recognition.abort?.();
                } catch (_) {}
            }
            void this.finalizeAndSubmit();
        }, FINALIZATION_TIMEOUT_MS) ?? null;
    }

    clearFinalizationTimer() {
        if (this.finalizationTimer == null) return;
        const clearTimer = this.windowRef?.clearTimeout?.bind(this.windowRef) || globalThis.clearTimeout;
        clearTimer?.(this.finalizationTimer);
        this.finalizationTimer = null;
    }

    async finalizeAndSubmit() {
        if (!this.finalizeRequested || this.cancelled || this.busy) return;
        this.finalizeRequested = false;
        const transcript = this.composeTranscript();
        this.restoreInputEditing();
        if (!transcript) {
            this.setInputValue('');
            this.onError('No speech was recognized. Hold the microphone and try again.');
            this.sync();
            return;
        }
        this.setInputValue(`${ROBO_PREFIX}${transcript}`);
        this.busy = true;
        this.setButtonState('sending');
        try {
            await this.onSubmit();
        } catch (error) {
            this.onError(error?.message || 'The Robo command could not be submitted.');
        } finally {
            this.busy = false;
            this.sync();
        }
    }

    failVoiceCapture(message) {
        this.clearFinalizationTimer();
        this.cancelled = true;
        this.held = false;
        this.finalizeRequested = false;
        const recognition = this.recognition;
        this.recognition = null;
        if (recognition) {
            recognition.onresult = null;
            recognition.onerror = null;
            recognition.onend = null;
            try {
                recognition.abort?.();
            } catch (_) {}
        }
        this.restoreInputEditing();
        this.setInputValue('');
        this.onError(String(message || 'Voice recognition failed.'));
        this.sync();
    }

    cancelVoiceCapture() {
        if (!this.held && !this.finalizeRequested && !this.recognition) return;
        this.clearFinalizationTimer();
        this.cancelled = true;
        this.held = false;
        this.finalizeRequested = false;
        this.activePointerId = null;
        this.keyboardHeld = false;
        const recognition = this.recognition;
        this.recognition = null;
        if (recognition) {
            recognition.onresult = null;
            recognition.onerror = null;
            recognition.onend = null;
            try {
                recognition.abort?.();
            } catch (_) {}
        }
        this.restoreInputEditing();
        this.setInputValue('');
        this.sync();
    }

    restoreInputEditing() {
        if (this.input) this.input.readOnly = this.previousReadOnly;
    }

    destroy() {
        if (this.destroyed) return;
        this.cancelVoiceCapture();
        this.clearFinalizationTimer();
        this.destroyed = true;
        this.input?.removeEventListener?.('input', this.handleInput);
        this.button?.removeEventListener?.('pointerdown', this.handlePointerDown);
        this.button?.removeEventListener?.('keydown', this.handleKeyDown);
        this.button?.removeEventListener?.('keyup', this.handleKeyUp);
        this.button?.removeEventListener?.('click', this.handleClick);
        this.windowRef?.removeEventListener?.('pointerup', this.handlePointerUp, true);
        this.windowRef?.removeEventListener?.('pointercancel', this.handlePointerCancel, true);
        this.input?.ownerDocument?.removeEventListener?.('visibilitychange', this.handleVisibilityChange);
        if (this.suppressClickTimer != null) {
            const clearTimer = this.windowRef?.clearTimeout?.bind(this.windowRef) || globalThis.clearTimeout;
            clearTimer?.(this.suppressClickTimer);
            this.suppressClickTimer = null;
        }
    }
}

export function createBrowserRoboSpeechInput(options = {}) {
    return new BrowserRoboSpeechInput(options);
}
