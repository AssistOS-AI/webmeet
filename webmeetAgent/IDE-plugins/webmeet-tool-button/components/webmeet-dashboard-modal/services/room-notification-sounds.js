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
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const isJoin = type === 'join';
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(isJoin ? 520 : 720, now);
        oscillator.frequency.exponentialRampToValueAtTime(isJoin ? 760 : 420, now + 0.16);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.055, now + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(now);
        oscillator.stop(now + 0.2);
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
