export class WebmeetMediaController {
    constructor(options = {}) {
        this.getRoom = typeof options.getRoom === 'function' ? options.getRoom : (() => null);
        this.getTrack = typeof options.getTrack === 'function' ? options.getTrack : (() => window.LivekitClient?.Track || null);
        this.onMediaStateChange = typeof options.onMediaStateChange === 'function' ? options.onMediaStateChange : (() => {});
        this.onMicStateChange = typeof options.onMicStateChange === 'function' ? options.onMicStateChange : (() => {});
        this.onError = typeof options.onError === 'function' ? options.onError : (() => {});
        this.onAfterToggle = typeof options.onAfterToggle === 'function' ? options.onAfterToggle : (() => {});
        this.settings = {
            audioInputDeviceId: '',
            videoInputDeviceId: '',
            audioOutputDeviceId: '',
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        };
        this.inFlight = false;
    }

    reset() {
        this.inFlight = false;
    }

    setSettings(next = {}) {
        this.settings = {
            ...this.settings,
            ...next
        };
    }

    getSettings() {
        return { ...this.settings };
    }

    getMicrophoneEnableOptions() {
        const audioDeviceId = String(this.settings.audioInputDeviceId || '').trim();
        const deviceId = audioDeviceId
            ? ({ exact: audioDeviceId })
            : undefined;
        return {
            deviceId,
            echoCancellation: Boolean(this.settings.echoCancellation),
            noiseSuppression: Boolean(this.settings.noiseSuppression),
            autoGainControl: Boolean(this.settings.autoGainControl)
        };
    }

    getLocalMicrophoneTracks(TrackRef = null) {
        const Track = TrackRef || this.getTrack();
        const room = this.getRoom();
        const localParticipant = room?.localParticipant;
        if (!Track || !localParticipant?.trackPublications?.values) return [];
        const tracks = [];
        for (const publication of localParticipant.trackPublications.values()) {
            if (!publication) continue;
            const isMic = publication.source === Track.Source.Microphone;
            if (!isMic) continue;
            if (publication.track) {
                tracks.push(publication.track);
            }
        }
        return tracks;
    }

    hasActiveMicrophoneCapture(TrackRef = null) {
        const tracks = this.getLocalMicrophoneTracks(TrackRef);
        for (const track of tracks) {
            const mediaStreamTrack = track?.mediaStreamTrack || null;
            const readyState = String(mediaStreamTrack?.readyState || '').toLowerCase();
            if (readyState === 'live') {
                return true;
            }
        }
        return false;
    }

    hardStopMicrophoneTracks(TrackRef = null) {
        const tracks = this.getLocalMicrophoneTracks(TrackRef);
        for (const track of tracks) {
            if (!track) continue;
            try {
                if (typeof track.stop === 'function') {
                    track.stop();
                    continue;
                }
            } catch (_) {
                // continue to fallback stop path
            }
            try {
                track.mediaStreamTrack?.stop?.();
            } catch (_) {
                // ignore best-effort stop errors
            }
        }
    }

    async waitForMicrophoneHardStopped(timeoutMs = 1500) {
        const start = Date.now();
        while ((Date.now() - start) < timeoutMs) {
            if (!this.hasActiveMicrophoneCapture()) {
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return !this.hasActiveMicrophoneCapture();
    }

    getCameraEnableOptions() {
        const videoDeviceId = String(this.settings.videoInputDeviceId || '').trim();
        const deviceId = videoDeviceId
            ? ({ exact: videoDeviceId })
            : undefined;
        return { deviceId };
    }

    isLocalSourceEnabled(type, TrackRef = null) {
        const Track = TrackRef || this.getTrack();
        const room = this.getRoom();
        const localParticipant = room?.localParticipant;
        if (!Track || !localParticipant?.trackPublications?.values) {
            return false;
        }
        const sourceMap = {
            microphone: Track.Source?.Microphone,
            camera: Track.Source?.Camera,
            screen: Track.Source?.ScreenShare
        };
        const wantedSource = sourceMap[type];
        const wantedKind = type === 'microphone' ? Track.Kind.Audio : Track.Kind.Video;

        for (const publication of localParticipant.trackPublications.values()) {
            if (!publication) continue;
            const sameKind = publication.kind === wantedKind;
            const sameSource = wantedSource ? publication.source === wantedSource : false;
            if ((sameSource || (type === 'camera' && sameKind && !publication.source))
                && !publication.isMuted) {
                return true;
            }
        }
        return false;
    }

    getLocalMediaStateFromRoom(TrackRef = null) {
        const Track = TrackRef || this.getTrack();
        const room = this.getRoom();
        const localParticipant = room?.localParticipant;
        const next = {
            microphone: false,
            camera: false,
            screen: false
        };
        if (!Track || !localParticipant?.trackPublications?.values) {
            return next;
        }
        next.microphone = this.isLocalSourceEnabled('microphone', Track) || this.hasActiveMicrophoneCapture(Track);
        next.camera = this.isLocalSourceEnabled('camera', Track);
        next.screen = this.isLocalSourceEnabled('screen', Track);
        return next;
    }

    async waitForLocalSourceState(type, enabled, timeoutMs = 1200) {
        const start = Date.now();
        while ((Date.now() - start) < timeoutMs) {
            const current = this.isLocalSourceEnabled(type);
            if (current === enabled) {
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 60));
        }
        return false;
    }

    syncLocalMediaStateFromRoom(TrackRef = null) {
        const next = this.getLocalMediaStateFromRoom(TrackRef);
        const room = this.getRoom();
        const localId = String(room?.localParticipant?.identity || '').trim();
        this.onMediaStateChange(next, localId);
        return next;
    }

    async runExclusiveToggle(action) {
        if (this.inFlight) {
            return;
        }
        this.inFlight = true;
        try {
            await action();
        } catch (error) {
            this.onError(error instanceof Error ? error.message : String(error));
        } finally {
            this.syncLocalMediaStateFromRoom();
            this.onAfterToggle();
            this.inFlight = false;
        }
    }

    async toggleMicrophone() {
        const room = this.getRoom();
        if (!room?.localParticipant) {
            this.onError('Join a meeting before enabling the microphone.');
            return;
        }
        await this.runExclusiveToggle(async () => {
            const enable = !this.isLocalSourceEnabled('microphone');
            if (enable) {
                const options = this.getMicrophoneEnableOptions();
                try {
                    await room.localParticipant.setMicrophoneEnabled(true, options);
                } catch (_) {
                    await room.localParticipant.setMicrophoneEnabled(true);
                }
            } else {
                this.hardStopMicrophoneTracks();
                await room.localParticipant.setMicrophoneEnabled(false);
                const hardStopped = await this.waitForMicrophoneHardStopped();
                if (!hardStopped) {
                    throw new Error('Microphone capture did not stop completely. Check browser permissions/device.');
                }
            }
            await this.waitForLocalSourceState('microphone', enable);
        });
    }

    async toggleCamera() {
        const room = this.getRoom();
        if (!room?.localParticipant) {
            this.onError('Join a meeting before enabling the camera.');
            return;
        }
        await this.runExclusiveToggle(async () => {
            const localParticipant = room.localParticipant;
            const shouldEnableCamera = !this.isLocalSourceEnabled('camera');
            if (shouldEnableCamera && this.isLocalSourceEnabled('screen')) {
                await localParticipant.setScreenShareEnabled(false);
                await this.waitForLocalSourceState('screen', false);
            }
            if (shouldEnableCamera) {
                const options = this.getCameraEnableOptions();
                try {
                    await localParticipant.setCameraEnabled(true, options);
                } catch (_) {
                    await localParticipant.setCameraEnabled(true);
                }
            } else {
                await localParticipant.setCameraEnabled(false);
            }
            await this.waitForLocalSourceState('camera', shouldEnableCamera);
        });
    }

    async toggleScreenShare() {
        const room = this.getRoom();
        if (!room?.localParticipant) {
            this.onError('Join a meeting before starting screen share.');
            return;
        }
        await this.runExclusiveToggle(async () => {
            const localParticipant = room.localParticipant;
            const shouldEnableScreen = !this.isLocalSourceEnabled('screen');
            if (shouldEnableScreen && this.isLocalSourceEnabled('camera')) {
                await localParticipant.setCameraEnabled(false);
                await this.waitForLocalSourceState('camera', false);
            }
            await localParticipant.setScreenShareEnabled(shouldEnableScreen);
            await this.waitForLocalSourceState('screen', shouldEnableScreen);
        });
    }
}
