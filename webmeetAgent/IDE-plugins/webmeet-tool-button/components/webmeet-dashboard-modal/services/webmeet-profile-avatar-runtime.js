const DEFAULT_CONFIG = Object.freeze({
    agentId: 'profile:current-user',
    generated: true,
    src: '',
    packSrc: '',
    assetMode: 'img',
    emotion: 'neutral',
    size: '72',
    thought: '',
    thoughtMode: 'none',
    mode: 'static',
    shape: 'circle',
    theme: 'auto',
    animated: true,
    listen: false,
    seed: 'profile:current-user',
    style: 'robot-soft',
    palette: 'default',
    complexity: ''
});

const AVATAR_SETTINGS_EVENT = 'assistOS:avatar-settings-updated';
const AVATAR_SETTINGS_CHANNEL = 'assistOS.avatar-settings';
const AVATAR_SETTINGS_STORAGE_KEY = 'assistOS.avatar-settings.updated';

let axiFaceLoadPromise = null;
let axiFaceModule = null;
let explorerProfileAvatarClientPromise = null;
let updateListenerInstalled = false;
let avatarBroadcastChannel = null;
const currentUserCache = {
    value: null,
    promise: null
};

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function isGuestWebMeetContext() {
    try {
        const pathname = String(window?.location?.pathname || '').trim();
        return pathname.startsWith('/public-services/webmeet/');
    } catch (_) {
        return false;
    }
}

function getAxiFaceModuleUrl() {
    return isGuestWebMeetContext()
        ? '/public-services/webmeet/axi-face/src/axi-face.mjs'
        : '/services/explorer/axi-face/src/axi-face.mjs';
}

function normalizeAxiFaceStyleList(styles = []) {
    if (!Array.isArray(styles)) return [];
    return styles
        .map((style) => String(style || '').trim())
        .filter(Boolean);
}

function dispatchAvatarSettingsEvent(detail = {}) {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(AVATAR_SETTINGS_EVENT, { detail }));
}

function installUpdateListener() {
    if (updateListenerInstalled || typeof window === 'undefined') return;
    window.addEventListener(AVATAR_SETTINGS_EVENT, (event) => {
        const type = String(event?.detail?.type || '').trim();
        if (!type || type === 'profile') {
            invalidateProfileAvatarCache();
        }
    });
    try {
        if (typeof BroadcastChannel === 'function') {
            avatarBroadcastChannel = avatarBroadcastChannel || new BroadcastChannel(AVATAR_SETTINGS_CHANNEL);
            avatarBroadcastChannel.addEventListener('message', (event) => {
                if (event?.data && typeof event.data === 'object') {
                    dispatchAvatarSettingsEvent(event.data);
                }
            });
        }
    } catch (_) {
        // Optional cross-tab updates.
    }
    window.addEventListener('storage', (event) => {
        if (event.key !== AVATAR_SETTINGS_STORAGE_KEY || !event.newValue) return;
        try {
            const detail = JSON.parse(event.newValue);
            if (detail && typeof detail === 'object') {
                dispatchAvatarSettingsEvent(detail);
            }
        } catch (_) {
            // Ignore malformed cross-tab payloads.
        }
    });
    updateListenerInstalled = true;
}

function loadExplorerProfileAvatarClient() {
    if (explorerProfileAvatarClientPromise) return explorerProfileAvatarClientPromise;
    explorerProfileAvatarClientPromise = import('/explorer/services/profile-avatar-client.js');
    return explorerProfileAvatarClientPromise;
}

export function normalizeAvatarConfig(config, fallbackId = 'profile:current-user') {
    const source = config && typeof config === 'object' ? config : {};
    return {
        ...DEFAULT_CONFIG,
        ...source,
        agentId: String(source.agentId || fallbackId),
        seed: String(source.seed || source.agentId || fallbackId)
    };
}

export function getFallbackLetter(value) {
    const text = String(value || '').trim();
    if (!text) return '?';
    return (text.match(/[a-zA-Z0-9]/)?.[0] || text[0] || '?').toUpperCase();
}

function toAxiFaceAttributes(config) {
    const normalized = normalizeAvatarConfig(config);
    const attrs = [];
    const add = (name, value) => {
        const raw = String(value ?? '').trim();
        if (raw) attrs.push(`${name}="${escapeHtml(raw)}"`);
    };
    add('agent-id', normalized.agentId);
    add('emotion', normalized.emotion);
    add('size', normalized.size);
    add('thought', normalized.thought);
    add('thought-mode', normalized.thoughtMode);
    add('mode', normalized.mode);
    add('shape', normalized.shape);
    add('theme', normalized.theme);
    add('asset-mode', normalized.assetMode);
    add('seed', normalized.seed);
    add('data-axi-style', normalized.style);
    add('palette', normalized.palette);
    add('complexity', normalized.complexity);
    add('src', normalized.src);
    add('pack-src', normalized.packSrc);
    if (normalized.generated) attrs.push('generated');
    if (normalized.animated) attrs.push('animated');
    if (normalized.listen) attrs.push('listen');
    return attrs.join(' ');
}

export function renderAxiFaceMarkup(config) {
    return `<axi-face ${toAxiFaceAttributes(config)}></axi-face>`;
}

export function getLoadedAxiFaceGeneratedFaceStyles() {
    return normalizeAxiFaceStyleList(axiFaceModule?.GENERATED_FACE_STYLES);
}

export async function loadAxiFaceModule() {
    if (!axiFaceLoadPromise) {
        axiFaceLoadPromise = import(`${getAxiFaceModuleUrl()}?cacheBust=${Date.now()}`).catch((error) => {
            axiFaceLoadPromise = null;
            throw error;
        });
    }
    axiFaceModule = await axiFaceLoadPromise;
    return axiFaceModule;
}

export async function loadAxiFaceGeneratedFaceStyles() {
    const module = await loadAxiFaceModule();
    return normalizeAxiFaceStyleList(module?.GENERATED_FACE_STYLES);
}

export async function ensureAxiFaceLoaded() {
    if (customElements.get('axi-face') && axiFaceModule) return;
    await loadAxiFaceModule();
}

export async function getCurrentProfileAvatar(options = {}) {
    installUpdateListener();
    if (isGuestWebMeetContext()) {
        return null;
    }
    if (!options?.force && currentUserCache.value) {
        return currentUserCache.value;
    }
    if (!options?.force && currentUserCache.promise) {
        return currentUserCache.promise;
    }
    const client = await loadExplorerProfileAvatarClient();
    currentUserCache.promise = client.getCurrentProfileAvatar(options)
        .then((avatar) => {
            currentUserCache.value = avatar;
            return avatar;
        })
        .finally(() => {
            currentUserCache.promise = null;
        });
    return currentUserCache.promise;
}

export function invalidateProfileAvatarCache() {
    currentUserCache.value = null;
    currentUserCache.promise = null;
    if (!isGuestWebMeetContext()) {
        void loadExplorerProfileAvatarClient()
            .then((client) => client.invalidateProfileAvatarCache?.())
            .catch(() => {});
    }
}

export function createParticipantProfileAvatarController({
    getParticipantDisplayName = (participant) => String(participant?.identity || 'Participant'),
    getParticipantAvatarUserId = (participant) => (participant?.kind === 'local' ? 'me' : ''),
    getCurrentUserId = () => '',
    loadAxiFace = ensureAxiFaceLoaded
} = {}) {
    const requestTokens = new Map();

    const applyFallback = (view, participant = null) => {
        const label = getParticipantDisplayName(participant) || view?.name || view?.id || '';
        view.avatarEnabled = false;
        view.avatarConfig = null;
        view.avatarFallbackLetter = getFallbackLetter(label);
        view.avatarResolved = true;
    };

    const getProjectedAvatar = (participant = null) => {
        const projected = participant?.profileAvatar && typeof participant.profileAvatar === 'object'
            ? participant.profileAvatar
            : null;
        if (!projected) return null;
        return {
            enabled: projected.enabled !== false,
            config: projected.config && typeof projected.config === 'object' ? projected.config : null,
            fallbackLetter: projected.fallbackLetter || ''
        };
    };

    const refresh = async (view, participant = null, apply = () => {}) => {
        if (!view?.id) return;
        const token = Symbol(view.id);
        requestTokens.set(view.id, token);
        const userId = String(getParticipantAvatarUserId(participant) || view.avatarUserId || '').trim();
        view.avatarUserId = userId;
        if (!userId) {
            applyFallback(view, participant);
            apply(view);
            return;
        }
        try {
            const projectedAvatar = userId === 'me' ? null : getProjectedAvatar(participant);
            const avatar = projectedAvatar || (userId === 'me'
                ? await getCurrentProfileAvatar({ force: true })
                : null);
            if (!avatar) {
                applyFallback(view, participant);
                apply(view);
                return;
            }
            if (requestTokens.get(view.id) !== token) return;
            view.avatarEnabled = avatar.enabled !== false;
            view.avatarConfig = view.avatarEnabled ? avatar.config : null;
            view.avatarFallbackLetter = avatar.fallbackLetter || getFallbackLetter(getParticipantDisplayName(participant) || view.name || view.id);
            view.avatarResolved = true;
            apply(view);
            if (view.avatarEnabled && view.avatarConfig) {
                await loadAxiFace().catch(() => {});
            }
            if (requestTokens.get(view.id) !== token) return;
        } catch (_) {
            if (requestTokens.get(view.id) !== token) return;
            applyFallback(view, participant);
            apply(view);
            return;
        }
        apply(view);
    };

    const bindUpdates = (getViews, apply = () => {}) => {
        const refreshMatchingViews = (userId = '') => {
            const normalizedUserId = String(userId || '').trim();
            invalidateProfileAvatarCache(normalizedUserId);
            for (const view of getViews?.() || []) {
                if (normalizedUserId && String(view?.avatarUserId || '').trim() !== normalizedUserId) {
                    continue;
                }
                refresh(view, null, apply);
            }
        };
        const handler = (event) => {
            const eventUserId = String(event?.detail?.userId || '').trim();
            const currentUserId = String(getCurrentUserId?.() || '').trim();
            if (eventUserId && currentUserId && eventUserId !== currentUserId) return;
            refreshMatchingViews(eventUserId);
        };
        window.addEventListener(AVATAR_SETTINGS_EVENT, handler);
        return () => window.removeEventListener(AVATAR_SETTINGS_EVENT, handler);
    };

    return {
        applyFallback,
        bindUpdates,
        refresh,
        refreshUser(userId, getViews, apply = () => {}) {
            const normalizedUserId = String(userId || '').trim();
            if (!normalizedUserId) return;
            invalidateProfileAvatarCache(normalizedUserId);
            for (const view of getViews?.() || []) {
                if (String(view?.avatarUserId || '').trim() === normalizedUserId) {
                    refresh(view, null, apply);
                }
            }
        }
    };
}
