import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    summarizeAudioMetrics,
    summarizeAudioWebRtcStats
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/services/media-diagnostics.js';

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
