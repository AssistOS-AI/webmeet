import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AUTO_SPEECH_RECOGNITION_LANGUAGE,
    DEFAULT_SPEECH_RECOGNITION_LANGUAGE,
    SPEECH_RECOGNITION_LANGUAGES,
    normalizeSpeechRecognitionLanguage,
    resolveSpeechRecognitionLanguage
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/speechRecognitionLanguages.js';

test('speech recognition catalog contains Auto and all 24 official EU languages', () => {
    assert.equal(SPEECH_RECOGNITION_LANGUAGES[0].value, AUTO_SPEECH_RECOGNITION_LANGUAGE);
    assert.equal(SPEECH_RECOGNITION_LANGUAGES.length, 25);
    const values = SPEECH_RECOGNITION_LANGUAGES.map(({ value }) => value);
    assert.equal(new Set(values).size, values.length);
    for (const value of values.slice(1)) {
        assert.match(value, /^[a-z]{2}-[A-Z]{2}$/);
    }
});

test('speech recognition setting normalizes unknown values to Auto', () => {
    assert.equal(normalizeSpeechRecognitionLanguage('ro-RO'), 'ro-RO');
    assert.equal(normalizeSpeechRecognitionLanguage('unknown'), AUTO_SPEECH_RECOGNITION_LANGUAGE);
    assert.equal(normalizeSpeechRecognitionLanguage(), AUTO_SPEECH_RECOGNITION_LANGUAGE);
});

test('Auto resolves to browser language and then the stable fallback', () => {
    assert.equal(resolveSpeechRecognitionLanguage('auto', 'ro-RO'), 'ro-RO');
    assert.equal(resolveSpeechRecognitionLanguage('auto', ''), DEFAULT_SPEECH_RECOGNITION_LANGUAGE);
    assert.equal(resolveSpeechRecognitionLanguage('fr-FR', 'ro-RO'), 'fr-FR');
});
