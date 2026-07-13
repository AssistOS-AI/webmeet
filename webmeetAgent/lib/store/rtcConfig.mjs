export function normalizeIceTransportPolicy(value) {
    const iceTransportPolicy = String(value ?? '').trim();
    if (iceTransportPolicy !== 'all' && iceTransportPolicy !== 'relay') {
        throw new Error('WEBMEET_ICE_TRANSPORT_POLICY must be exactly "all" or "relay".');
    }
    return iceTransportPolicy;
}

export function buildRtcConfig(context) {
    const iceTransportPolicy = normalizeIceTransportPolicy(context?.iceTransportPolicy);
    if (iceTransportPolicy === 'relay') {
        return { iceTransportPolicy: 'relay' };
    }
    return null;
}
