import assert from 'node:assert/strict';
import test from 'node:test';

import { createMeetingSecretaryDispatch } from '../../lib/runtime/livekitRuntime.mjs';

test('meeting secretary dispatch uses the private AgentDispatchService route', async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = '';
    let requestBody = null;
    let routerAssertion = '';
    globalThis.fetch = async (url, options = {}) => {
        requestUrl = String(url || '');
        requestBody = JSON.parse(Buffer.from(options.body).toString('utf8'));
        routerAssertion = String(options?.headers?.['Ploinky-Agent-Assertion'] || '');
        return {
            ok: true,
            text: async () => '{"id":"dispatch-a"}',
        };
    };
    try {
        const result = await createMeetingSecretaryDispatch({
            livekitApiKey: 'test-key',
            livekitApiSecret: 'test-secret',
            resolvePrivateLiveKitCall: async ({ serviceName, methodName, body }) => {
                assert.equal(serviceName, 'AgentDispatchService');
                assert.equal(methodName, 'CreateDispatch');
                assert.deepEqual(JSON.parse(body.toString('utf8')), {
                    room: 'room-a',
                    agentName: 'webmeet-meeting-secretary',
                    metadata: '{"meetingId":"meeting-a"}',
                });
                return {
                    url: new URL('http://127.0.0.1:8081/base-agent-additional-server/liveKitServerAgent/7880/twirp/livekit.AgentDispatchService/CreateDispatch'),
                    assertion: 'test-private-router-assertion',
                };
            },
        }, 'room-a', { meetingId: 'meeting-a' });

        assert.equal(result.id, 'dispatch-a');
        assert.match(requestUrl, /\/twirp\/livekit\.AgentDispatchService\/CreateDispatch$/);
        assert.equal(routerAssertion, 'test-private-router-assertion');
        assert.equal(requestBody.room, 'room-a');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
