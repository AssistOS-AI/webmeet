export const AVATAR_SOURCE_MODES = Object.freeze({
    GENERATED: 'generated',
    PACK: 'pack',
    SVG: 'svg'
});

function normalizeAvatarSourceMode(value = '') {
    const raw = String(value || '').trim();
    return Object.values(AVATAR_SOURCE_MODES).includes(raw)
        ? raw
        : '';
}

export function deriveAvatarSourceMode(config = {}) {
    const source = config && typeof config === 'object' ? config : {};
    const explicit = normalizeAvatarSourceMode(source.sourceMode || source['source-mode']);
    if (explicit) return explicit;
    if (String(source.src || '').trim()) return AVATAR_SOURCE_MODES.SVG;
    if (String(source.packSrc || source['pack-src'] || '').trim()) return AVATAR_SOURCE_MODES.PACK;
    if (source.generated === false) return AVATAR_SOURCE_MODES.PACK;
    return AVATAR_SOURCE_MODES.GENERATED;
}

function getDefaultAvatarPackSrc(packs = []) {
    const first = Array.isArray(packs) ? packs[0] : null;
    return String(first?.manifestSrc || '').trim();
}

export function normalizeAvatarForSourceMode(config = {}, sourceMode = deriveAvatarSourceMode(config), options = {}) {
    const mode = Object.values(AVATAR_SOURCE_MODES).includes(sourceMode)
        ? sourceMode
        : deriveAvatarSourceMode(config);
    const source = config && typeof config === 'object' ? { ...config } : {};
    const packs = Array.isArray(options.packs) ? options.packs : [];
    if (mode === AVATAR_SOURCE_MODES.GENERATED) {
        return {
            ...source,
            sourceMode: mode,
            generated: true,
            src: '',
            packSrc: ''
        };
    }
    if (mode === AVATAR_SOURCE_MODES.PACK) {
        const packSrc = String(source.packSrc || '').trim() || getDefaultAvatarPackSrc(packs);
        return {
            ...source,
            sourceMode: mode,
            generated: false,
            src: '',
            packSrc
        };
    }
    return {
        ...source,
        sourceMode: mode,
        generated: false,
        packSrc: '',
        src: String(source.src || '').trim()
    };
}

export function formatAvatarOptionLabel(value = '') {
    const text = String(value || '').trim();
    if (!text) return 'Default';
    return text
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
        .join(' ');
}
