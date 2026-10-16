function flattenUrls(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => String(entry || '').trim()).filter(Boolean);
    }
    const text = String(value || '').trim();
    return text ? [text] : [];
}

function dedupeKeyForIceUrl(url, username, credential) {
    const normalizedUrl = String(url || '').trim();
    const lowerUrl = normalizedUrl.toLowerCase();
    if (lowerUrl.startsWith('turn:') || lowerUrl.startsWith('turns:')) {
        return `turn:${normalizedUrl}\n${username}\n${credential}`;
    }
    return `url:${normalizedUrl}`;
}

function normalizeIceServer(server, seen) {
    if (!server || typeof server !== 'object') {
        return null;
    }
    const rawUrls = flattenUrls(server.urls);
    const username = String(server.username || '').trim();
    const credential = String(server.credential || '').trim();
    const urls = [];
    for (const url of rawUrls) {
        const key = dedupeKeyForIceUrl(url, username, credential);
        if (!seen.has(key)) {
            seen.add(key);
            urls.push(url);
        }
    }
    if (!urls.length) {
        return null;
    }
    const next = { urls: urls.length === 1 ? urls[0] : urls };
    if (username) {
        next.username = username;
    }
    if (credential) {
        next.credential = credential;
    }
    return next;
}

export function buildRtcConfigForSession(session) {
    const rawConfig = session?.rtcConfig;
    if (!rawConfig || typeof rawConfig !== 'object') {
        return undefined;
    }
    const seen = new Set();
    const iceServers = Array.isArray(rawConfig.iceServers)
        ? rawConfig.iceServers.map((server) => normalizeIceServer(server, seen)).filter(Boolean)
        : [];
    if (!iceServers.length) {
        return undefined;
    }
    const config = { iceServers };
    const iceTransportPolicy = String(rawConfig.iceTransportPolicy || '').trim();
    if (iceTransportPolicy === 'all' || iceTransportPolicy === 'relay') {
        config.iceTransportPolicy = iceTransportPolicy;
    }
    return config;
}

export function installRtcPeerConnectionOverride(_session) {
    return null;
}
