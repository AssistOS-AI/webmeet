const MEYDA_VENDOR_URL = new URL('../../../../vendor/meyda/dist/meyda.min.js', import.meta.url).href;

let loadPromise = null;

function getLoadedMeyda() {
    const candidate = globalThis.Meyda;
    return candidate && typeof candidate.extract === 'function' ? candidate : null;
}

export function getMeydaVendorUrl() {
    return MEYDA_VENDOR_URL;
}

export function loadVendoredMeyda(options = {}) {
    const loaded = getLoadedMeyda();
    if (loaded) return Promise.resolve(loaded);
    if (loadPromise) return loadPromise;

    const documentRef = options.documentRef || globalThis.document;
    if (!documentRef?.createElement || !documentRef?.head?.appendChild) {
        return Promise.reject(new Error('Meyda requires a browser document.'));
    }

    loadPromise = new Promise((resolve, reject) => {
        const script = documentRef.createElement('script');
        script.src = MEYDA_VENDOR_URL;
        script.async = true;
        script.dataset.webmeetVendor = 'meyda-5.6.3';
        script.addEventListener('load', () => {
            const meyda = getLoadedMeyda();
            if (!meyda) {
                loadPromise = null;
                reject(new Error('The local Meyda bundle did not expose its extraction API.'));
                return;
            }
            resolve(meyda);
        }, { once: true });
        script.addEventListener('error', () => {
            loadPromise = null;
            reject(new Error('The local Meyda bundle could not be loaded.'));
        }, { once: true });
        documentRef.head.appendChild(script);
    });
    return loadPromise;
}
