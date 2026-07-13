export function buildRtcConfigForSession(session) {
    const rawConfig = session?.rtcConfig;
    if (rawConfig === undefined || rawConfig === null) {
        return undefined;
    }
    if (typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
        throw new Error('Invalid WebMeet rtcConfig payload.');
    }
    const iceTransportPolicy = String(rawConfig.iceTransportPolicy || '').trim();
    if (iceTransportPolicy !== 'all' && iceTransportPolicy !== 'relay') {
        throw new Error('Invalid WebMeet iceTransportPolicy.');
    }
    return { iceTransportPolicy };
}
