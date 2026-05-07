export class LivekitRoomController {
    constructor(options = {}) {
        this.ensureLiveKitClient = options.ensureLiveKitClient;
        this.buildRtcConfigForSession = options.buildRtcConfigForSession;
        this.installRtcPeerConnectionOverride = options.installRtcPeerConnectionOverride;
        this.getAudioCaptureDefaults = typeof options.getAudioCaptureDefaults === 'function'
            ? options.getAudioCaptureDefaults
            : (() => ({
                autoGainControl: true,
                echoCancellation: true,
                noiseSuppression: true
            }));
        this.getMediaQualitySettings = typeof options.getMediaQualitySettings === 'function'
            ? options.getMediaQualitySettings
            : (() => ({
                cameraQuality: 'h720',
                screenShareQuality: 'h1080fps30'
            }));
        this.room = null;
        this.restoreRtcPeerConnection = null;
    }

    getQualityProfile(type, quality) {
        const key = String(quality || '').trim();
        const cameraProfiles = {
            h360: {
                preset: 'h360',
                resolution: { width: 640, height: 360, frameRate: 24 },
                encoding: { maxBitrate: 800_000, maxFramerate: 24 }
            },
            h540: {
                preset: 'h540',
                resolution: { width: 960, height: 540, frameRate: 30 },
                encoding: { maxBitrate: 1_500_000, maxFramerate: 30 }
            },
            h720: {
                preset: 'h720',
                resolution: { width: 1280, height: 720, frameRate: 30 },
                encoding: { maxBitrate: 2_500_000, maxFramerate: 30 }
            },
            h1080: {
                preset: 'h1080',
                resolution: { width: 1920, height: 1080, frameRate: 30 },
                encoding: { maxBitrate: 4_500_000, maxFramerate: 30 }
            }
        };
        const screenProfiles = {
            h720fps15: {
                preset: 'h720fps15',
                resolution: { width: 1280, height: 720, frameRate: 15 },
                encoding: { maxBitrate: 1_500_000, maxFramerate: 15 }
            },
            h720fps30: {
                preset: 'h720fps30',
                resolution: { width: 1280, height: 720, frameRate: 30 },
                encoding: { maxBitrate: 2_500_000, maxFramerate: 30 }
            },
            h1080fps15: {
                preset: 'h1080fps15',
                resolution: { width: 1920, height: 1080, frameRate: 15 },
                encoding: { maxBitrate: 2_500_000, maxFramerate: 15 }
            },
            h1080fps30: {
                preset: 'h1080fps30',
                resolution: { width: 1920, height: 1080, frameRate: 30 },
                encoding: { maxBitrate: 3_500_000, maxFramerate: 30 }
            }
        };
        const profiles = type === 'screen' ? screenProfiles : cameraProfiles;
        const fallback = type === 'screen' ? screenProfiles.h1080fps30 : cameraProfiles.h720;
        return profiles[key] || fallback;
    }

    getVideoResolution(livekit, presetName, fallback) {
        const preset = livekit?.VideoPresets?.[presetName];
        return preset?.resolution || fallback;
    }

    getVideoCaptureDefaults(livekit) {
        const settings = this.getMediaQualitySettings();
        const profile = this.getQualityProfile('camera', settings.cameraQuality);
        return {
            resolution: this.getVideoResolution(livekit, profile.preset, profile.resolution)
        };
    }

    getRoom() {
        return this.room;
    }

    async connect(session, hooks = {}) {
        if (!session?.participantToken || !session?.livekitUrl) {
            throw new Error('Join payload missing media token');
        }
        const livekit = await this.ensureLiveKitClient();
        const { Room, RoomEvent, Track } = livekit;

        this.restoreRtcPeerConnection?.();
        this.restoreRtcPeerConnection = this.installRtcPeerConnectionOverride(session);
        const audioCaptureDefaults = this.getAudioCaptureDefaults();
        const rtcConfig = this.buildRtcConfigForSession(session);

        const room = new Room({
            adaptiveStream: false,
            dynacast: false,
            audioCaptureDefaults,
            videoCaptureDefaults: this.getVideoCaptureDefaults(livekit),
            stopLocalTrackOnUnpublish: true
        });
        this.room = room;
        hooks.onRoomCreated?.({ room, livekit, Track, RoomEvent });

        room
            .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
                hooks.onTrackSubscribed?.(track, publication, participant, { room, livekit, Track, RoomEvent });
            })
            .on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
                hooks.onTrackUnsubscribed?.(track, publication, participant, { room, livekit, Track, RoomEvent });
            })
            .on(RoomEvent.TrackPublished, (publication, participant) => {
                hooks.onRemoteTrackPublished?.(publication, participant, { room, livekit, Track, RoomEvent });
            })
            .on(RoomEvent.LocalTrackPublished, (publication) => {
                hooks.onLocalTrackPublished?.(publication, { room, livekit, Track, RoomEvent });
            })
            .on(RoomEvent.LocalTrackUnpublished, (publication) => {
                hooks.onLocalTrackUnpublished?.(publication, { room, livekit, Track, RoomEvent });
            })
            .on(RoomEvent.ParticipantConnected, (participant) => {
                hooks.onParticipantConnected?.(participant, { room, livekit, Track, RoomEvent });
            })
            .on(RoomEvent.ParticipantDisconnected, (participant) => {
                hooks.onParticipantDisconnected?.(participant, { room, livekit, Track, RoomEvent });
            })
            .on(RoomEvent.TrackMuted, (publication, participant) => {
                hooks.onTrackMuted?.(publication, participant, { room, livekit, Track, RoomEvent });
            })
            .on(RoomEvent.TrackUnmuted, (publication, participant) => {
                hooks.onTrackUnmuted?.(publication, participant, { room, livekit, Track, RoomEvent });
            })
            .on(RoomEvent.DataReceived, (payload, participant) => {
                hooks.onDataReceived?.(payload, participant, { room, livekit, Track, RoomEvent });
            })
            .on(RoomEvent.Disconnected, () => {
                this.restoreRtcPeerConnection?.();
                this.restoreRtcPeerConnection = null;
                this.room = null;
                hooks.onDisconnected?.({ livekit, Track, RoomEvent });
            });

        try {
            hooks.onConnecting?.({ room, livekit, Track, RoomEvent });
            const connectOptions = {
                autoSubscribe: true,
                ...(rtcConfig ? { rtcConfig } : {})
            };
            await room.connect(
                session.livekitUrl,
                session.participantToken,
                connectOptions
            );
            hooks.onConnected?.({ room, livekit, Track, RoomEvent });
            return { room, livekit, Track, RoomEvent };
        } catch (error) {
            hooks.onConnectError?.(error, { room, livekit, Track, RoomEvent });
            try {
                await room.disconnect();
            } catch (_) {
                // ignore disconnect after failed connect
            }
            this.restoreRtcPeerConnection?.();
            this.restoreRtcPeerConnection = null;
            if (this.room === room) {
                this.room = null;
            }
            throw error;
        }
    }

    async disconnect() {
        const room = this.room;
        if (!room) return;
        try {
            await room.disconnect();
        } catch (_) {
            // ignore disconnect failures
        }
        this.restoreRtcPeerConnection?.();
        this.restoreRtcPeerConnection = null;
        if (this.room === room) {
            this.room = null;
        }
    }

    teardown() {
        this.restoreRtcPeerConnection?.();
        this.restoreRtcPeerConnection = null;
        this.room = null;
    }
}
