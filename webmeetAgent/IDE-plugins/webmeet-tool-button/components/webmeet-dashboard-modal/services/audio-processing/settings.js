export const VOICE_PROCESSING_MODES = Object.freeze(['enhanced', 'standard', 'off']);
export const HUM_FILTER_MODES = Object.freeze(['off', '50', '60']);

export function normalizeVoiceProcessingMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    return VOICE_PROCESSING_MODES.includes(mode) ? mode : 'enhanced';
}

export function normalizeHumFilter(value) {
    const mode = String(value || '').trim().toLowerCase().replace(/hz$/g, '');
    return HUM_FILTER_MODES.includes(mode) ? mode : 'off';
}

export function normalizeMicrophoneGain(value) {
    const gain = Number(value);
    if (!Number.isFinite(gain)) return 1;
    return Math.min(2, Math.max(0, gain));
}

export function usesAudioGraph(settings = {}) {
    return normalizeVoiceProcessingMode(settings.voiceProcessingMode) === 'enhanced'
        || normalizeHumFilter(settings.humFilter) !== 'off'
        || Math.abs(normalizeMicrophoneGain(settings.microphoneGain) - 1) > 0.001;
}
