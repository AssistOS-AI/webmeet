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
        this.room = null;
        this.restoreRtcPeerConnection = null;
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
            audioCaptureDefaults
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
                autoSubscribe: false,
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
