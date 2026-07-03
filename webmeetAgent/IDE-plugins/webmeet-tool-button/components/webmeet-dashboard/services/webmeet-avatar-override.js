import {
    normalizeAvatarConfig,
    renderAxiFaceMarkup
} from './webmeet-profile-avatar-runtime.js';
import { EMOTIONS } from '../../../../../../explorer/shared/vendor/axi-face/src/state-machine.mjs';
import {
    formatAvatarOptionLabel
} from './avatar-settings-model.js';

const STORAGE_PREFIX = 'webmeet.avatarOverride.';

export const WEBMEET_AVATAR_PRESETS = Object.freeze(EMOTIONS.map((emotion) => Object.freeze({
    id: emotion,
    label: formatAvatarOptionLabel(emotion),
    patch: Object.freeze({ emotion })
})));

export function getWebMeetAvatarPreset(presetId = '') {
    const id = String(presetId || '').trim();
    return WEBMEET_AVATAR_PRESETS.find((entry) => entry.id === id) || WEBMEET_AVATAR_PRESETS[0];
}

export function getWebMeetAvatarStorageKey(userId = '') {
    const normalizedUserId = String(userId || 'anonymous').trim() || 'anonymous';
    return `${STORAGE_PREFIX}${normalizedUserId}`;
}

export function normalizeWebMeetAvatarOverride(value = null) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const config = value.config && typeof value.config === 'object'
        ? value.config
        : null;
    if (!config) return null;
    const normalizedConfig = normalizeAvatarConfig({
        ...config,
        sourceMode: config.sourceMode || config['source-mode'] || ''
    }, config.agentId || config.seed || 'profile:current-user');
    return {
        config: normalizedConfig,
        updatedAt: String(value.updatedAt || new Date().toISOString())
    };
}

export function loadWebMeetAvatarOverride(userId = '') {
    try {
        const raw = String(window?.localStorage?.getItem(getWebMeetAvatarStorageKey(userId)) || '').trim();
        if (!raw) return null;
        return normalizeWebMeetAvatarOverride(JSON.parse(raw));
    } catch (_) {
        return null;
    }
}

export function saveWebMeetAvatarOverride(userId = '', override = null) {
    const normalized = normalizeWebMeetAvatarOverride({
        ...override,
        updatedAt: new Date().toISOString()
    });
    if (!normalized) return null;
    try {
        window?.localStorage?.setItem(getWebMeetAvatarStorageKey(userId), JSON.stringify(normalized));
    } catch (_) {
        // Local override persistence is best-effort; the current room update still applies.
    }
    return normalized;
}

export function clearWebMeetAvatarOverride(userId = '') {
    try {
        window?.localStorage?.removeItem(getWebMeetAvatarStorageKey(userId));
    } catch (_) {
        // Ignore storage failures.
    }
}

export function buildWebMeetAvatarSource({ profileAvatar = null, override = null, userId = '', participantId = '' } = {}) {
    const normalizedOverride = normalizeWebMeetAvatarOverride(override);
    if (!normalizedOverride) {
        const sourceKind = String(profileAvatar?.source?.kind || '').trim();
        if (sourceKind === 'fallback' || sourceKind === 'error') {
            return null;
        }
        return profileAvatar || null;
    }
    const normalizedUserId = String(userId || profileAvatar?.user?.id || '').trim();
    const fallbackId = `profile:${normalizedUserId || participantId || 'current-user'}`;
    return {
        ...(profileAvatar && typeof profileAvatar === 'object' ? profileAvatar : {}),
        user: profileAvatar?.user || (normalizedUserId ? { id: normalizedUserId } : null),
        enabled: true,
        config: normalizeAvatarConfig(normalizedOverride.config, fallbackId),
        fallbackLetter: profileAvatar?.fallbackLetter || ''
    };
}

export function buildWebMeetAvatarOverrideConfig({ profileAvatar = null, override = null, userId = '', participantId = '', patch = {} } = {}) {
    const normalizedUserId = String(userId || profileAvatar?.user?.id || '').trim();
    const fallbackId = `profile:${normalizedUserId || participantId || 'current-user'}`;
    const baseConfig = normalizeWebMeetAvatarOverride(override)?.config
        || normalizeAvatarConfig(profileAvatar?.config, fallbackId);
    return normalizeAvatarConfig({
        ...baseConfig,
        ...patch,
        agentId: baseConfig.agentId || fallbackId,
        seed: baseConfig.seed || baseConfig.agentId || fallbackId
    }, fallbackId);
}

export function renderWebMeetAvatarPreview(config = null) {
    const normalized = normalizeAvatarConfig(config);
    return renderAxiFaceMarkup(normalized);
}
