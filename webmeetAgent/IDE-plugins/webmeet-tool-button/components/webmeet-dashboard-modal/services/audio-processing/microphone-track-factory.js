import {
    normalizeHumFilter,
    normalizeMicrophoneGain,
    normalizeVoiceProcessingMode
} from './settings.js';

const WORKLET_MODULE_URL = new URL('./rnnoise-worklet.js', import.meta.url).href;

function getAudioContextConstructor() {
    return globalThis.AudioContext || globalThis.webkitAudioContext || null;
}

export function isEnhancedVoiceProcessingSupported() {
    const browserNavigator = globalThis.navigator;
    return Boolean(
        browserNavigator?.mediaDevices?.getUserMedia
        && getAudioContextConstructor()
        && globalThis.AudioWorkletNode
    );
}

function buildCaptureConstraints(settings = {}, overrides = {}) {
    const audioDeviceId = String(settings.audioInputDeviceId || '').trim();
    const deviceId = audioDeviceId ? { exact: audioDeviceId } : undefined;
    return {
        deviceId,
        channelCount: 1,
        sampleRate: 48000,
        echoCancellation: overrides.echoCancellation,
        noiseSuppression: overrides.noiseSuppression,
        autoGainControl: overrides.autoGainControl
    };
}

function connectIfPresent(sourceNode, targetNode) {
    if (!sourceNode || !targetNode) return targetNode || sourceNode;
    sourceNode.connect(targetNode);
    return targetNode;
}

function createBiquad(audioContext, type, frequency, q = null) {
    const node = audioContext.createBiquadFilter();
    node.type = type;
    node.frequency.value = frequency;
    if (q !== null) {
        node.Q.value = q;
    }
    return node;
}

async function createRnnoiseNode(audioContext) {
    await audioContext.audioWorklet.addModule(WORKLET_MODULE_URL);
    const node = new AudioWorkletNode(audioContext, 'webmeet-rnnoise-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
    });
    try {
        await waitForWorkletReady(node);
    } catch (error) {
        disposeWorkletNode(node);
        throw error;
    }
    return node;
}

function disposeWorkletNode(node) {
    try { node?.port?.postMessage?.({ type: 'dispose' }); } catch (_) {}
    try { node?.disconnect?.(); } catch (_) {}
}

function waitForWorkletReady(node, timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            node.port.onmessage = null;
            disposeWorkletNode(node);
            reject(new Error('RNNoise voice processing did not initialize in time.'));
        }, timeoutMs);
        node.port.onmessage = (event) => {
            if (settled) return;
            if (event.data?.type === 'ready') {
                settled = true;
                clearTimeout(timeout);
                node.port.onmessage = null;
                resolve();
                return;
            }
            if (event.data?.type === 'error') {
                settled = true;
                clearTimeout(timeout);
                node.port.onmessage = null;
                disposeWorkletNode(node);
                reject(new Error(event.data.message || 'RNNoise voice processing failed to initialize.'));
            }
        };
    });
}

export async function createProcessedMicrophoneTrack(settings = {}) {
    const browserNavigator = globalThis.navigator;
    if (!browserNavigator?.mediaDevices?.getUserMedia) {
        throw new Error('Microphone capture is not supported in this browser.');
    }
    const AudioContextRef = getAudioContextConstructor();
    if (!AudioContextRef) {
        throw new Error('Audio processing is not supported in this browser.');
    }

    const mode = normalizeVoiceProcessingMode(settings.voiceProcessingMode);
    const humFilter = normalizeHumFilter(settings.humFilter);
    const enhanced = mode === 'enhanced';
    const sourceStream = await browserNavigator.mediaDevices.getUserMedia({
        audio: buildCaptureConstraints(settings, {
            echoCancellation: mode !== 'off' && settings.echoCancellation !== false,
            noiseSuppression: mode === 'standard' && settings.noiseSuppression !== false,
            autoGainControl: settings.autoGainControl === true
        }),
        video: false
    });
    const audioContext = new AudioContextRef({ sampleRate: 48000 });
    if (audioContext.state === 'suspended') {
        try { await audioContext.resume(); } catch (_) {}
    }

    const nodes = [];
    let rnnoiseNode = null;
    let processedTrack = null;
    let destination = null;
    try {
        const sourceNode = audioContext.createMediaStreamSource(sourceStream);
        nodes.push(sourceNode);
        let currentNode = sourceNode;

        if (enhanced) {
            const highPassNode = createBiquad(audioContext, 'highpass', 90, 0.707);
            nodes.push(highPassNode);
            currentNode = connectIfPresent(currentNode, highPassNode);

            rnnoiseNode = await createRnnoiseNode(audioContext);
            nodes.push(rnnoiseNode);
            currentNode = connectIfPresent(currentNode, rnnoiseNode);
        }

        if (humFilter !== 'off') {
            const humFrequency = humFilter === '60' ? 60 : 50;
            const humNode = createBiquad(audioContext, 'notch', humFrequency, 18);
            nodes.push(humNode);
            currentNode = connectIfPresent(currentNode, humNode);
        }

        const compressorNode = audioContext.createDynamicsCompressor();
        compressorNode.threshold.value = -10;
        compressorNode.knee.value = 12;
        compressorNode.ratio.value = 8;
        compressorNode.attack.value = 0.004;
        compressorNode.release.value = 0.12;
        nodes.push(compressorNode);
        currentNode = connectIfPresent(currentNode, compressorNode);

        const gainNode = audioContext.createGain();
        gainNode.gain.value = normalizeMicrophoneGain(settings.microphoneGain);
        nodes.push(gainNode);
        currentNode = connectIfPresent(currentNode, gainNode);

        destination = audioContext.createMediaStreamDestination();
        currentNode.connect(destination);
        [processedTrack] = destination.stream.getAudioTracks();
        if (!processedTrack) {
            throw new Error('Processed microphone track could not be created.');
        }
        processedTrack.contentHint = 'speech';

        const cleanup = async () => {
            for (const track of [
                processedTrack,
                ...(destination?.stream?.getTracks?.() || []),
                ...(sourceStream?.getTracks?.() || [])
            ]) {
                try { track?.stop?.(); } catch (_) {}
            }
            for (const node of nodes) {
                try { node?.disconnect?.(); } catch (_) {}
            }
            try { await audioContext?.close?.(); } catch (_) {}
        };

        return {
            track: processedTrack,
            sourceStream,
            processedStream: destination.stream,
            audioContext,
            cleanup,
            status: {
                mode,
                rnnoise: Boolean(rnnoiseNode)
            }
        };
    } catch (error) {
        for (const track of [
            processedTrack,
            ...(destination?.stream?.getTracks?.() || []),
            ...(sourceStream?.getTracks?.() || [])
        ]) {
            try { track?.stop?.(); } catch (_) {}
        }
        for (const node of nodes) {
            try { node?.disconnect?.(); } catch (_) {}
        }
        try { await audioContext?.close?.(); } catch (_) {}
        throw error;
    }
}
