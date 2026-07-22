import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { _test as edgeRuntimeTest, resolveEdgeJoinMaterial } from '../../lib/runtime/edgeRuntime.mjs';
import { buildRtcConfig } from '../../lib/store/rtcConfig.mjs';
import { buildRtcConfigForSession } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/rtc-config.js';

describe('external TURN runtime contract', () => {
    test('requires complete short-lived external TURN credentials', () => {
        assert.deepEqual(buildRtcConfig({
            urls: ['turn:turn.example:3478?transport=udp', 'turns:turn.example:5349?transport=tcp'],
            username: 'expiring-user',
            password: 'secret',
        }), {
            iceTransportPolicy: 'all',
            iceServers: [{
                urls: ['turn:turn.example:3478?transport=udp', 'turns:turn.example:5349?transport=tcp'],
                username: 'expiring-user',
                credential: 'secret',
            }],
        });
        assert.throws(() => buildRtcConfig({ urls: ['turn:turn.example:3478'], username: '', password: 'x' }), /required/i);
        assert.throws(() => buildRtcConfig({ urls: ['stun:stun.example:3478'], username: 'u', password: 'x' }), /required/i);
    });

    test('topology requires an exact external TURN broker contract', () => {
        assert.deepEqual(edgeRuntimeTest.validateTurnTopology({
            media: { turn: {
                urls: ['turn:turn.example:3478?transport=udp', 'turns:turn.example:5349?transport=tcp'],
                credentialMode: 'turn-rest',
                credentialPath: '/private/media/turn-credentials',
            } },
        }), {
            urls: ['turn:turn.example:3478?transport=udp', 'turns:turn.example:5349?transport=tcp'],
            credentialPath: '/private/media/turn-credentials',
        });
        assert.throws(() => edgeRuntimeTest.validateTurnTopology({ media: { turn: { urls: [], credentialMode: 'turn-rest' } } }), /external TURN/i);
        assert.throws(() => edgeRuntimeTest.validateTurnTopology({ media: { turn: { urls: ['turn:x'], credentialMode: 'static', credentialPath: '/x' } } }), /turn-rest/i);
    });

    test('broker credentials must be current and a subset of committed topology URLs', () => {
        const now = Date.parse('2026-07-15T12:00:00.000Z');
        const result = edgeRuntimeTest.validateCredentialResponse({
            urls: ['turns:turn.example:5349?transport=tcp'],
            username: 'temporary',
            password: 'secret',
            expiresAt: '2026-07-15T12:10:00.000Z',
        }, ['turn:turn.example:3478?transport=udp', 'turns:turn.example:5349?transport=tcp'], now);
        assert.equal(result.username, 'temporary');
        assert.throws(() => edgeRuntimeTest.validateCredentialResponse({
            urls: ['turn:evil.example:3478'], username: 'u', password: 'p', expiresAt: '2026-07-15T12:10:00.000Z',
        }, ['turn:turn.example:3478'], now), /outside the current topology/i);
        assert.throws(() => edgeRuntimeTest.validateCredentialResponse({
            urls: ['turn:turn.example:3478'], username: 'u', password: 'p', expiresAt: '2026-07-15T12:00:10.000Z',
        }, ['turn:turn.example:3478'], now), /expired|short-lived/i);
    });

    test('signal URL is derived only from the active Router service', () => {
        assert.equal(edgeRuntimeTest.normalizeSignalUrl({
            activeBrowserUrl: 'https://meet.example/',
            routerPath: '/public-services/livekit-signal/',
        }), 'wss://meet.example/public-services/livekit-signal/');
        assert.throws(() => edgeRuntimeTest.normalizeSignalUrl({ activeBrowserUrl: 'file:///tmp/a', routerPath: '/' }), /must use ws/i);
    });

    test('join material can be supplied through the explicit unit seam without environment fallback', async () => {
        const material = { livekitUrl: 'wss://meet.example/livekit', rtcConfig: { iceServers: [] } };
        assert.equal(await resolveEdgeJoinMaterial({
            async resolveEdgeJoinMaterial(input) {
                assert.deepEqual(input, { roomName: 'room-1', participantIdentity: 'user-1' });
                return material;
            },
        }, { roomName: 'room-1', participantIdentity: 'user-1' }), material);
    });
});

describe('browser RTC normalization', () => {
    test('drops empty entries and deduplicates identical credential bindings', () => {
        assert.deepEqual(buildRtcConfigForSession({ rtcConfig: {
            iceServers: [
                { urls: [] },
                { urls: 'turn:turn.example:3478', username: 'u', credential: 'p' },
                { urls: 'turn:turn.example:3478', username: 'u', credential: 'p' },
            ],
            iceTransportPolicy: 'all',
        } }), {
            iceServers: [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'p' }],
            iceTransportPolicy: 'all',
        });
    });

    test('preserves credential-distinct TURN generations until controlled reconnect', () => {
        assert.deepEqual(buildRtcConfigForSession({ rtcConfig: { iceServers: [
            { urls: 'turn:turn.example:3478', username: 'old', credential: 'oldpass' },
            { urls: 'turn:turn.example:3478', username: 'new', credential: 'newpass' },
        ] } }).iceServers, [
            { urls: 'turn:turn.example:3478', username: 'old', credential: 'oldpass' },
            { urls: 'turn:turn.example:3478', username: 'new', credential: 'newpass' },
        ]);
    });

    test('returns undefined for absent RTC material and drops invalid policy', () => {
        assert.equal(buildRtcConfigForSession({}), undefined);
        assert.equal(buildRtcConfigForSession({ rtcConfig: null }), undefined);
        assert.equal(buildRtcConfigForSession({ rtcConfig: {
            iceServers: [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'p' }],
            iceTransportPolicy: 'bogus',
        } }).iceTransportPolicy, undefined);
    });
});
