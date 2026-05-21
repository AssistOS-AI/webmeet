import { logMediaDiagnostic } from '../services/media-diagnostics.js';
import {
    getLiveKitProfileResolution,
    getMediaQualityProfile
} from './media-quality-profiles.js';

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
        return getMediaQualityProfile(type, quality);
    }

    getVideoCaptureDefaults(livekit) {
        const settings = this.getMediaQualitySettings();
        const profile = this.getQualityProfile('camera', settings.cameraQuality);
        return {
            resolution: getLiveKitProfileResolution(livekit, 'camera', profile)
        };
    }

    getPublishDefaults() {
        const settings = this.getMediaQualitySettings();
        const profile = this.getQualityProfile('camera', settings.cameraQuality);
        return {
            videoEncoding: { ...profile.encoding }
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
            publishDefaults: this.getPublishDefaults(),
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
            .on(RoomEvent.ActiveSpeakersChanged, (participants) => {
                hooks.onActiveSpeakersChanged?.(participants, { room, livekit, Track, RoomEvent });
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
            .on(RoomEvent.ParticipantAttributesChanged, (changedAttributes, participant) => {
                hooks.onParticipantAttributesChanged?.(changedAttributes, participant, { room, livekit, Track, RoomEvent });
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
            logMediaDiagnostic('room-connect-start', {
                livekitHost: (() => {
                    try {
                        return new URL(session.livekitUrl).host;
                    } catch (_) {
                        return '';
                    }
                })(),
                hasRtcConfig: Boolean(rtcConfig),
                iceServerCount: Number(rtcConfig?.iceServers?.length || 0),
                roomOptions: {
                    adaptiveStream: false,
                    dynacast: false,
                    stopLocalTrackOnUnpublish: true
                },
                connectOptions: {
                    autoSubscribe: true,
                    hasRtcConfig: Boolean(rtcConfig)
                }
            });
            await room.connect(
                session.livekitUrl,
                session.participantToken,
                connectOptions
            );
            logMediaDiagnostic('room-connect-complete', {
                localIdentity: room.localParticipant?.identity || '',
                remoteParticipantCount: Number(room.remoteParticipants?.size || 0)
            });
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
