import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    isAudioPublication,
    isMicrophonePublication
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/microphone-publication.js';

const Track = {
    Kind: {
        Audio: 'audio',
        Video: 'video'
    },
    Source: {
        Microphone: 'microphone',
        ScreenShareAudio: 'screen_share_audio',
        Camera: 'camera'
    }
};

test('isMicrophonePublication accepts only explicit microphone source for remote tracks', () => {
    assert.equal(isMicrophonePublication({
        kind: Track.Kind.Audio,
        source: Track.Source.Microphone
    }, Track), true);
    assert.equal(isMicrophonePublication({
        kind: Track.Kind.Audio,
        source: Track.Source.ScreenShareAudio
    }, Track), false);
    assert.equal(isMicrophonePublication({
        kind: Track.Kind.Audio,
        source: ''
    }, Track), false);
});

test('isMicrophonePublication accepts source-less audio only for the active local custom mic track', () => {
    const activeTrack = { sid: 'active-mic' };
    assert.equal(isMicrophonePublication({
        kind: Track.Kind.Audio,
        source: '',
        track: activeTrack
    }, Track, {
        allowLocalCustomFallback: true,
        activeMicrophoneTrack: activeTrack
    }), true);
    assert.equal(isMicrophonePublication({
        kind: Track.Kind.Audio,
        source: '',
        track: { sid: 'other-audio' }
    }, Track, {
        allowLocalCustomFallback: true,
        activeMicrophoneTrack: activeTrack
    }), false);
});

test('isAudioPublication recognizes LiveKit publication and media stream audio kinds', () => {
    assert.equal(isAudioPublication({ kind: Track.Kind.Audio }, Track), true);
    assert.equal(isAudioPublication({ track: { kind: Track.Kind.Audio } }, Track), true);
    assert.equal(isAudioPublication({ track: { mediaStreamTrack: { kind: 'audio' } } }, Track), true);
    assert.equal(isAudioPublication({ kind: Track.Kind.Video }, Track), false);
});
