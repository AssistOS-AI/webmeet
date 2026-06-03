const DEFAULT_STUN_URL = 'stun:stun.l.google.com:19302';
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function splitCsvEnv(value) {
    return String(value || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function normalizeTurnHost(value) {
    return String(value || '')
        .trim()
        .replace(/^turns?:\/\//i, '')
        .replace(/^turns?:/i, '')
        .replace(/\?.*$/u, '')
        .replace(/\/+$/u, '');
}

function isLoopbackHostname(hostname) {
    const normalized = String(hostname || '').trim().toLowerCase();
    return LOOPBACK_HOSTNAMES.has(normalized);
}

export function isLoopbackUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return false;
    try {
        const url = new URL(raw.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:'));
        return isLoopbackHostname(url.hostname);
    } catch {
        return false;
    }
}

export function dedupeStrings(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        if (!seen.has(value)) {
            seen.add(value);
            result.push(value);
        }
    }
    return result;
}

export function buildStunUrls(context) {
    const explicitRaw = context.stunExplicitUrls;
    if (explicitRaw !== undefined) {
        return dedupeStrings(splitCsvEnv(explicitRaw));
    }
    if (isLoopbackUrl(context.livekitPublicUrl)) {
        return [];
    }
    return [DEFAULT_STUN_URL];
}

function buildTurnUrls({ host, port, explicitUrls }) {
    const urls = splitCsvEnv(explicitUrls);
    if (urls.length) {
        return dedupeStrings(urls);
    }
    const normalizedHost = normalizeTurnHost(host);
    if (!normalizedHost) {
        return [];
    }
    const safePort = String(port || '3478').trim() || '3478';
    const hostWithPort = /:\d+$/u.test(normalizedHost) ? normalizedHost : `${normalizedHost}:${safePort}`;
    return [
        `turn:${hostWithPort}?transport=udp`,
        `turn:${hostWithPort}?transport=tcp`
    ];
}

export function buildRtcConfig(context) {
    const turn = context.turn || {};
    const username = String(turn.username || '').trim();
    const credential = String(turn.credential || '').trim();
    const iceTransportPolicy = String(turn.iceTransportPolicy || '').trim();
    const turnUrls = buildTurnUrls(turn);
    const stunUrls = buildStunUrls(context);

    const iceServers = [];
    if (stunUrls.length) {
        iceServers.push({ urls: stunUrls });
    }
    if (username && credential && turnUrls.length) {
        iceServers.push({ urls: turnUrls, username, credential });
    }
    if (!iceServers.length) {
        return null;
    }
    return {
        iceTransportPolicy: iceTransportPolicy === 'relay' ? 'relay' : 'all',
        iceServers,
    };
}
