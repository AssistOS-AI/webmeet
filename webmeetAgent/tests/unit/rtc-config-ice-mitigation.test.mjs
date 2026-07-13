import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import {
    _buildRtcConfig as buildRtcConfig,
} from '../../lib/webmeetStore.mjs';

import {
    buildRtcConfigForSession,
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/rtc-config.js';

// This suite locks down the network-hardening contract: webmeetAgent must never
// hand the browser a TURN URL, TURN username, or TURN credential. The only ICE
// signal it may ever convey is an explicit iceTransportPolicy ('relay'), and only
// when the operator has requested it. Invalid policy input fails closed. Everything else (STUN URLs, TURN URLs,
// usernames, credentials) must be structurally absent from both the server-side
// builder's output and the browser-side normalizer's output.

const MASTER_KEY = crypto.randomBytes(32).toString('base64');
const ADMIN_AUTH = { id: 'local:admin', username: 'admin', roles: ['admin'] };
const tmpDirs = [];

async function freshContext(envOverrides = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-rtc-test-'));
    await fs.mkdir(path.join(dir, '.ploinky'), { recursive: true });
    tmpDirs.push(dir);

    process.env.PLOINKY_WEBMEET_MASTER_KEY = MASTER_KEY;
    process.env.PLOINKY_WORKSPACE_ROOT = dir;
    process.env.WEBMEET_ICE_TRANSPORT_POLICY = 'all';
    for (const [key, value] of Object.entries(envOverrides)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    const { createStoreContext } = await import('../../lib/webmeetStore.mjs');
    return await createStoreContext(dir);
}

after(async () => {
    delete process.env.WEBMEET_ICE_TRANSPORT_POLICY;
    delete process.env.WEBMEET_PUBLIC_LIVEKIT_URL;
    delete process.env.WEBMEET_LIVEKIT_URL;
    delete process.env.WEBMEET_STUN_URLS;
    delete process.env.WEBMEET_TURN_HOST;
    delete process.env.WEBMEET_TURN_URLS;
    await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
});

describe('buildRtcConfig (server-side)', () => {
    test('rejects a missing ICE transport policy', () => {
        assert.throws(
            () => buildRtcConfig({ livekitPublicUrl: 'wss://meet.example.com' }),
            /must be exactly "all" or "relay"/
        );
    });

    test('returns null for the default "all" policy', () => {
        const config = buildRtcConfig({
            livekitPublicUrl: 'wss://meet.example.com',
            iceTransportPolicy: 'all',
        });
        assert.equal(config, null);
    });

    test('rejects an unsupported/bogus policy value', () => {
        assert.throws(
            () => buildRtcConfig({
                livekitPublicUrl: 'wss://example.com',
                iceTransportPolicy: 'bogus',
            }),
            /must be exactly "all" or "relay"/
        );
    });

    test('returns exactly { iceTransportPolicy: "relay" } when relay is requested', () => {
        const config = buildRtcConfig({
            livekitPublicUrl: 'wss://example.com',
            iceTransportPolicy: 'relay',
        });
        assert.deepEqual(config, { iceTransportPolicy: 'relay' });
        assert.deepEqual(Object.keys(config), ['iceTransportPolicy']);
    });

    test('never returns iceServers, TURN URLs, usernames, or credentials even if legacy turn fields are present', () => {
        // Defense in depth: even if a stale/leftover context still carries the
        // old host/port/username/credential shape (e.g. from an un-migrated
        // workspace secret store), buildRtcConfig must not resurrect them.
        const config = buildRtcConfig({
            livekitPublicUrl: 'wss://example.com',
            iceTransportPolicy: 'relay',
            turn: {
                host: 'turn.example.com',
                port: '3478',
                explicitUrls: 'turn:turn.example.com:3478?transport=udp',
                username: 'webmeet',
                credential: 'super-secret-password',
            },
        });
        assert.ok(config);
        assert.deepEqual(config, { iceTransportPolicy: 'relay' });
        assert.equal('iceServers' in config, false);
        assert.equal(JSON.stringify(config).includes('super-secret-password'), false);
        assert.equal(JSON.stringify(config).includes('turn:'), false);
    });
});

describe('buildRtcConfigForSession (browser-side)', () => {
    test('returns undefined when rtcConfig is absent', () => {
        assert.equal(buildRtcConfigForSession({}), undefined);
    });

    test('returns undefined when rtcConfig is null', () => {
        assert.equal(buildRtcConfigForSession({ rtcConfig: null }), undefined);
    });

    test('rejects a present rtcConfig without iceTransportPolicy', () => {
        assert.throws(() => buildRtcConfigForSession({ rtcConfig: {} }), /Invalid WebMeet iceTransportPolicy/);
    });

    test('rejects an unsupported iceTransportPolicy value', () => {
        assert.throws(
            () => buildRtcConfigForSession({ rtcConfig: { iceTransportPolicy: 'bogus' } }),
            /Invalid WebMeet iceTransportPolicy/
        );
    });

    test('rejects a non-object rtcConfig payload', () => {
        assert.throws(() => buildRtcConfigForSession({ rtcConfig: [] }), /Invalid WebMeet rtcConfig payload/);
    });

    test('returns exactly { iceTransportPolicy: "relay" } when relay is requested', () => {
        const result = buildRtcConfigForSession({ rtcConfig: { iceTransportPolicy: 'relay' } });
        assert.deepEqual(result, { iceTransportPolicy: 'relay' });
        assert.deepEqual(Object.keys(result), ['iceTransportPolicy']);
    });

    test('returns exactly { iceTransportPolicy: "all" } when all is requested', () => {
        const result = buildRtcConfigForSession({ rtcConfig: { iceTransportPolicy: 'all' } });
        assert.deepEqual(result, { iceTransportPolicy: 'all' });
    });

    test('never forwards iceServers even if the raw session legacy-includes TURN credentials', () => {
        // Defense in depth: even if a server response somehow still carried the
        // old iceServers/TURN shape, the browser-side normalizer must not forward
        // usernames/credentials/URLs from it.
        const result = buildRtcConfigForSession({
            rtcConfig: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'leaked-secret' },
                ],
                iceTransportPolicy: 'relay',
            },
        });
        assert.ok(result);
        assert.deepEqual(result, { iceTransportPolicy: 'relay' });
        assert.equal('iceServers' in result, false);
        assert.equal(JSON.stringify(result).includes('leaked-secret'), false);
    });
});

describe('join flows never leak TURN materials in rtcConfig', () => {
    test('joinGuestMeeting omits rtcConfig when no relay policy is requested', async () => {
        const context = await freshContext();
        const { createMeeting, joinGuestMeeting } = await import('../../lib/webmeetStore.mjs');
        const meeting = await createMeeting(context, { title: 'Guest Room', roomType: 'guest', authInfo: ADMIN_AUTH });
        const result = await joinGuestMeeting(context, { meetingId: meeting.id, displayName: 'Guest' });
        assert.equal('rtcConfig' in result, false);
    });

    test('joinGuestMeeting response contains only iceTransportPolicy when relay is requested', async () => {
        const context = await freshContext({ WEBMEET_ICE_TRANSPORT_POLICY: 'relay' });
        const { createMeeting, joinGuestMeeting } = await import('../../lib/webmeetStore.mjs');
        const meeting = await createMeeting(context, { title: 'Guest Room', roomType: 'guest', authInfo: ADMIN_AUTH });
        const result = await joinGuestMeeting(context, { meetingId: meeting.id, displayName: 'Guest' });
        assert.deepEqual(result.rtcConfig, { iceTransportPolicy: 'relay' });
        assert.equal(JSON.stringify(result).includes('iceServers'), false);
    });

    test('joinMeeting (authenticated) omits rtcConfig when no relay policy is requested', async () => {
        const context = await freshContext();
        const { createMeeting, joinMeeting } = await import('../../lib/webmeetStore.mjs');
        const meeting = await createMeeting(context, { title: 'Team Room', roomType: 'team', authInfo: ADMIN_AUTH });
        const result = await joinMeeting(context, {
            meetingId: meeting.id,
            displayName: 'Admin',
            participantId: 'participant-admin',
            authInfo: ADMIN_AUTH,
        });
        assert.equal('rtcConfig' in result, false);
    });

    test('joinMeeting (authenticated) response contains only iceTransportPolicy when relay is requested', async () => {
        const context = await freshContext({ WEBMEET_ICE_TRANSPORT_POLICY: 'relay' });
        const { createMeeting, joinMeeting } = await import('../../lib/webmeetStore.mjs');
        const meeting = await createMeeting(context, { title: 'Team Room', roomType: 'team', authInfo: ADMIN_AUTH });
        const result = await joinMeeting(context, {
            meetingId: meeting.id,
            displayName: 'Admin',
            participantId: 'participant-admin',
            authInfo: ADMIN_AUTH,
        });
        assert.deepEqual(result.rtcConfig, { iceTransportPolicy: 'relay' });
        assert.equal(JSON.stringify(result).includes('iceServers'), false);
    });

    test('store creation rejects a missing or invalid ICE transport policy', async () => {
        await assert.rejects(freshContext({ WEBMEET_ICE_TRANSPORT_POLICY: undefined }), /must be exactly "all" or "relay"/);
        await assert.rejects(freshContext({ WEBMEET_ICE_TRANSPORT_POLICY: 'prefer-relay' }), /must be exactly "all" or "relay"/);
    });

    test('store context ignores retired TURN/STUN inputs and does not fall back to the internal LiveKit URL', async () => {
        const context = await freshContext({
            WEBMEET_PUBLIC_LIVEKIT_URL: '',
            WEBMEET_LIVEKIT_URL: 'http://livekitserveragent:7880',
            WEBMEET_STUN_URLS: 'stun:stale.example.com',
            WEBMEET_TURN_HOST: 'turn.stale.example.com',
            WEBMEET_TURN_URLS: 'turn:turn.stale.example.com',
        });
        assert.equal(context.livekitPublicUrl, '');
        assert.equal(context.livekitApiUrl, 'http://livekitserveragent:7880');
        assert.equal('stunExplicitUrls' in context, false);
        assert.equal('turn' in context, false);
    });
});
