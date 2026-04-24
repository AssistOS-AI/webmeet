const LIVEKIT_UMD_URL = new URL('../../../vendor/livekit-client.umd.min.js', import.meta.url).href;

let livekitLoadPromise = null;

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
