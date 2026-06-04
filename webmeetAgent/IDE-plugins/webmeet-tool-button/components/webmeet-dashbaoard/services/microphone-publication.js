export function isAudioPublication(publication, Track) {
    if (!publication || !Track) return false;
    return publication.kind === Track.Kind?.Audio
        || publication.track?.kind === Track.Kind?.Audio
        || publication.track?.mediaStreamTrack?.kind === 'audio';
}

export function isMicrophonePublication(publication, Track, options = {}) {
    if (!publication || !Track || !isAudioPublication(publication, Track)) return false;
    const source = String(publication.source || '').trim();
    const microphoneSource = String(Track.Source?.Microphone || '').trim();
    if (microphoneSource && source === microphoneSource) {
        return true;
    }
    if (source) {
        return false;
    }
    if (options.allowLocalCustomFallback !== true) {
        return false;
    }
    const activeMicrophoneTrack = options.activeMicrophoneTrack || null;
    return Boolean(activeMicrophoneTrack && publication.track && publication.track === activeMicrophoneTrack);
}
