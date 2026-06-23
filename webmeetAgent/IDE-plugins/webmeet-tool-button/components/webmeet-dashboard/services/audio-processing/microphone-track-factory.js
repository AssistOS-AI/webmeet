import {
    normalizeHumFilter,
    normalizeMicrophoneGain,
    normalizeVoiceProcessingMode
} from './settings.js';
import {
    AdaptiveGainController,
    createAudioLevelMonitor
} from './audio-level-analyzer.js';

const WORKLET_MODULE_URL = new URL('./rnnoise-worklet.js', import.meta.url).href;
let workletPreloadPromise = null;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

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
    const automaticCleanup = normalizeVoiceProcessingMode(settings.voiceProcessingMode) === 'auto';
    return {
        deviceId,
        channelCount: 1,
        sampleRate: 48000,
        echoCancellation: automaticCleanup
            ? true
            : overrides.echoCancellation,
        noiseSuppression: automaticCleanup
            ? true
            : overrides.noiseSuppression,
        autoGainControl: automaticCleanup
            ? true
            : overrides.autoGainControl
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

export async function preloadVoiceProcessingWorklet() {
    if (workletPreloadPromise) return workletPreloadPromise;
    const AudioContextRef = getAudioContextConstructor();
    if (!AudioContextRef) {
        return Promise.resolve(false);
    }
    workletPreloadPromise = (async () => {
        const audioContext = new AudioContextRef({ sampleRate: 48000 });
        try {
            await audioContext.audioWorklet.addModule(WORKLET_MODULE_URL);
            return true;
        } finally {
            try { await audioContext.close?.(); } catch (_) {}
        }
    })().catch((error) => {
        workletPreloadPromise = null;
        throw error;
    });
    return workletPreloadPromise;
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

function createNoiseGateController(audioContext, gainNode) {
    let currentGain = 1;
    return {
        update(metrics = {}) {
            const rmsDb = Number(metrics.rmsDb);
            const noiseFloorDb = Number(metrics.noiseFloorDb);
            const floor = Number.isFinite(noiseFloorDb) ? noiseFloorDb : -60;
            const thresholdDb = clamp(floor + 10, -58, -38);
            const open = metrics.speaking === true || (Number.isFinite(rmsDb) && rmsDb > thresholdDb);
            const distanceBelowThreshold = Number.isFinite(rmsDb)
                ? clamp((thresholdDb - rmsDb) / 18, 0, 1)
                : 1;
            const targetGain = open ? 1 : clamp(1 - (distanceBelowThreshold * 0.72), 0.28, 1);
            const timeConstant = targetGain > currentGain ? 0.035 : 0.16;
            currentGain = targetGain;
            gainNode.gain.setTargetAtTime(targetGain, audioContext.currentTime, timeConstant);
            return targetGain;
        }
    };
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
    const automatic = mode === 'auto';
    const humFilter = normalizeHumFilter(settings.humFilter);
    const enhanced = automatic || mode === 'enhanced';
    const configuredGain = normalizeMicrophoneGain(settings.microphoneGain);
    const browserAudioCleanup = automatic || mode === 'standard' || mode === 'custom';
    const sourceStream = await browserNavigator.mediaDevices.getUserMedia({
        audio: buildCaptureConstraints(settings, {
            echoCancellation: browserAudioCleanup && (automatic || settings.echoCancellation !== false),
            noiseSuppression: browserAudioCleanup && (automatic || settings.noiseSuppression !== false),
            autoGainControl: browserAudioCleanup && (automatic || settings.autoGainControl === true)
        }),
        video: false
    });
    const audioContext = new AudioContextRef({ sampleRate: 48000 });
    if (audioContext.state === 'suspended') {
        try { await audioContext.resume(); } catch (_) {}
    }

    const nodes = [];
    let rnnoiseNode = null;
    let levelMonitor = null;
    let adaptiveGainController = null;
    let processedTrack = null;
    let destination = null;
    try {
        const sourceNode = audioContext.createMediaStreamSource(sourceStream);
        nodes.push(sourceNode);
        let currentNode = sourceNode;
        let automaticHumNode = null;

        if (enhanced) {
            const highPassNode = createBiquad(audioContext, 'highpass', 90, 0.707);
            nodes.push(highPassNode);
            currentNode = connectIfPresent(currentNode, highPassNode);

            rnnoiseNode = await createRnnoiseNode(audioContext);
            nodes.push(rnnoiseNode);
            currentNode = connectIfPresent(currentNode, rnnoiseNode);
        }

        if (humFilter === '50' || humFilter === '60') {
            const humFrequency = humFilter === '60' ? 60 : 50;
            const humNode = createBiquad(audioContext, 'notch', humFrequency, 18);
            nodes.push(humNode);
            currentNode = connectIfPresent(currentNode, humNode);
        } else if (humFilter === 'auto') {
            automaticHumNode = createBiquad(audioContext, 'notch', 10, 1);
            nodes.push(automaticHumNode);
            currentNode = connectIfPresent(currentNode, automaticHumNode);
        }

        const gateGainNode = audioContext.createGain();
        gateGainNode.gain.value = 1;
        nodes.push(gateGainNode);
        currentNode = connectIfPresent(currentNode, gateGainNode);

        const gainNode = audioContext.createGain();
        gainNode.gain.value = configuredGain;
        nodes.push(gainNode);
        currentNode = connectIfPresent(currentNode, gainNode);

        if (automatic || automaticHumNode) {
            adaptiveGainController = new AdaptiveGainController();
            const noiseGateController = createNoiseGateController(audioContext, gateGainNode);
            levelMonitor = createAudioLevelMonitor(audioContext, sourceNode, {
                onMetrics(metrics) {
                    const gateGain = noiseGateController.update(metrics);
                    const adaptiveGain = automatic ? adaptiveGainController.update(metrics) : 1;
                    if (automatic) {
                        gainNode.gain.setTargetAtTime(
                            configuredGain * adaptiveGain,
                            audioContext.currentTime,
                            adaptiveGain < 1 ? 0.08 : 0.4
                        );
                    }
                    if (automaticHumNode) {
                        const frequency = metrics.humFrequency === '60' ? 60
                            : metrics.humFrequency === '50' ? 50
                                : 10;
                        const q = metrics.humFrequency === 'off' ? 1 : 18;
                        automaticHumNode.frequency.setTargetAtTime(frequency, audioContext.currentTime, 0.4);
                        automaticHumNode.Q.setTargetAtTime(q, audioContext.currentTime, 0.4);
                    }
                    settings.onMetrics?.({
                        ...metrics,
                        adaptiveGain,
                        gateGain,
                        mode
                    });
                }
            });
        }

        const compressorNode = audioContext.createDynamicsCompressor();
        compressorNode.threshold.value = -10;
        compressorNode.knee.value = 12;
        compressorNode.ratio.value = 8;
        compressorNode.attack.value = 0.004;
        compressorNode.release.value = 0.12;
        nodes.push(compressorNode);
        currentNode = connectIfPresent(currentNode, compressorNode);

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
            levelMonitor?.stop?.();
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
                rnnoise: Boolean(rnnoiseNode),
                adaptiveGain: automatic
            },
            getMetrics: () => levelMonitor?.getMetrics?.() || null
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
        levelMonitor?.stop?.();
        try { await audioContext?.close?.(); } catch (_) {}
        throw error;
    }
}
