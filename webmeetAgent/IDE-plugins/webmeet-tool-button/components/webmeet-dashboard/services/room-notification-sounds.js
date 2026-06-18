function getAudioContextConstructor() {
    return globalThis.AudioContext || globalThis.webkitAudioContext || null;
}

export function createRoomNotificationSoundService(options = {}) {
    const isEnabled = typeof options.isEnabled === 'function'
        ? options.isEnabled
        : (() => true);
    let audioContext = null;
    let unlocked = false;
    let cleanupUnlockListeners = null;

    const ensureAudioContext = () => {
        const AudioContextRef = getAudioContextConstructor();
        if (!AudioContextRef) return null;
        if (!audioContext || audioContext.state === 'closed') {
            audioContext = new AudioContextRef();
        }
        return audioContext;
    };

    const unlock = () => {
        const context = ensureAudioContext();
        if (!context) return;
        const resumeResult = context.state === 'suspended'
            ? context.resume?.()
            : null;
        if (resumeResult && typeof resumeResult.then === 'function') {
            resumeResult.then(() => { unlocked = true; }).catch(() => {});
            return;
        }
        unlocked = true;
    };

    const bindUnlockEvents = (rootElement) => {
        if (cleanupUnlockListeners || !rootElement?.addEventListener) return;
        const onInteraction = () => {
            unlock();
        };
        const options = { passive: true };
        rootElement.addEventListener('pointerdown', onInteraction, options);
        rootElement.addEventListener('keydown', onInteraction);
        cleanupUnlockListeners = () => {
            rootElement.removeEventListener('pointerdown', onInteraction, options);
            rootElement.removeEventListener('keydown', onInteraction);
        };
    };

    const playTone = (type) => {
        if (!isEnabled() || !unlocked) return;
        const context = ensureAudioContext();
        if (!context || context.state === 'closed') return;
        const now = context.currentTime;
        const isJoin = type === 'join';
        const masterGain = context.createGain();
        const notes = isJoin
            ? [
                { frequency: 587.33, start: 0, duration: 0.11 },
                { frequency: 880, start: 0.105, duration: 0.16 }
            ]
            : [
                { frequency: 783.99, start: 0, duration: 0.12 },
                { frequency: 493.88, start: 0.11, duration: 0.18 }
            ];

        masterGain.gain.setValueAtTime(0.0001, now);
        masterGain.gain.exponentialRampToValueAtTime(isJoin ? 0.18 : 0.16, now + 0.012);
        masterGain.gain.exponentialRampToValueAtTime(0.0001, now + (isJoin ? 0.28 : 0.32));
        masterGain.connect(context.destination);

        for (const note of notes) {
            const oscillator = context.createOscillator();
            const noteGain = context.createGain();
            const startAt = now + note.start;
            const stopAt = startAt + note.duration;
            oscillator.type = isJoin ? 'triangle' : 'sine';
            oscillator.frequency.setValueAtTime(note.frequency, startAt);
            noteGain.gain.setValueAtTime(0.0001, startAt);
            noteGain.gain.exponentialRampToValueAtTime(0.72, startAt + 0.01);
            noteGain.gain.exponentialRampToValueAtTime(0.0001, stopAt);
            oscillator.connect(noteGain);
            noteGain.connect(masterGain);
            oscillator.start(startAt);
            oscillator.stop(stopAt + 0.02);
        }
    };

    const teardown = () => {
        cleanupUnlockListeners?.();
        cleanupUnlockListeners = null;
        unlocked = false;
        const context = audioContext;
        audioContext = null;
        try { context?.close?.(); } catch (_) {}
    };

    return {
        bindUnlockEvents,
        playJoin: () => playTone('join'),
        playLeave: () => playTone('leave'),
        teardown
    };
}
