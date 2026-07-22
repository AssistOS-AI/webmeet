import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserRoboSpeechInput } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/browser-robo-speech-input.js';

class FakeDocument extends EventTarget {
    constructor() {
        super();
        this.defaultView = { Event };
        this.visibilityState = 'visible';
    }
}

class FakeElement extends EventTarget {
    constructor(ownerDocument) {
        super();
        this.ownerDocument = ownerDocument;
        this.dataset = {};
        this.attributes = new Map();
        this.value = '';
        this.disabled = false;
        this.readOnly = false;
        this.title = '';
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    setPointerCapture() {}
}

class FakeWindow extends EventTarget {
    constructor(RecognitionClass) {
        super();
        this.SpeechRecognition = RecognitionClass;
        this.setTimeout = setTimeout;
        this.clearTimeout = clearTimeout;
    }
}

class FakeRecognition {
    static instances = [];

    constructor() {
        this.lang = '';
        this.continuous = false;
        this.interimResults = false;
        this.started = false;
        this.stopped = false;
        this.aborted = false;
        FakeRecognition.instances.push(this);
    }

    start() {
        this.started = true;
    }

    stop() {
        this.stopped = true;
    }

    abort() {
        this.aborted = true;
    }

    emitResult(transcript, isFinal = false) {
        const result = [{ transcript }];
        result.isFinal = isFinal;
        this.onresult?.({ resultIndex: 0, results: [result] });
    }

    emitError(error) {
        this.onerror?.({ error });
    }

    emitEnd() {
        this.onend?.();
    }
}

function createHarness(options = {}) {
    FakeRecognition.instances = [];
    const documentRef = new FakeDocument();
    const input = new FakeElement(documentRef);
    const button = new FakeElement(documentRef);
    const status = new FakeElement(documentRef);
    const windowRef = new FakeWindow(options.supported === false ? null : FakeRecognition);
    const navigatorRef = options.navigatorRef || { language: 'ro-RO' };
    const submissions = [];
    const errors = [];
    const service = new BrowserRoboSpeechInput({
        input,
        button,
        status,
        windowRef,
        navigatorRef,
        RecognitionClass: options.supported === false ? null : FakeRecognition,
        onSubmit: async () => submissions.push(input.value),
        onError: (message) => errors.push(message)
    });
    return { service, input, button, status, windowRef, submissions, errors };
}

function pointerEvent(type, pointerId = 1) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
        pointerId: { value: pointerId },
        button: { value: 0 }
    });
    return event;
}

function keyEvent(type, key) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
        key: { value: key },
        repeat: { value: false }
    });
    return event;
}

test('empty composer uses microphone mode and typed text restores send action', () => {
    const { service, input, button } = createHarness();

    assert.equal(button.dataset.mode, 'microphone');
    assert.equal(button.dataset.localAction, undefined);

    input.value = 'hello';
    input.dispatchEvent(new Event('input'));
    assert.equal(button.dataset.mode, 'send');
    assert.equal(button.dataset.localAction, 'sendChat');

    input.value = '   ';
    input.dispatchEvent(new Event('input'));
    assert.equal(button.dataset.mode, 'microphone');
    service.destroy();
});

test('push-to-talk exposes /robo immediately and submits the finalized transcript once', async () => {
    const { service, input, button, windowRef, submissions } = createHarness();
    const observedValues = [];
    input.addEventListener('input', () => observedValues.push(input.value));

    button.dispatchEvent(pointerEvent('pointerdown', 7));
    const recognition = FakeRecognition.instances[0];
    assert.equal(observedValues[0], '/robo ');
    assert.equal(button.dataset.mode, 'listening');
    assert.equal(recognition.lang, 'ro-RO');
    assert.equal(recognition.continuous, true);
    assert.equal(recognition.interimResults, true);

    recognition.emitResult('mută linia trei', false);
    assert.equal(input.value, '/robo mută linia trei');

    windowRef.dispatchEvent(pointerEvent('pointerup', 7));
    assert.equal(button.dataset.mode, 'finalizing');
    assert.equal(recognition.stopped, true);
    recognition.emitResult('mută linia trei cu 30 de pixeli', true);
    recognition.emitEnd();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(submissions, ['/robo mută linia trei cu 30 de pixeli']);
    assert.equal(button.dataset.mode, 'send');
    service.destroy();
});

test('pointer cancellation aborts recognition and never submits', async () => {
    const { service, input, button, windowRef, submissions } = createHarness();
    button.dispatchEvent(pointerEvent('pointerdown', 2));
    const recognition = FakeRecognition.instances[0];
    recognition.emitResult('șterge cercul', true);

    windowRef.dispatchEvent(pointerEvent('pointercancel', 2));
    await Promise.resolve();

    assert.equal(recognition.aborted, true);
    assert.equal(input.value, '');
    assert.deepEqual(submissions, []);
    service.destroy();
});

test('keyboard hold and release follows the same push-to-talk submission flow', async () => {
    const { service, button, submissions } = createHarness();
    button.dispatchEvent(keyEvent('keydown', ' '));
    const recognition = FakeRecognition.instances[0];
    recognition.emitResult('mută cercul în dreapta', true);
    button.dispatchEvent(keyEvent('keyup', ' '));
    recognition.emitEnd();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(submissions, ['/robo mută cercul în dreapta']);
    service.destroy();
});

test('recognition restarts after an unexpected end while the control remains held', () => {
    const { service, button } = createHarness();
    button.dispatchEvent(pointerEvent('pointerdown', 4));
    const first = FakeRecognition.instances[0];
    first.emitResult('creează', true);
    first.emitEnd();

    assert.equal(FakeRecognition.instances.length, 2);
    assert.equal(FakeRecognition.instances[1].started, true);
    service.cancelVoiceCapture();
    service.destroy();
});

test('permission errors clear the draft and report a natural-language error', () => {
    const { service, input, button, errors } = createHarness();
    button.dispatchEvent(pointerEvent('pointerdown', 9));
    FakeRecognition.instances[0].emitError('not-allowed');

    assert.equal(input.value, '');
    assert.match(errors[0], /access was denied/i);
    assert.equal(button.dataset.mode, 'microphone');
    service.destroy();
});

test('unsupported browsers disable only the empty microphone state', () => {
    const { service, input, button } = createHarness({ supported: false });
    assert.equal(button.dataset.mode, 'unsupported');
    assert.equal(button.disabled, true);

    input.value = 'typed message';
    input.dispatchEvent(new Event('input'));
    assert.equal(button.dataset.mode, 'send');
    assert.equal(button.disabled, false);
    assert.equal(button.dataset.localAction, 'sendChat');
    service.destroy();
});

test('a disabled chat composer disables both voice and send actions', () => {
    const { service, input, button } = createHarness();
    input.disabled = true;
    service.sync();
    assert.equal(button.dataset.mode, 'disabled');
    assert.equal(button.disabled, true);
    assert.equal(button.dataset.localAction, undefined);
    service.destroy();
});

test('releasing without recognized speech does not submit a command', async () => {
    const { service, button, windowRef, submissions, errors } = createHarness();
    button.dispatchEvent(pointerEvent('pointerdown', 3));
    const recognition = FakeRecognition.instances[0];
    windowRef.dispatchEvent(pointerEvent('pointerup', 3));
    recognition.emitEnd();
    await Promise.resolve();

    assert.deepEqual(submissions, []);
    assert.match(errors[0], /No speech was recognized/);
    service.destroy();
});

test('room entry requests pending microphone permission once and stops the temporary stream', async () => {
    let captureCount = 0;
    let stopCount = 0;
    const navigatorRef = {
        language: 'ro-RO',
        permissions: { query: async () => ({ state: 'prompt' }) },
        mediaDevices: {
            getUserMedia: async () => {
                captureCount += 1;
                return { getTracks: () => [{ stop: () => { stopCount += 1; } }] };
            }
        }
    };
    const { service } = createHarness({ navigatorRef });

    const first = await service.prepareMicrophonePermission();
    const second = await service.prepareMicrophonePermission();

    assert.deepEqual(first, { status: 'granted', requested: true });
    assert.deepEqual(second, { status: 'granted', requested: false });
    assert.equal(captureCount, 1);
    assert.equal(stopCount, 1);
    service.destroy();
});

test('already granted microphone permission does not open a temporary stream', async () => {
    let captureCount = 0;
    const navigatorRef = {
        language: 'ro-RO',
        permissions: { query: async () => ({ state: 'granted' }) },
        mediaDevices: { getUserMedia: async () => { captureCount += 1; } }
    };
    const { service } = createHarness({ navigatorRef });

    assert.deepEqual(
        await service.prepareMicrophonePermission(),
        { status: 'granted', requested: false }
    );
    assert.equal(captureCount, 0);
    service.destroy();
});

test('denied microphone permission does not retry capture during room entry', async () => {
    let captureCount = 0;
    const navigatorRef = {
        language: 'ro-RO',
        permissions: { query: async () => ({ state: 'denied' }) },
        mediaDevices: { getUserMedia: async () => { captureCount += 1; } }
    };
    const { service } = createHarness({ navigatorRef });

    assert.deepEqual(
        await service.prepareMicrophonePermission(),
        { status: 'denied', requested: false }
    );
    assert.equal(captureCount, 0);
    service.destroy();
});
