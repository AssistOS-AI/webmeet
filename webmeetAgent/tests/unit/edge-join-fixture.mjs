export function installEdgeJoinFixture(context) {
    context.livekitApiKey = context.livekitApiKey || 'unit-test-livekit-key';
    context.livekitApiSecret = context.livekitApiSecret || 'unit-test-livekit-secret-32-bytes';
    context.resolveEdgeJoinMaterial = async ({ roomName, participantIdentity }) => ({
        livekitUrl: 'wss://router.test/base-agent-additional-server/liveKitServerAgent/7880/',
        rtcConfig: {
            iceTransportPolicy: 'all',
            iceServers: [{
                urls: ['turn:turn.test:3478?transport=udp'],
                username: `unit-${participantIdentity}`,
                credential: `unit-${roomName}`,
            }],
        },
        turnExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        configurationGeneration: 'unit-test-generation',
        publicationGeneration: 1,
    });
    return context;
}
