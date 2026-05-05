function normalizeUrls(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => String(entry || '').trim()).filter(Boolean);
    }
    const text = String(value || '').trim();
    return text ? text : '';
}

function normalizeIceServer(server) {
    if (!server || typeof server !== 'object') {
        return null;
    }
    const urls = normalizeUrls(server.urls);
    if (Array.isArray(urls) && !urls.length) {
        return null;
    }
    if (!urls) {
        return null;
    }
    const next = { urls };
    const username = String(server.username || '').trim();
    const credential = String(server.credential || '').trim();
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
    const iceServers = Array.isArray(rawConfig.iceServers)
        ? rawConfig.iceServers.map(normalizeIceServer).filter(Boolean)
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
