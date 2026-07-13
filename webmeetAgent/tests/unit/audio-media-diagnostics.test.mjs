import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    logMediaDiagnostic,
    summarizeAudioMetrics,
    summarizeAudioWebRtcStats
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/media-diagnostics.js';

test('audio diagnostics expose only rounded aggregate metrics', () => {
    assert.deepEqual(summarizeAudioMetrics({
        rmsDb: -18.123,
        peakDb: -3.456,
        noiseFloorDb: -55.678,
        clipping: false,
        speaking: true,
        humFrequency: '50',
        adaptiveGain: 1.234,
        mode: 'auto',
        health: 'Good',
        samples: [0.1, 0.2]
    }), {
        rmsDb: -18.1,
        peakDb: -3.5,
        noiseFloorDb: -55.7,
        clipping: false,
        speaking: true,
        humFrequency: '50',
        adaptiveGain: 1.23,
        mode: 'auto',
        health: 'Good'
    });
});

test('audio WebRTC diagnostics summarize jitter, loss, concealment, and RTT', () => {
    assert.deepEqual(summarizeAudioWebRtcStats([
        { type: 'inbound-rtp', kind: 'audio', jitter: 0.01234, packetsLost: 3, concealedSamples: 120 },
        { type: 'outbound-rtp', kind: 'audio' },
        { type: 'remote-inbound-rtp', kind: 'audio', roundTripTime: 0.0876 },
        { type: 'inbound-rtp', kind: 'video', jitter: 1, packetsLost: 999 }
    ]), {
        inboundAudioStreams: 1,
        outboundAudioStreams: 1,
        jitterMs: 12.3,
        packetsLost: 3,
        concealedSamples: 120,
        roundTripTimeMs: 87.6
    });
});

test('audio WebRTC diagnostics accept RTCStatsReport map entries', () => {
    const reports = new Map([
        ['inbound-audio', { type: 'inbound-rtp', kind: 'audio', packetsLost: 2, concealedSamples: 4 }]
    ]);
    assert.equal(summarizeAudioWebRtcStats(reports).packetsLost, 2);
});

test('media diagnostics redact secrets embedded in non-sensitive string fields', (t) => {
    const previousDebug = globalThis.WEBMEET_MEDIA_DEBUG;
    const previousInfo = globalThis.console.info;
    t.after(() => {
        globalThis.WEBMEET_MEDIA_DEBUG = previousDebug;
        globalThis.console.info = previousInfo;
    });

    const jwt = 'eyJhbGciOiJIUzI1NiJ9.c2Vuc2l0aXZlLXBheWxvYWQ.c2Vuc2l0aXZlLXNpZ25hdHVyZQ';
    const opaqueToken = 'opaque-sensitive-token';
    const joinRequest = 'opaque-sensitive-join-request';
    const captured = [];
    globalThis.WEBMEET_MEDIA_DEBUG = true;
    globalThis.console.info = (...args) => captured.push(args);

    logMediaDiagnostic('connect-error', {
        message: `failed wss://meet.example.com/rtc?access_token=${opaqueToken}&room=safe-room`,
        errorMessage: `Authorization: Bearer ${jwt}`,
        detail: `credential=${opaqueToken}`,
        signalingError: `failed wss://meet.example.com/rtc?join_request=${joinRequest}`,
        nested: [`turn:user:${opaqueToken}@turn.example.com:3478?transport=udp`, jwt],
        generic: 'connection timed out',
    });

    assert.equal(captured.length, 1);
    const serialized = JSON.stringify(captured[0]);
    assert.equal(serialized.includes(opaqueToken), false);
    assert.equal(serialized.includes(joinRequest), false);
    assert.equal(serialized.includes(jwt), false);
    assert.equal(serialized.includes('turn:user:'), false);
    assert.match(serialized, /connection timed out/);
    assert.match(serialized, /<redacted/);
});

test('media diagnostics align credential aliases without treating unrelated key suffixes as secrets', (t) => {
    const previousDebug = globalThis.WEBMEET_MEDIA_DEBUG;
    const previousInfo = globalThis.console.info;
    t.after(() => {
        globalThis.WEBMEET_MEDIA_DEBUG = previousDebug;
        globalThis.console.info = previousInfo;
    });

    const sentinels = [
        'CREDENTIALS_SENTINEL',
        'JWT_SENTINEL',
        'KEY_SENTINEL',
        'SIG_SENTINEL',
        'SIGNATURE_SENTINEL',
        'SIGNING_KEY_SENTINEL',
        'OBJECT_JWT_SENTINEL',
        'OBJECT_KEY_SENTINEL',
        'OBJECT_SIG_SENTINEL',
        'OBJECT_SIGNATURE_SENTINEL',
        'OBJECT_SIGNING_KEY_SENTINEL',
    ];
    const captured = [];
    globalThis.WEBMEET_MEDIA_DEBUG = true;
    globalThis.console.info = (...args) => captured.push(args);

    logMediaDiagnostic('credential-alias-check', {
        aliases: [
            'credentials=CREDENTIALS_SENTINEL',
            'jwt=JWT_SENTINEL',
            'key=KEY_SENTINEL',
            'sig=SIG_SENTINEL',
            'signature=SIGNATURE_SENTINEL',
            'signing_key=SIGNING_KEY_SENTINEL',
            'k-e-y=KEY_SENTINEL',
            'j_w_t=JWT_SENTINEL',
            's-i-g=SIG_SENTINEL',
            'sig.nature=SIGNATURE_SENTINEL',
            'cred.entials=CREDENTIALS_SENTINEL',
            'pass-word=KEY_SENTINEL',
            'auth.orization=JWT_SENTINEL',
            'to-ken=SIG_SENTINEL',
        ],
        jwt: 'OBJECT_JWT_SENTINEL',
        key: 'OBJECT_KEY_SENTINEL',
        sig: 'OBJECT_SIG_SENTINEL',
        signature: 'OBJECT_SIGNATURE_SENTINEL',
        signingKey: 'OBJECT_SIGNING_KEY_SENTINEL',
        safeAlias: 'monkey=visible; mon_key=visible',
    });

    assert.equal(captured.length, 1);
    const serialized = JSON.stringify(captured[0]);
    for (const sentinel of sentinels) {
        assert.equal(serialized.includes(sentinel), false, `${sentinel} must be redacted`);
    }
    assert.match(serialized, /monkey=visible; mon_key=visible/);
});

test('media diagnostics redact serialized, encoded, secure STUN, and quoted authorization values', (t) => {
    const previousDebug = globalThis.WEBMEET_MEDIA_DEBUG;
    const previousInfo = globalThis.console.info;
    t.after(() => {
        globalThis.WEBMEET_MEDIA_DEBUG = previousDebug;
        globalThis.console.info = previousInfo;
    });

    const sentinels = [
        'JSON_OPAQUE_SECRET',
        'JSON_PASSWORD_SECRET',
        'STUNS_SECRET',
        'ENCODED_SECRET',
        'BASIC_QUOTED_SECRET',
    ];
    const captured = [];
    globalThis.WEBMEET_MEDIA_DEBUG = true;
    globalThis.console.info = (...args) => captured.push(args);

    logMediaDiagnostic('serialized-connect-error', {
        serialized: 'request failed: {"token":"JSON_OPAQUE_SECRET","password":"JSON_PASSWORD_SECRET"}',
        secureStun: 'stuns:user:STUNS_SECRET@stun.example.com:5349',
        encodedQuery: 'wss://meet.example.com/rtc?access_token%3DENCODED_SECRET',
        quotedBasic: 'Authorization: Basic "BASIC_QUOTED_SECRET"',
    });

    assert.equal(captured.length, 1);
    const serialized = JSON.stringify(captured[0]);
    for (const sentinel of sentinels) {
        assert.equal(serialized.includes(sentinel), false, `${sentinel} must be redacted`);
    }
    assert.match(serialized, /<redacted/);
});

test('media diagnostics fail closed for aliases, nested encodings, URL userinfo, SDP, and ICE candidates', (t) => {
    const previousDebug = globalThis.WEBMEET_MEDIA_DEBUG;
    const previousInfo = globalThis.console.info;
    t.after(() => {
        globalThis.WEBMEET_MEDIA_DEBUG = previousDebug;
        globalThis.console.info = previousInfo;
    });

    const sentinels = [
        'API_KEY_SECRET',
        'COOKIE_SECRET',
        'ESCAPED_JSON_SECRET',
        'ENCODED_KEY_SECRET',
        'URL_PASSWORD_SECRET',
        'CANDIDATE_SECRET',
        'SDP_SECRET',
    ];
    const captured = [];
    globalThis.WEBMEET_MEDIA_DEBUG = true;
    globalThis.console.info = (...args) => captured.push(args);

    logMediaDiagnostic('connection-check', {
        apiKey: 'API_KEY_SECRET',
        cookie: 'COOKIE_SECRET',
        escapedJson: String.raw`request failed: {\"token\":\"ESCAPED_JSON_SECRET\"}`,
        encodedAssignment: 'wss://meet.example.com/rtc?access%5Ftoken%3DENCODED_KEY_SECRET',
        endpoint: 'https://diagnostic-user:URL_PASSWORD_SECRET@meet.example.com/rtc',
        transportDetail: 'candidate:1 1 udp 2122260223 192.0.2.10 50000 typ host ufrag CANDIDATE_SECRET',
        negotiationDetail: 'v=0\r\no=- 1 1 IN IP4 192.0.2.10\r\ns=-\r\nt=0 0\r\na=ice-pwd:SDP_SECRET\r\n',
        candidateType: 'relay',
        candidateCount: 2,
        generic: 'connection timed out for safe-room',
    });

    assert.equal(captured.length, 1);
    const serialized = JSON.stringify(captured[0]);
    for (const sentinel of sentinels) {
        assert.equal(serialized.includes(sentinel), false, `${sentinel} must be redacted`);
    }
    assert.match(serialized, /connection timed out for safe-room/);
    assert.match(serialized, /candidateType/);
    assert.match(serialized, /relay/);
    assert.match(serialized, /candidateCount/);
    assert.match(serialized, /meet\.example\.com\/rtc/);
    assert.match(serialized, /<redacted/);
});

test('media diagnostics redact bounded encoded assignments and private-key material', (t) => {
    const previousDebug = globalThis.WEBMEET_MEDIA_DEBUG;
    const previousInfo = globalThis.console.info;
    t.after(() => {
        globalThis.WEBMEET_MEDIA_DEBUG = previousDebug;
        globalThis.console.info = previousInfo;
    });

    const sentinels = [
        'ENC_JSON_SECRET',
        'DOUBLE_ENCODE_SECRET',
        'DOT_KEY_SECRET',
        'PRIVATE_KEY_SECRET',
        'PRIVATE_PEM_SECRET',
    ];
    const captured = [];
    globalThis.WEBMEET_MEDIA_DEBUG = true;
    globalThis.console.info = (...args) => captured.push(args);

    logMediaDiagnostic('encoded-connection-check', {
        encodedJson: '%7B%22token%22%3A%22ENC_JSON_SECRET%22%7D',
        doubleEncodedAssignment: 'token%253DDOUBLE_ENCODE_SECRET',
        dottedAlias: 'api.key=DOT_KEY_SECRET',
        privateKeyAssignment: 'privateKey=PRIVATE_KEY_SECRET',
        privateKeyPem: '-----BEGIN PRIVATE KEY-----\nPRIVATE_PEM_SECRET\n-----END PRIVATE KEY-----',
        generic: 'request failed after 250 ms',
    });

    assert.equal(captured.length, 1);
    const serialized = JSON.stringify(captured[0]);
    for (const sentinel of sentinels) {
        assert.equal(serialized.includes(sentinel), false, `${sentinel} must be redacted`);
    }
    assert.match(serialized, /request failed after 250 ms/);
    assert.match(serialized, /<redacted/);
});

test('media diagnostics decode percent encoding to convergence and fail closed at the work bound', (t) => {
    const previousDebug = globalThis.WEBMEET_MEDIA_DEBUG;
    const previousInfo = globalThis.console.info;
    t.after(() => {
        globalThis.WEBMEET_MEDIA_DEBUG = previousDebug;
        globalThis.console.info = previousInfo;
    });

    const captured = [];
    globalThis.WEBMEET_MEDIA_DEBUG = true;
    globalThis.console.info = (...args) => captured.push(args);

    const encodeRepeatedly = (value, count) => {
        let encoded = value;
        for (let index = 0; index < count; index += 1) {
            encoded = encodeURIComponent(encoded);
        }
        return encoded;
    };
    const encodedKey = encodeRepeatedly('%74oken', 3);

    logMediaDiagnostic('deeply-encoded-connection-check', {
        tripleEncodedJson: encodeRepeatedly(JSON.stringify({ token: 'TRIPLE_ENCODE_SECRET' }), 3),
        deeperEncodedJson: encodeRepeatedly(JSON.stringify({ password: 'DEEP_ENCODE_SECRET' }), 12),
        [encodedKey]: 'ENCODED_KEY_VALUE_SECRET',
        beyondDecodeBudget: encodeRepeatedly(JSON.stringify({ credential: 'BUDGET_SECRET' }), 96),
        generic: 'safe aggregate context',
    });

    assert.equal(captured.length, 1);
    const serialized = JSON.stringify(captured[0]);
    for (const sentinel of [
        'TRIPLE_ENCODE_SECRET',
        'DEEP_ENCODE_SECRET',
        'ENCODED_KEY_VALUE_SECRET',
        'BUDGET_SECRET',
    ]) {
        assert.equal(serialized.includes(sentinel), false, `${sentinel} must be redacted`);
    }
    assert.match(serialized, /safe aggregate context/);
    assert.match(serialized, /<redacted/);
});
