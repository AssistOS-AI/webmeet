export function buildRtcConfigForSession(session) {
    const livekitUrl = String(session?.livekitUrl || '').trim();
    if (!livekitUrl) return undefined;
    let parsed;
    try {
        parsed = new URL(livekitUrl);
    } catch {
        return undefined;
    }
    const hostname = String(parsed.hostname || '').trim().toLowerCase();
    if (!hostname || !['127.0.0.1', 'localhost'].includes(hostname)) {
        return undefined;
    }
    return {
        iceTransportPolicy: 'relay',
        iceServers: [
            { urls: ['stun:127.0.0.1:13478'] },
            {
                urls: [
                    'turn:127.0.0.1:13478?transport=udp',
                    'turn:127.0.0.1:13478?transport=tcp'
                ],
                username: 'webmeet',
                credential: 'webmeet'
            }
        ]
    };
}

export function installRtcPeerConnectionOverride(session) {
    const forcedConfig = buildRtcConfigForSession(session);
    if (!forcedConfig || typeof window === 'undefined' || typeof window.RTCPeerConnection !== 'function') {
        return null;
    }

    const NativePeerConnection = window.RTCPeerConnection;
    if (NativePeerConnection.__webmeetForcedRelay) {
        return null;
    }

    const ForcedPeerConnection = function(configuration = {}, ...rest) {
        const mergedConfiguration = {
            ...(configuration || {}),
            iceTransportPolicy: forcedConfig.iceTransportPolicy,
            iceServers: forcedConfig.iceServers
        };
        console.debug('[webmeet] forcing RTCPeerConnection config', {
            originalConfiguration: configuration || {},
            mergedConfiguration
        });
        return new NativePeerConnection(mergedConfiguration, ...rest);
    };

    ForcedPeerConnection.prototype = NativePeerConnection.prototype;
    Object.setPrototypeOf(ForcedPeerConnection, NativePeerConnection);
    ForcedPeerConnection.__webmeetForcedRelay = true;

    window.RTCPeerConnection = ForcedPeerConnection;
    console.debug('[webmeet] installed RTCPeerConnection relay override', forcedConfig);
    return () => {
        if (window.RTCPeerConnection === ForcedPeerConnection) {
            window.RTCPeerConnection = NativePeerConnection;
            console.debug('[webmeet] restored native RTCPeerConnection');
        }
    };
}
