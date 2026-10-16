import { createProcessedMicrophoneTrack } from './microphone-track-factory.js';

function getMediaRecorderConstructor() {
    return globalThis.MediaRecorder || null;
}

function getUrlApi() {
    return globalThis.URL || globalThis.webkitURL || null;
}

function stopRecorder(recorder) {
    if (!recorder || recorder.state === 'inactive') return;
    try { recorder.stop(); } catch (_) {}
}

export function createMicrophoneTestSession(settings = {}, options = {}) {
    const createCapture = options.createProcessedMicrophoneTrack || createProcessedMicrophoneTrack;
    const MediaRecorderRef = options.MediaRecorder || getMediaRecorderConstructor();
    const urlApi = options.urlApi || getUrlApi();
    const setTimeoutRef = options.setTimeout || globalThis.setTimeout;
    const clearTimeoutRef = options.clearTimeout || globalThis.clearTimeout;
    let capture = null;
    let recorder = null;
    let recorderStopTimer = null;
    let sampleUrl = '';
    let stopped = false;

    const revokeSampleUrl = () => {
        if (!sampleUrl) return;
        try { urlApi?.revokeObjectURL?.(sampleUrl); } catch (_) {}
        sampleUrl = '';
    };

    return {
        async start() {
            if (stopped) {
                throw new Error('Microphone test session has already been stopped.');
            }
            capture = await createCapture(settings);
            return capture;
        },

        getStream() {
            return capture?.processedStream || null;
        },

        getMetrics() {
            return capture?.getMetrics?.() || null;
        },

        async recordSample(durationMs = 5000) {
            const stream = capture?.processedStream;
            if (!stream) {
                throw new Error('Start the microphone test before recording a sample.');
            }
            if (!MediaRecorderRef) {
                throw new Error('Recording microphone samples is not supported in this browser.');
            }
            stopRecorder(recorder);
            if (recorderStopTimer) {
                clearTimeoutRef(recorderStopTimer);
                recorderStopTimer = null;
            }
            revokeSampleUrl();
            const chunks = [];
            recorder = new MediaRecorderRef(stream);
            return await new Promise((resolve, reject) => {
                let settled = false;
                const settle = (callback, value) => {
                    if (settled) return;
                    settled = true;
                    if (recorderStopTimer) {
                        clearTimeoutRef(recorderStopTimer);
                        recorderStopTimer = null;
                    }
                    callback(value);
                };
                recorder.ondataavailable = (event) => {
                    if (event?.data?.size) chunks.push(event.data);
                };
                recorder.onerror = (event) => {
                    settle(reject, event?.error || new Error('Microphone sample recording failed.'));
                };
                recorder.onstop = () => {
                    try {
                        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
                        sampleUrl = urlApi?.createObjectURL?.(blob) || '';
                        settle(resolve, { blob, url: sampleUrl });
                    } catch (error) {
                        settle(reject, error);
                    }
                };
                try {
                    recorder.start();
                    recorderStopTimer = setTimeoutRef(() => stopRecorder(recorder), Math.max(500, durationMs));
                } catch (error) {
                    settle(reject, error);
                }
            });
        },

        async stop() {
            stopped = true;
            if (recorderStopTimer) {
                clearTimeoutRef(recorderStopTimer);
                recorderStopTimer = null;
            }
            stopRecorder(recorder);
            recorder = null;
            revokeSampleUrl();
            await capture?.cleanup?.();
            capture = null;
        }
    };
}
