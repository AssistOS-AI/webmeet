export const AUTO_SPEECH_RECOGNITION_LANGUAGE = 'auto';
export const DEFAULT_SPEECH_RECOGNITION_LANGUAGE = 'en-US';

export const SPEECH_RECOGNITION_LANGUAGES = Object.freeze([
    { value: AUTO_SPEECH_RECOGNITION_LANGUAGE, label: 'Automatic — browser language' },
    { value: 'bg-BG', label: 'Български (bg-BG)' },
    { value: 'hr-HR', label: 'Hrvatski (hr-HR)' },
    { value: 'cs-CZ', label: 'Čeština (cs-CZ)' },
    { value: 'da-DK', label: 'Dansk (da-DK)' },
    { value: 'nl-NL', label: 'Nederlands (nl-NL)' },
    { value: 'en-GB', label: 'English (en-GB)' },
    { value: 'et-EE', label: 'Eesti (et-EE)' },
    { value: 'fi-FI', label: 'Suomi (fi-FI)' },
    { value: 'fr-FR', label: 'Français (fr-FR)' },
    { value: 'de-DE', label: 'Deutsch (de-DE)' },
    { value: 'el-GR', label: 'Ελληνικά (el-GR)' },
    { value: 'hu-HU', label: 'Magyar (hu-HU)' },
    { value: 'ga-IE', label: 'Gaeilge (ga-IE)' },
    { value: 'it-IT', label: 'Italiano (it-IT)' },
    { value: 'lv-LV', label: 'Latviešu (lv-LV)' },
    { value: 'lt-LT', label: 'Lietuvių (lt-LT)' },
    { value: 'mt-MT', label: 'Malti (mt-MT)' },
    { value: 'pl-PL', label: 'Polski (pl-PL)' },
    { value: 'pt-PT', label: 'Português (pt-PT)' },
    { value: 'ro-RO', label: 'Română (ro-RO)' },
    { value: 'sk-SK', label: 'Slovenčina (sk-SK)' },
    { value: 'sl-SI', label: 'Slovenščina (sl-SI)' },
    { value: 'es-ES', label: 'Español (es-ES)' },
    { value: 'sv-SE', label: 'Svenska (sv-SE)' }
].map(Object.freeze));

const SPEECH_RECOGNITION_LANGUAGE_VALUES = new Set(
    SPEECH_RECOGNITION_LANGUAGES.map(({ value }) => value)
);

export function normalizeSpeechRecognitionLanguage(value) {
    const normalized = String(value || '').trim();
    return SPEECH_RECOGNITION_LANGUAGE_VALUES.has(normalized)
        ? normalized
        : AUTO_SPEECH_RECOGNITION_LANGUAGE;
}

export function resolveSpeechRecognitionLanguage(value, browserLanguage) {
    const normalized = normalizeSpeechRecognitionLanguage(value);
    if (normalized !== AUTO_SPEECH_RECOGNITION_LANGUAGE) return normalized;
    return String(browserLanguage || '').trim() || DEFAULT_SPEECH_RECOGNITION_LANGUAGE;
}
