import { Rnnoise } from '../../../../vendor/rnnoise/rnnoise.js';

const RNNOISE_PCM_SCALE = 32768;

class RnnoiseProcessor extends AudioWorkletProcessor {
    constructor(options = {}) {
        super();
        this.inputQueue = [];
        this.outputQueue = [];
        this.frameSize = 480;
        this.denoiseState = null;
        this.ready = false;
        this.failed = false;
        this.disposed = false;
        this.port.onmessage = (event) => {
            if (event.data?.type === 'dispose') {
                this.dispose();
            }
        };
        this.init(options.processorOptions || {});
    }

    async init(options) {
        try {
            const rnnoise = await Rnnoise.load();
            if (this.disposed) return;
            this.frameSize = rnnoise.frameSize || this.frameSize;
            const denoiseState = rnnoise.createDenoiseState();
            if (this.disposed) {
                denoiseState.destroy();
                return;
            }
            this.denoiseState = denoiseState;
            this.ready = true;
            this.port.postMessage({ type: 'ready' });
        } catch (error) {
            if (this.disposed) return;
            this.failed = true;
            this.port.postMessage({
                type: 'error',
                message: error instanceof Error ? error.message : String(error)
            });
        }
    }

    dispose() {
        this.disposed = true;
        this.ready = false;
        this.failed = true;
        this.inputQueue = [];
        this.outputQueue = [];
        try { this.denoiseState?.destroy?.(); } catch (_) {}
        this.denoiseState = null;
    }

    process(inputs, outputs) {
        if (this.disposed) return false;
        const input = inputs[0]?.[0] || null;
        const output = outputs[0]?.[0] || null;
        if (!output) return true;
        if (!input || this.failed || !this.ready || !this.denoiseState) {
            if (input) output.set(input);
            return true;
        }

        for (let i = 0; i < input.length; i += 1) {
            this.inputQueue.push(input[i]);
        }

        while (this.inputQueue.length >= this.frameSize) {
            const frame = new Float32Array(this.frameSize);
            for (let i = 0; i < this.frameSize; i += 1) {
                const sample = Math.max(-1, Math.min(1, this.inputQueue.shift() || 0));
                frame[i] = sample * RNNOISE_PCM_SCALE;
            }
            this.denoiseState.processFrame(frame);
            for (let i = 0; i < frame.length; i += 1) {
                this.outputQueue.push(Math.max(-1, Math.min(1, frame[i] / RNNOISE_PCM_SCALE)));
            }
        }

        for (let i = 0; i < output.length; i += 1) {
            output[i] = this.outputQueue.length ? this.outputQueue.shift() : input[i] || 0;
        }
        return true;
    }
}

registerProcessor('webmeet-rnnoise-processor', RnnoiseProcessor);
