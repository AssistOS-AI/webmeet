function nowIso() {
    return new Date().toISOString();
}

function sanitizeAvatarText(value, maxLength = 256) {
    return String(value ?? '').trim().slice(0, maxLength);
}

function sanitizeAvatarBoolean(value) {
    return value === true;
}

const AVATAR_ALLOWED_EMOTIONS = new Set([
    'neutral',
    'idle',
    'listening',
    'thinking',
    'speaking',
    'happy',
    'amused',
    'confused',
    'concerned',
    'alert',
    'sleepy'
]);
const AVATAR_ALLOWED_THOUGHT_MODES = new Set(['none', 'bubble', 'caption', 'ticker', 'inside']);
const AVATAR_ALLOWED_MODES = new Set(['static', 'controlled', 'event-driven', 'autonomous']);
const AVATAR_ALLOWED_SHAPES = new Set(['circle', 'square', 'rounded', 'none']);
const AVATAR_ALLOWED_THEMES = new Set(['light', 'dark', 'auto']);
const AVATAR_ALLOWED_ASSET_MODES = new Set(['img', 'inline']);
const AVATAR_ALLOWED_STYLES = new Set(['robot-soft', 'robot-minimal', 'sketch', 'emoji', 'terminal']);
const AVATAR_ALLOWED_COMPLEXITIES = new Set(['', 'low', 'minimal', 'medium', 'default', 'high', 'detailed']);
const AVATAR_ALLOWED_SOURCE_MODES = new Set(['generated', 'pack', 'svg']);
const AVATAR_CONFIG_FIELDS = new Set([
    'agentId',
    'src',
    'packSrc',
    'pack_src',
    'sourceMode',
    'source_mode',
    'source-mode',
    'assetMode',
    'asset_mode',
    'emotion',
    'size',
    'thought',
    'thoughtMode',
    'thought_mode',
    'mode',
    'shape',
    'theme',
    'animated',
    'listen',
    'generated',
    'seed',
    'style',
    'axiStyle',
    'palette',
    'complexity'
]);

function sanitizeAvatarUrl(value, fieldName) {
    const raw = sanitizeAvatarText(value, 1024);
    if (!raw) return '';
    if (/[\u0000-\u001f]/.test(raw)) {
        throw new Error(`Invalid participant avatar ${fieldName}: contains control characters.`);
    }
    if (/^(javascript|data):/i.test(raw)) {
        throw new Error(`Invalid participant avatar ${fieldName}: unsafe URL scheme.`);
    }
    if (/^http:\/\//i.test(raw)) {
        throw new Error(`Invalid participant avatar ${fieldName}: absolute URLs must use HTTPS.`);
    }
    if (/^\/\//.test(raw)) {
        throw new Error(`Invalid participant avatar ${fieldName}: protocol-relative URLs are not allowed.`);
    }
    return raw;
}

function sanitizeAvatarEnum(value, allowed, fallback, fieldName) {
    const raw = sanitizeAvatarText(value, 64);
    if (!raw) return fallback;
    if (!allowed.has(raw)) {
        throw new Error(`Invalid participant avatar ${fieldName}: ${raw}`);
    }
    return raw;
}

function sanitizeAvatarSize(value) {
    const raw = sanitizeAvatarText(value || '72', 32);
    if (/^\d+(\.\d+)?$/.test(raw) || /^\d+(\.\d+)?(px|rem|em|vh|vw|vmin|vmax|%)$/.test(raw)) {
        return raw;
    }
    throw new Error(`Invalid participant avatar size: ${raw}`);
}

function sanitizeParticipantAvatarConfig(config = null, fallbackId = '') {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return null;
    }
    for (const key of Object.keys(config)) {
        if (!AVATAR_CONFIG_FIELDS.has(key)) {
            throw new Error(`Unknown participant avatar config field: ${key}`);
        }
    }
    const fallback = sanitizeAvatarText(fallbackId || 'profile:participant', 128);
    const source = config;
    const complexity = sanitizeAvatarText(source.complexity, 64);
    if (!AVATAR_ALLOWED_COMPLEXITIES.has(complexity) && !/^(0(\.\d+)?|1(\.0+)?)$/.test(complexity)) {
        throw new Error(`Invalid participant avatar complexity: ${complexity}`);
    }
    const normalized = {
        agentId: sanitizeAvatarText(source.agentId || fallback, 128),
        generated: source.generated !== false,
        src: sanitizeAvatarUrl(source.src, 'src'),
        packSrc: sanitizeAvatarUrl(source.packSrc || source.pack_src, 'packSrc'),
        sourceMode: sanitizeAvatarEnum(source.sourceMode || source.source_mode || source['source-mode'], AVATAR_ALLOWED_SOURCE_MODES, '', 'sourceMode'),
        assetMode: sanitizeAvatarEnum(source.assetMode || source.asset_mode, AVATAR_ALLOWED_ASSET_MODES, 'img', 'assetMode'),
        emotion: sanitizeAvatarEnum(source.emotion, AVATAR_ALLOWED_EMOTIONS, 'neutral', 'emotion'),
        size: sanitizeAvatarSize(source.size),
        thought: sanitizeAvatarText(source.thought, 256),
        thoughtMode: sanitizeAvatarEnum(source.thoughtMode || source.thought_mode, AVATAR_ALLOWED_THOUGHT_MODES, source.thought ? 'bubble' : 'none', 'thoughtMode'),
        mode: sanitizeAvatarEnum(source.mode, AVATAR_ALLOWED_MODES, 'static', 'mode'),
        shape: sanitizeAvatarEnum(source.shape, AVATAR_ALLOWED_SHAPES, 'circle', 'shape'),
        theme: sanitizeAvatarEnum(source.theme, AVATAR_ALLOWED_THEMES, 'auto', 'theme'),
        animated: source.animated !== false,
        listen: sanitizeAvatarBoolean(source.listen),
        seed: sanitizeAvatarText(source.seed || source.agentId || fallback, 128),
        style: sanitizeAvatarEnum(source.style || source.axiStyle, AVATAR_ALLOWED_STYLES, 'robot-soft', 'style'),
        palette: sanitizeAvatarText(source.palette || 'default', 64),
        complexity
    };
    if (normalized.src) {
        normalized.sourceMode = 'svg';
        normalized.generated = false;
        normalized.packSrc = '';
    } else if (normalized.packSrc) {
        normalized.sourceMode = 'pack';
        normalized.generated = false;
    } else {
        normalized.sourceMode = normalized.sourceMode || (normalized.generated === false ? 'pack' : 'generated');
        if (normalized.sourceMode === 'generated') {
            normalized.generated = true;
        }
    }
    return normalized;
}

function createDefaultParticipantAvatarConfig(fallbackId = '') {
    const fallback = sanitizeAvatarText(fallbackId || 'profile:participant', 128);
    return sanitizeParticipantAvatarConfig({
        agentId: fallback,
        seed: fallback,
        generated: true,
        assetMode: 'img',
        emotion: 'neutral',
        size: '72',
        thoughtMode: 'none',
        mode: 'static',
        shape: 'circle',
        theme: 'auto',
        animated: true,
        style: 'robot-soft',
        palette: 'default'
    }, fallback);
}

export function sanitizeParticipantAvatarPayload(avatar = null, fallbackId = '') {
    if (!avatar || typeof avatar !== 'object' || Array.isArray(avatar)) {
        return null;
    }
    const enabled = avatar.enabled !== false;
    const config = sanitizeParticipantAvatarConfig(avatar.config, fallbackId)
        || (enabled ? createDefaultParticipantAvatarConfig(fallbackId) : null);
    return {
        enabled,
        config,
        fallbackLetter: sanitizeAvatarText(avatar.fallbackLetter, 8),
        updatedAt: nowIso()
    };
}
