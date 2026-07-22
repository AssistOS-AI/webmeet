export function buildRtcConfig(turnCredential = {}) {
    const urls = Array.isArray(turnCredential.urls)
        ? [...new Set(turnCredential.urls.map((value) => String(value || '').trim()).filter(Boolean))]
        : [];
    const username = String(turnCredential.username || '').trim();
    const credential = String(turnCredential.password || turnCredential.credential || '').trim();
    if (!urls.length || urls.some((url) => !/^turns?:/i.test(url)) || !username || !credential) {
        throw new Error('Complete short-lived external TURN credentials are required.');
    }
    return {
        iceTransportPolicy: 'all',
        iceServers: [{ urls, username, credential }],
    };
}
