import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import { startRouterWebSocketAuthorityProxy } from '../lib/router-websocket-authority-proxy.mjs';

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: 0 }, () => {
            server.off('error', reject);
            resolve(server.address());
        });
    });
}

test('WebSocket authority proxy forwards only LiveKit signaling and applies Router authority', async (t) => {
    let received = '';
    const upstream = net.createServer((socket) => {
        socket.once('data', (chunk) => {
            received = chunk.toString('latin1');
            socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        });
    });
    const address = await listen(upstream);
    t.after(() => new Promise((resolve) => upstream.close(resolve)));

    const proxy = await startRouterWebSocketAuthorityProxy({
        environment: {
            PLOINKY_ROUTER_URL: `http://127.0.0.1:${address.port}`,
            PLOINKY_ROUTER_REQUEST_AUTHORITY: '127.0.0.1:8080',
            PLOINKY_ENV_SOURCE_PLOINKY_ROUTER_URL: 'generated',
            PLOINKY_ENV_SOURCE_PLOINKY_ROUTER_REQUEST_AUTHORITY: 'generated',
        },
    });
    t.after(() => proxy.close());

    const proxyUrl = new URL(proxy.livekitUrl);
    const response = await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });
        socket.once('error', reject);
        socket.once('data', (chunk) => resolve(chunk.toString('latin1')));
        socket.once('connect', () => socket.write(
            `GET ${proxyUrl.pathname}/rtc?room=test HTTP/1.1\r\nHost: relay.invalid\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nAuthorization: Bearer livekit-token\r\n\r\n`,
        ));
    });

    assert.match(response, /^HTTP\/1\.1 101/);
    assert.match(received, /^GET \/base-agent-additional-server\/liveKitServerAgent\/7880\/rtc\?room=test HTTP\/1\.1/);
    assert.doesNotMatch(received, /7880\/\/rtc/);
    assert.match(received, /\r\nHost: 127\.0\.0\.1:8080\r\n/);
    assert.match(received, /\r\nAuthorization: Bearer livekit-token\r\n/);
    assert.doesNotMatch(received, /relay\.invalid/);
});
