import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    _buildRtcConfig as buildRtcConfig,
    _buildStunUrls as buildStunUrls,
    _isLoopbackUrl as isLoopbackUrl,
    _dedupeStrings as dedupeStrings,
    _splitCsvEnv as splitCsvEnv,
} from '../../lib/webmeetStore.mjs';

import {
    buildRtcConfigForSession,
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/services/rtc-config.js';

function countIceUrls(config) {
    if (!config?.iceServers) return 0;
    return config.iceServers.reduce((sum, server) => {
        const urls = server?.urls;
        if (Array.isArray(urls)) return sum + urls.length;
        return sum + (urls ? 1 : 0);
    }, 0);
}

describe('isLoopbackUrl', () => {
    test('detects 127.0.0.1 ws URL', () => {
        assert.equal(isLoopbackUrl('ws://127.0.0.1:7880'), true);
    });

    test('detects localhost wss URL', () => {
        assert.equal(isLoopbackUrl('wss://localhost:7880'), true);
    });

    test('detects [::1] URL', () => {
        assert.equal(isLoopbackUrl('ws://[::1]:7880'), true);
    });

    test('rejects public hostname', () => {
        assert.equal(isLoopbackUrl('wss://livekit-skills.axiologic.dev'), false);
    });

    test('handles empty string', () => {
        assert.equal(isLoopbackUrl(''), false);
    });
});

describe('dedupeStrings', () => {
    test('removes duplicates preserving order', () => {
        assert.deepEqual(dedupeStrings(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'c']);
    });

    test('returns empty for empty input', () => {
        assert.deepEqual(dedupeStrings([]), []);
    });
});

describe('splitCsvEnv', () => {
    test('splits comma-separated values', () => {
        assert.deepEqual(splitCsvEnv('a, b , c'), ['a', 'b', 'c']);
    });

    test('drops empty entries', () => {
        assert.deepEqual(splitCsvEnv('a,,b, ,c'), ['a', 'b', 'c']);
    });

    test('returns empty for empty string', () => {
        assert.deepEqual(splitCsvEnv(''), []);
    });
});

describe('buildStunUrls', () => {
    test('returns one default STUN URL for non-loopback public URL', () => {
        const urls = buildStunUrls({
            livekitPublicUrl: 'wss://livekit-skills.axiologic.dev',
        });
        assert.equal(urls.length, 1);
        assert.ok(urls[0].startsWith('stun:'));
    });

    test('returns no STUN for loopback public URL when not explicitly set', () => {
        const urls = buildStunUrls({
            livekitPublicUrl: 'ws://127.0.0.1:7880',
        });
        assert.equal(urls.length, 0);
    });

    test('honors explicit WEBMEET_STUN_URLS on loopback', () => {
        const urls = buildStunUrls({
            livekitPublicUrl: 'ws://127.0.0.1:7880',
            stunExplicitUrls: 'stun:custom.example.com:3478',
        });
        assert.deepEqual(urls, ['stun:custom.example.com:3478']);
    });

    test('empty explicit STUN list disables STUN', () => {
        const urls = buildStunUrls({
            livekitPublicUrl: 'wss://livekit-skills.axiologic.dev',
            stunExplicitUrls: '',
        });
        assert.equal(urls.length, 0);
    });

    test('deduplicates explicit STUN URLs', () => {
        const urls = buildStunUrls({
            livekitPublicUrl: 'wss://example.com',
            stunExplicitUrls: 'stun:a.com:3478, stun:a.com:3478, stun:b.com:3478',
        });
        assert.deepEqual(urls, ['stun:a.com:3478', 'stun:b.com:3478']);
    });
});

describe('buildRtcConfig (server-side)', () => {
    test('production default has at most three ICE URLs', () => {
        const config = buildRtcConfig({
            livekitPublicUrl: 'wss://livekit-skills.axiologic.dev',
            turn: {
                host: 'livekit-skills.axiologic.dev',
                port: '3478',
                username: 'webmeet',
                credential: 'secret',
                iceTransportPolicy: 'all',
            },
        });
        assert.ok(config);
        const total = countIceUrls(config);
        assert.ok(total <= 3, `Expected at most 3 ICE URLs, got ${total}`);
        assert.ok(total < 5, `Firefox threshold: expected fewer than 5 ICE URLs, got ${total}`);
    });

    test('loopback omits implicit STUN but keeps generated TURN when configured', () => {
        const config = buildRtcConfig({
            livekitPublicUrl: 'ws://127.0.0.1:7880',
            turn: {
                host: '127.0.0.1',
                port: '3478',
                username: 'webmeet',
                credential: 'secret',
                iceTransportPolicy: 'all',
            },
        });
        assert.ok(config);
        assert.equal(countIceUrls(config), 2);
        assert.deepEqual(config.iceServers, [
            {
                urls: [
                    'turn:127.0.0.1:3478?transport=udp',
                    'turn:127.0.0.1:3478?transport=tcp',
                ],
                username: 'webmeet',
                credential: 'secret',
            },
        ]);
    });

    test('loopback honors explicit TURN URLs', () => {
        const config = buildRtcConfig({
            livekitPublicUrl: 'ws://127.0.0.1:7880',
            turn: {
                host: '127.0.0.1',
                port: '3478',
                explicitUrls: 'turn:127.0.0.1:3478?transport=udp',
                username: 'webmeet',
                credential: 'secret',
                iceTransportPolicy: 'all',
            },
        });
        assert.ok(config);
        assert.deepEqual(config.iceServers, [
            {
                urls: ['turn:127.0.0.1:3478?transport=udp'],
                username: 'webmeet',
                credential: 'secret',
            },
        ]);
    });

    test('loopback relay policy can use implicit TURN', () => {
        const config = buildRtcConfig({
            livekitPublicUrl: 'ws://127.0.0.1:7880',
            turn: {
                host: '127.0.0.1',
                port: '3478',
                username: 'webmeet',
                credential: 'secret',
                iceTransportPolicy: 'relay',
            },
        });
        assert.ok(config);
        assert.equal(config.iceTransportPolicy, 'relay');
        assert.deepEqual(config.iceServers[0].urls, [
            'turn:127.0.0.1:3478?transport=udp',
            'turn:127.0.0.1:3478?transport=tcp',
        ]);
    });

    test('TURN omitted when username missing', () => {
        const config = buildRtcConfig({
            livekitPublicUrl: 'wss://example.com',
            turn: {
                host: 'turn.example.com',
                port: '3478',
                username: '',
                credential: 'secret',
                iceTransportPolicy: 'all',
            },
        });
        assert.ok(config);
        assert.equal(config.iceServers.length, 1);
        const urls = [].concat(config.iceServers[0].urls);
        assert.ok(urls.every((u) => u.startsWith('stun:')));
    });

    test('TURN omitted when credential missing', () => {
        const config = buildRtcConfig({
            livekitPublicUrl: 'wss://example.com',
            turn: {
                host: 'turn.example.com',
                port: '3478',
                username: 'user',
                credential: '',
                iceTransportPolicy: 'all',
            },
        });
        assert.ok(config);
        assert.equal(config.iceServers.length, 1);
    });

    test('returns null when no useful ICE entries remain', () => {
        const config = buildRtcConfig({
            livekitPublicUrl: 'ws://127.0.0.1:7880',
            turn: {
                host: '',
                port: '',
                username: '',
                credential: '',
                iceTransportPolicy: 'all',
            },
        });
        assert.equal(config, null);
    });

    test('preserves iceTransportPolicy relay', () => {
        const config = buildRtcConfig({
            livekitPublicUrl: 'wss://example.com',
            turn: {
                host: 'turn.example.com',
                port: '3478',
                username: 'user',
                credential: 'pass',
                iceTransportPolicy: 'relay',
            },
        });
        assert.equal(config.iceTransportPolicy, 'relay');
    });

    test('unsupported iceTransportPolicy falls back to all', () => {
        const config = buildRtcConfig({
            livekitPublicUrl: 'wss://example.com',
            turn: {
                host: 'turn.example.com',
                port: '3478',
                username: 'user',
                credential: 'pass',
                iceTransportPolicy: 'bogus',
            },
        });
        assert.equal(config.iceTransportPolicy, 'all');
    });
});

describe('buildRtcConfigForSession (browser-side)', () => {
    test('drops empty server entries', () => {
        const result = buildRtcConfigForSession({
            rtcConfig: {
                iceServers: [
                    { urls: [] },
                    { urls: 'stun:stun.l.google.com:19302' },
                ],
                iceTransportPolicy: 'all',
            },
        });
        assert.ok(result);
        assert.equal(result.iceServers.length, 1);
    });

    test('deduplicates URLs across server entries', () => {
        const result = buildRtcConfigForSession({
            rtcConfig: {
                iceServers: [
                    { urls: ['stun:a.com:3478', 'stun:b.com:3478'] },
                    { urls: ['stun:a.com:3478', 'stun:c.com:3478'] },
                ],
            },
        });
        assert.ok(result);
        const allUrls = result.iceServers.flatMap((s) => [].concat(s.urls));
        assert.deepEqual(allUrls, ['stun:a.com:3478', 'stun:b.com:3478', 'stun:c.com:3478']);
    });

    test('preserves credential-distinct TURN entries with the same URL', () => {
        const result = buildRtcConfigForSession({
            rtcConfig: {
                iceServers: [
                    { urls: 'turn:turn.example.com:3478', username: 'old', credential: 'oldpass' },
                    { urls: 'turn:turn.example.com:3478', username: 'new', credential: 'newpass' },
                    { urls: 'turn:turn.example.com:3478', username: 'new', credential: 'newpass' },
                ],
            },
        });
        assert.ok(result);
        assert.deepEqual(result.iceServers, [
            { urls: 'turn:turn.example.com:3478', username: 'old', credential: 'oldpass' },
            { urls: 'turn:turn.example.com:3478', username: 'new', credential: 'newpass' },
        ]);
    });

    test('returns undefined for null rtcConfig', () => {
        assert.equal(buildRtcConfigForSession({}), undefined);
        assert.equal(buildRtcConfigForSession({ rtcConfig: null }), undefined);
    });

    test('preserves TURN credentials on correct entry', () => {
        const result = buildRtcConfigForSession({
            rtcConfig: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' },
                ],
            },
        });
        assert.ok(result);
        const turnEntry = result.iceServers.find((s) =>
            [].concat(s.urls).some((u) => u.startsWith('turn:'))
        );
        assert.ok(turnEntry);
        assert.equal(turnEntry.username, 'user');
        assert.equal(turnEntry.credential, 'pass');
        const stunEntry = result.iceServers.find((s) =>
            [].concat(s.urls).some((u) => u.startsWith('stun:'))
        );
        assert.ok(stunEntry);
        assert.equal(stunEntry.username, undefined);
    });

    test('rejects unsupported iceTransportPolicy', () => {
        const result = buildRtcConfigForSession({
            rtcConfig: {
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
                iceTransportPolicy: 'bogus',
            },
        });
        assert.ok(result);
        assert.equal(result.iceTransportPolicy, undefined);
    });
});
