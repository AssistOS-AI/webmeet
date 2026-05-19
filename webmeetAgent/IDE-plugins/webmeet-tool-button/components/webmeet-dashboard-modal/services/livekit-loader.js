const LIVEKIT_UMD_URL = new URL('../../../vendor/livekit-client.umd.min.js', import.meta.url).href;
const TRACK_PROCESSORS_MODULE_URL = new URL('../../../vendor/livekit-track-processors.bundle.mjs', import.meta.url).href;
const BACKGROUND_TASKS_VISION_FILESET_URL = new URL('../../../vendor/background-effects/wasm/', import.meta.url).href;
const BACKGROUND_SEGMENTER_MODEL_URL = new URL('../../../vendor/background-effects/models/selfie_segmenter.tflite', import.meta.url).href;

let livekitLoadPromise = null;
let backgroundEffectsModulePromise = null;

export async function ensureLiveKitClient() {
    if (window.LivekitClient) {
        return window.LivekitClient;
    }
    if (!livekitLoadPromise) {
        livekitLoadPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = LIVEKIT_UMD_URL;
            script.async = true;
            script.onload = () => {
                if (window.LivekitClient) {
                    resolve(window.LivekitClient);
                    return;
                }
                reject(new Error('LiveKit SDK did not register a global.'));
            };
            script.onerror = () => reject(new Error('Failed to load LiveKit SDK.'));
            document.head.appendChild(script);
        });
    }
    return livekitLoadPromise;
}

export async function ensureBackgroundEffectsModule() {
    if (!backgroundEffectsModulePromise) {
        backgroundEffectsModulePromise = import(TRACK_PROCESSORS_MODULE_URL);
    }
    return backgroundEffectsModulePromise;
}

export function getBackgroundEffectsAssetPaths() {
    return {
        tasksVisionFileSet: BACKGROUND_TASKS_VISION_FILESET_URL,
        modelAssetPath: BACKGROUND_SEGMENTER_MODEL_URL
    };
}
