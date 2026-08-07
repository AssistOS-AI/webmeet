import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    bindJobToLiveKitWorkerTransport,
    resolveLiveKitRouterTransport,
    resolveWorkerPort,
} from '../lib/runtime-config.mjs';

test('worker port uses the standard Ploinky PORT configuration', () => {
    assert.equal(resolveWorkerPort({ PORT: '7000' }), 7000);
});

test('worker port rejects missing, malformed, and out-of-range configuration', () => {
    for (const PORT of [undefined, '', '0', '8081x', '65536']) {
        assert.throws(() => resolveWorkerPort({ PORT }), /PORT must/);
    }
});

const generatedRouterEnvironment = {
    PLOINKY_ROUTER_URL: 'http://host.containers.internal:8080',
    PLOINKY_ROUTER_REQUEST_AUTHORITY: '127.0.0.1:8080',
    PLOINKY_ENV_SOURCE_PLOINKY_ROUTER_URL: 'generated',
    PLOINKY_ENV_SOURCE_PLOINKY_ROUTER_REQUEST_AUTHORITY: 'generated',
};

test('LiveKit signaling uses the runtime-generated Router transport contract', () => {
    const target = resolveLiveKitRouterTransport(generatedRouterEnvironment);
    assert.equal(target.routerUrl.href, 'http://host.containers.internal:8080/');
    assert.equal(target.requestAuthority, '127.0.0.1:8080');
    assert.equal(target.signalPath, '/base-agent-additional-server/liveKitServerAgent/7880/');
});

test('LiveKit signaling rejects non-generated or invalid Router transport values', () => {
    assert.throws(() => resolveLiveKitRouterTransport({}), /runtime-generated/);
    assert.throws(
        () => resolveLiveKitRouterTransport({ PLOINKY_ROUTER_URL: 'http://router' }),
        /runtime-generated/,
    );
    for (const PLOINKY_ROUTER_URL of [undefined, '', 'not-a-url', 'file:///tmp/router']) {
        assert.throws(
            () => resolveLiveKitRouterTransport({ ...generatedRouterEnvironment, PLOINKY_ROUTER_URL }),
            /PLOINKY_ROUTER_URL/,
        );
    }
});

test('LiveKit jobs use the exact loopback transport created for their process', () => {
    const context = { info: { url: 'ws://assignment.invalid/' } };
    const livekitUrl = 'ws://127.0.0.1:49152/base-agent-additional-server/liveKitServerAgent/7880/';
    assert.equal(bindJobToLiveKitWorkerTransport(context, { LIVEKIT_URL: livekitUrl }), livekitUrl);
    assert.equal(context.info.url, livekitUrl);
    for (const invalid of [
        'ws://host.containers.internal:8080/base-agent-additional-server/liveKitServerAgent/7880/',
        'ws://127.0.0.1:49152/rtc',
        'http://127.0.0.1:49152/base-agent-additional-server/liveKitServerAgent/7880/',
    ]) {
        assert.throws(
            () => bindJobToLiveKitWorkerTransport({ info: {} }, { LIVEKIT_URL: invalid }),
            /exact loopback/,
        );
    }
});

test('manifest shares the canonical LiveKit credentials in every profile', () => {
    const manifestUrl = new URL('../manifest.json', import.meta.url);
    const manifest = JSON.parse(fs.readFileSync(fileURLToPath(manifestUrl), 'utf8'));
    for (const profile of Object.values(manifest.profiles)) {
        const names = profile.env.map((entry) => typeof entry === 'string' ? entry : entry.name);
        assert.ok(names.includes('LIVEKIT_API_KEY'));
        assert.ok(names.includes('LIVEKIT_API_SECRET'));
        assert.ok(!names.includes('WEBMEET_LIVEKIT_API_KEY'));
        assert.ok(!names.includes('WEBMEET_LIVEKIT_API_SECRET'));
        assert.ok(!names.includes('WEBMEET_LIVEKIT_AGENT_URL'));
        assert.ok(!names.includes('SOUL_GATEWAY_URL'));
    }
    assert.notEqual(manifest.network?.mode, 'host');
});
