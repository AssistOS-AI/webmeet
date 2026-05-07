const MEDIA_DIAGNOSTIC_PREFIX = '[webmeet:media]';

function normalizeDebugFlag(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on', 'debug'].includes(normalized);
}

export function isMediaDiagnosticsEnabled() {
    try {
        if (globalThis.WEBMEET_MEDIA_DEBUG === true) return true;
        if (normalizeDebugFlag(globalThis.WEBMEET_MEDIA_DEBUG)) return true;
        if (normalizeDebugFlag(globalThis.localStorage?.getItem?.('WEBMEET_MEDIA_DEBUG'))) return true;
        const href = String(globalThis.location?.href || '');
        if (!href) return false;
        const url = new URL(href);
        if (normalizeDebugFlag(url.searchParams.get('webmeetMediaDebug'))) return true;
        return normalizeDebugFlag(url.hash.match(/webmeetMediaDebug=([^&]+)/)?.[1]);
    } catch (_) {
        return false;
    }
}

function safeString(value, maxLength = 160) {
    const text = String(value ?? '').trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}...`;
}

function summarizeTrackSettings(mediaStreamTrack) {
    try {
        const settings = mediaStreamTrack?.getSettings?.() || {};
        return {
            width: settings.width,
            height: settings.height,
            frameRate: settings.frameRate,
            deviceId: settings.deviceId ? '<redacted>' : undefined,
            displaySurface: settings.displaySurface
        };
    } catch (_) {
        return {};
    }
}

export function summarizeTrack(track) {
    const mediaStreamTrack = track?.mediaStreamTrack || track || null;
    if (!mediaStreamTrack) return null;
    return {
        sid: safeString(track?.sid || track?.trackSid || ''),
        kind: safeString(track?.kind || mediaStreamTrack.kind || ''),
        source: safeString(track?.source || ''),
        readyState: safeString(mediaStreamTrack.readyState || ''),
        muted: Boolean(mediaStreamTrack.muted),
        enabled: Boolean(mediaStreamTrack.enabled),
        settings: summarizeTrackSettings(mediaStreamTrack)
    };
}

export function summarizePublication(publication) {
    if (!publication) return null;
    return {
        sid: safeString(publication.trackSid || publication.sid || ''),
        name: safeString(publication.trackName || publication.name || ''),
        kind: safeString(publication.kind || publication.track?.kind || ''),
        source: safeString(publication.source || ''),
        isMuted: Boolean(publication.isMuted),
        isSubscribed: Boolean(publication.isSubscribed),
        hasTrack: Boolean(publication.track),
        track: summarizeTrack(publication.track)
    };
}

export function summarizeParticipant(participant) {
    if (!participant) return null;
    return {
        identity: safeString(participant.identity || ''),
        name: safeString(participant.name || ''),
        trackPublicationCount: Number(participant.trackPublications?.size || 0)
    };
}

export function summarizeVideoElement(videoElement) {
    if (!videoElement) return null;
    const tracks = [];
    try {
        for (const track of videoElement.srcObject?.getTracks?.() || []) {
            tracks.push(summarizeTrack(track));
        }
    } catch (_) {
        // ignore inaccessible media stream state
    }
    return {
        isConnected: Boolean(videoElement.isConnected),
        readyState: Number(videoElement.readyState || 0),
        paused: Boolean(videoElement.paused),
        ended: Boolean(videoElement.ended),
        currentTime: Number(videoElement.currentTime || 0),
        videoWidth: Number(videoElement.videoWidth || 0),
        videoHeight: Number(videoElement.videoHeight || 0),
        muted: Boolean(videoElement.muted),
        srcObjectTrackCount: tracks.length,
        tracks
    };
}

function redactSensitive(value) {
    if (Array.isArray(value)) {
        return value.map((item) => redactSensitive(item));
    }
    if (!value || typeof value !== 'object') {
        return value;
    }
    const output = {};
    for (const [key, item] of Object.entries(value)) {
        const normalizedKey = key.toLowerCase();
        if (
            normalizedKey.includes('token')
            || normalizedKey.includes('secret')
            || normalizedKey.includes('password')
            || normalizedKey.includes('authorization')
            || normalizedKey.includes('credential')
            || normalizedKey === 'sdp'
            || normalizedKey === 'candidate'
        ) {
            output[key] = '<redacted>';
            continue;
        }
        output[key] = redactSensitive(item);
    }
    return output;
}

export function logMediaDiagnostic(event, payload = {}) {
    if (!isMediaDiagnosticsEnabled()) return;
    try {
        const consoleRef = globalThis.console || null;
        const logger = typeof consoleRef?.info === 'function' ? consoleRef.info : consoleRef?.log;
        if (typeof logger !== 'function') return;
        logger.call(consoleRef, MEDIA_DIAGNOSTIC_PREFIX, event, redactSensitive(payload));
    } catch (_) {
        // diagnostics must not affect meeting behavior
    }
}
