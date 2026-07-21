import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveLiveKitSignalingUrl } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room-livekit.js';

test('LiveKit signaling uses the authenticated Ploinky agent-port locator', async () => {
    const calls = [];
    const url = await resolveLiveKitSignalingUrl({
        livekitLocator: { agent: 'liveKitServerAgent', port: 7880 },
    }, {
        location: { origin: 'https://explorer.example.test' },
        fetchImpl: async (requestUrl, options) => {
            calls.push({ requestUrl, options });
            return {
                ok: true,
                async json() {
                    return {
                        url: 'http://127.0.0.1:8080/base-agent-additional-server/liveKitServerAgent/7880/',
                        generationDigest: 'generation',
                    };
                },
            };
        },
    });

    assert.equal(
        url,
        'wss://explorer.example.test/base-agent-additional-server/liveKitServerAgent/7880/'
    );
    assert.equal(
        calls[0].requestUrl,
        '/api/agent-port-locator?agent=liveKitServerAgent&port=7880'
    );
    assert.equal(calls[0].options.credentials, 'include');
    assert.equal(calls[0].options.cache, 'no-store');
});

test('LiveKit signaling has no direct-port fallback when locator resolution fails', async () => {
    await assert.rejects(
        () => resolveLiveKitSignalingUrl({
            livekitLocator: { agent: 'liveKitServerAgent', port: 7880 },
        }, {
            location: { origin: 'http://127.0.0.1:8080' },
            fetchImpl: async () => ({
                ok: false,
                async json() { return { error: 'locator_unavailable' }; },
            }),
        }),
        /locator is unavailable/i
    );
});
