import {
    logMediaDiagnostic,
    summarizeParticipant,
    summarizePublication,
    summarizeTrack,
    summarizeVideoElement
} from '../services/media-diagnostics.js';
import { isAudioPublication } from '../services/microphone-publication.js';

export const roomSessionMethods = {
    async connectRoom() {
        if (!this.state.session?.participantToken || !this.state.session?.livekitUrl) {
            this.state.roomState = 'Join payload missing media token';
            this.renderMeetingSummary();
            return;
        }
        await this.disconnectRoom();
        this.state.activeSpeakerIds = new Set();

        const remoteVideoRecoveryCounts = new WeakMap();

        const isRemoteVideoElementReady = (mediaElement) => {
            if (!mediaElement) return false;
            return Number(mediaElement.videoWidth || 0) > 0
                || Number(mediaElement.videoHeight || 0) > 0
                || Number(mediaElement.currentTime || 0) > 0
                || Number(mediaElement.readyState || 0) >= HTMLMediaElement.HAVE_CURRENT_DATA;
        };

        let refreshRemoteVideoSubscription = () => {};

        const scheduleRemoteVideoReadinessDiagnostics = (participant, publication, mediaElement, TrackRef = null, reason = 'remote-video') => {
            const Track = TrackRef || window.LivekitClient?.Track || null;
            const isVideoTrack = Track
                ? publication?.kind === Track.Kind.Video
                : publication?.track?.kind === 'video';
            if (!publication || !mediaElement || !isVideoTrack) return;

            for (const delay of [1500, 3500, 7000]) {
                window.setTimeout(() => {
                    if (!this.room) return;
                    if (!mediaElement.isConnected) return;
                    const isReady = isRemoteVideoElementReady(mediaElement);
                    logMediaDiagnostic('remote-video-readiness-check', {
                        reason,
                        delay,
                        isReady,
                        participant: summarizeParticipant(participant),
                        publication: summarizePublication(publication),
                        videoElement: summarizeVideoElement(mediaElement)
                    });
                    if (!isReady && delay >= 3500) {
                        refreshRemoteVideoSubscription(publication, participant, `${reason}:not-ready:${delay}`);
                    }
                }, delay);
            }
        };

        const renderPublication = (participant, publication, explicitTrack = null, TrackRef = null) => {
            const Track = TrackRef || window.LivekitClient?.Track;
            if (!Track) return;
            const participantId = String(participant?.identity || '').trim();
            if (!participantId || !publication) return;
            this.upsertParticipantView({
                identity: participantId,
                name: this.getParticipantDisplayName(participant),
                kind: participantId === this.room?.localParticipant?.identity ? 'local' : 'remote'
            });
            const track = explicitTrack || publication.track;
            if (!track) return;
            const trackId = String(
                publication.trackSid
                || `${participantId}:${publication.source || publication.kind || track.kind || 'track'}`
            ).trim();
            if (!trackId) return;
            const isLocalParticipant = participantId === this.room?.localParticipant?.identity;

            if (track.kind === Track.Kind.Video) {
                const existingTrackEntry = this.participantLayoutController.getTrackEntry(trackId);
                if (existingTrackEntry?.element) {
                    logMediaDiagnostic('video-track-attach-skip-existing', {
                        participant: summarizeParticipant(participant),
                        publication: summarizePublication(publication),
                        track: summarizeTrack(track),
                        trackId,
                        videoElement: summarizeVideoElement(existingTrackEntry.element)
                    });
                    return;
                }
                const mediaElement = track.attach();
                mediaElement.autoplay = true;
                mediaElement.playsInline = true;
                mediaElement.dataset.trackSource = String(publication.source || '').trim();
                if (participantId === this.room?.localParticipant?.identity) {
                    mediaElement.muted = true;
                }
                logMediaDiagnostic('video-track-attached', {
                    participant: summarizeParticipant(participant),
                    publication: summarizePublication(publication),
                    track: summarizeTrack(track),
                    trackId,
                    isLocalParticipant
                });
                this.attachVideoTrack(participantId, trackId, mediaElement);
                if (!isLocalParticipant) {
                    for (const eventName of ['loadedmetadata', 'playing', 'waiting', 'stalled', 'error']) {
                        mediaElement.addEventListener(eventName, () => {
                            logMediaDiagnostic('remote-video-element-event', {
                                eventName,
                                participant: summarizeParticipant(participant),
                                publication: summarizePublication(publication),
                                videoElement: summarizeVideoElement(mediaElement)
                            });
                        }, { once: eventName !== 'waiting' });
                    }
                    scheduleRemoteVideoReadinessDiagnostics(participant, publication, mediaElement, Track, 'render-video');
                }
            } else if (track.kind === Track.Kind.Audio) {
                if (!isLocalParticipant) {
                    const mediaElement = track.attach();
                    mediaElement.autoplay = true;
                    mediaElement.dataset.trackSource = String(publication.source || '').trim();
                    void this.applyAudioOutputDeviceToElement(mediaElement);
                    this.attachAudioTrack(participantId, trackId, mediaElement);
                    this.applyOutputVolumePreviewToElement(mediaElement);
                }
                if (this.isMicrophonePublication(publication, Track, participant)) {
                    this.setParticipantMicState(participantId, !publication.isMuted);
                }
            }
        };

        const removePublication = (publication, TrackRef = null, participant = null) => {
            const Track = TrackRef || window.LivekitClient?.Track;
            const participantId = String(participant?.identity || '').trim();
            const source = String(publication?.source || '').trim();
            const rawKind = String(publication?.kind || publication?.track?.kind || publication?.track?.mediaStreamTrack?.kind || '').trim();
            const isVideoSource = Track && [
                Track.Source?.Camera,
                Track.Source?.ScreenShare
            ].map((value) => String(value || '').trim()).filter(Boolean).includes(source);
            const isAudioSource = Track && [
                Track.Source?.Microphone,
                Track.Source?.ScreenShareAudio
            ].map((value) => String(value || '').trim()).filter(Boolean).includes(source);
            const publicationKind = Track && publication?.kind === Track.Kind.Video ? 'video'
                : Track && publication?.kind === Track.Kind.Audio ? 'audio'
                    : rawKind === 'video' || isVideoSource ? 'video'
                        : rawKind === 'audio' || isAudioSource ? 'audio'
                            : '';
            const candidateTrackIds = [
                publication?.trackSid,
                publication?.track?.sid,
                participantId && source ? `${participantId}:${source}` : '',
                participantId && source && publicationKind ? `${participantId}:${source}:${publicationKind}` : '',
                participantId && publicationKind ? `${participantId}:${publicationKind}` : ''
            ].map((value) => String(value || '').trim()).filter(Boolean);
            const trackIds = new Set(candidateTrackIds.filter((trackId) => (
                this.participantLayoutController.getTrackEntry(trackId)
            )));

            if (!trackIds.size && participantId) {
                for (const trackId of this.participantLayoutController.findTrackIdsForParticipant(participantId, {
                    kind: publicationKind,
                    source
                })) {
                    trackIds.add(trackId);
                }
            }
            if (!trackIds.size && participantId && publicationKind === 'video' && !source) {
                for (const trackId of this.participantLayoutController.findTrackIdsForParticipant(participantId, {
                    kind: 'video'
                })) {
                    trackIds.add(trackId);
                }
            }
            if (!trackIds.size) return;

            let trackInfo = null;
            for (const trackId of trackIds) {
                trackInfo = trackInfo || this.participantLayoutController.getTrackEntry(trackId);
                this.removeTrack(trackId);
            }
            if (Track && isAudioPublication(publication, Track)) {
                const participantId = String(trackInfo?.participantId || '').trim();
                if (participantId) {
                    const participant = participantId === this.room?.localParticipant?.identity
                        ? this.room.localParticipant
                        : this.room?.remoteParticipants?.get?.(participantId);
                    this.setParticipantMicState(participantId, this.isParticipantMicOn(participant, Track));
                }
            }
        };

        const setPublicationSubscribed = (publication, shouldSubscribe, participant, reason) => {
            if (!publication || typeof publication.setSubscribed !== 'function') return;
            logMediaDiagnostic('publication-set-subscribed', {
                shouldSubscribe,
                reason,
                participant: summarizeParticipant(participant),
                publication: summarizePublication(publication)
            });
            try {
                const result = publication.setSubscribed(shouldSubscribe);
                if (result && typeof result.catch === 'function') {
                    result.catch((error) => {
                        logMediaDiagnostic('publication-set-subscribed-rejected', {
                            shouldSubscribe,
                            reason,
                            message: error instanceof Error ? error.message : String(error)
                        });
                    });
                }
            } catch (error) {
                logMediaDiagnostic('publication-set-subscribed-error', {
                    shouldSubscribe,
                    reason,
                    message: error instanceof Error ? error.message : String(error)
                });
                // LiveKit may reject subscription changes during disconnect/reconnect.
            }
        };

        refreshRemoteVideoSubscription = (publication, participant, reason) => {
            if (!publication || typeof publication.setSubscribed !== 'function') return;
            if (publication.isMuted) return;
            const track = publication.track || null;
            const mediaStreamTrack = track?.mediaStreamTrack || null;
            if (mediaStreamTrack && mediaStreamTrack.readyState !== 'live') return;
            const refreshCount = remoteVideoRecoveryCounts.get(publication) || 0;
            if (refreshCount >= 2) return;
            remoteVideoRecoveryCounts.set(publication, refreshCount + 1);
            const Track = window.LivekitClient?.Track || null;
            logMediaDiagnostic('remote-video-subscription-refresh', {
                reason,
                attempt: refreshCount + 1,
                participant: summarizeParticipant(participant),
                publication: summarizePublication(publication),
                track: summarizeTrack(track)
            });
            removePublication(publication, Track, participant);
            setPublicationSubscribed(publication, false, participant, `${reason}:refresh-off`);
            window.setTimeout(() => {
                if (!this.room) return;
                setPublicationSubscribed(publication, true, participant, `${reason}:refresh-on`);
                window.setTimeout(() => {
                    if (!this.room || !publication.track) return;
                    renderPublication(participant, publication, publication.track, Track);
                }, 900);
            }, 250);
        };

        const subscribePublication = (publication, participant = null, TrackRef = null, reason = 'subscribe') => {
            const participantId = String(participant?.identity || '').trim();
            const localParticipantId = String(this.room?.localParticipant?.identity || '').trim();
            if (!publication || !participantId || participantId === localParticipantId) return;
            logMediaDiagnostic('publication-subscribe-check', {
                reason,
                participant: summarizeParticipant(participant),
                publication: summarizePublication(publication)
            });
            if (publication.track) {
                renderPublication(participant, publication, publication.track, TrackRef);
            }

            if (publication.isSubscribed && publication.track) {
                const Track = TrackRef || window.LivekitClient?.Track || null;
                const isVideoTrack = Track
                    ? publication.kind === Track.Kind.Video
                    : publication.track.kind === 'video';
                const mediaStreamTrack = publication.track.mediaStreamTrack || null;
                const isStuckRemoteVideo = isVideoTrack
                    && !publication.isMuted
                    && mediaStreamTrack?.readyState === 'live'
                    && mediaStreamTrack.muted === true;
                if (isStuckRemoteVideo) {
                    refreshRemoteVideoSubscription(publication, participant, `${reason}:muted-track`);
                }
                return;
            }

            if (publication.isSubscribed && !publication.track) {
                window.setTimeout(() => {
                    if (publication.track) {
                        setPublicationSubscribed(publication, true, participant, `${reason}:ensure-on`);
                        return;
                    }
                    refreshRemoteVideoSubscription(publication, participant, `${reason}:missing-track`);
                }, 500);
                return;
            }

            setPublicationSubscribed(publication, true, participant, reason);
        };

        const subscribeParticipantPublications = (participant, TrackRef = null, reason = 'participant-sweep') => {
            if (!participant?.trackPublications?.values) return;
            for (const publication of participant.trackPublications.values()) {
                subscribePublication(publication, participant, TrackRef, reason);
            }
        };

        const subscribeRemotePublications = (TrackRef = null, reason = 'room-sweep') => {
            if (!this.room?.remoteParticipants?.values) return;
            for (const participant of this.room.remoteParticipants.values()) {
                subscribeParticipantPublications(participant, TrackRef, reason);
            }
        };

        const scheduleRemoteSubscriptionSweep = (TrackRef = null, reason = 'scheduled-sweep') => {
            for (const delay of [250, 1000, 2500, 5000]) {
                window.setTimeout(() => subscribeRemotePublications(TrackRef, `${reason}:${delay}`), delay);
            }
        };

        await this.roomController.connect(this.state.session, {
            onRoomCreated: ({ room }) => {
                this.room = room;
            },
            onConnecting: () => {
                this.state.roomState = 'Connecting';
                this.renderMeetingSummary();
            },
            onTrackSubscribed: (track, publication, participant, { Track }) => {
                logMediaDiagnostic('room-track-subscribed', {
                    participant: summarizeParticipant(participant),
                    publication: summarizePublication(publication),
                    track: summarizeTrack(track)
                });
                renderPublication(participant, publication, track, Track);
                this.syncParticipantsFromRoom(this.room, Track);
            },
            onTrackUnsubscribed: (_track, publication, participant, { Track }) => {
                logMediaDiagnostic('room-track-unsubscribed', {
                    participant: summarizeParticipant(participant),
                    publication: summarizePublication(publication),
                    track: summarizeTrack(_track)
                });
                removePublication(publication, Track, participant);
                this.syncParticipantsFromRoom(this.room, Track);
            },
            onLocalTrackPublished: (publication, { room, Track }) => {
                logMediaDiagnostic('room-local-track-published', {
                    publication: summarizePublication(publication)
                });
                renderPublication(room.localParticipant, publication, null, Track);
                if (publication?.source === Track?.Source?.Camera) {
                    void this.mediaController.syncBackgroundEffect().catch((error) => {
                        this.setError(error instanceof Error ? error.message : 'Background effect could not be applied.');
                    });
                }
                this.syncLocalMediaStateFromRoom(Track);
                this.renderMeetingSummary();
                this.syncParticipantsFromRoom(this.room, Track);
                scheduleRemoteSubscriptionSweep(Track, 'local-published');
            },
            onLocalTrackUnpublished: (publication, { Track }) => {
                logMediaDiagnostic('room-local-track-unpublished', {
                    publication: summarizePublication(publication)
                });
                removePublication(publication, Track, this.room?.localParticipant || null);
                this.syncLocalMediaStateFromRoom(Track);
                this.renderMeetingSummary();
                this.syncParticipantsFromRoom(this.room, Track);
                scheduleRemoteSubscriptionSweep(Track, 'local-unpublished');
            },
            onRemoteTrackPublished: (publication, participant, { Track }) => {
                logMediaDiagnostic('room-remote-track-published', {
                    participant: summarizeParticipant(participant),
                    publication: summarizePublication(publication)
                });
                subscribePublication(publication, participant, Track, 'remote-track-published');
                this.syncParticipantsFromRoom(this.room, Track);
                scheduleRemoteSubscriptionSweep(Track, 'remote-track-published');
            },
            onParticipantConnected: (participant, { Track }) => {
                this.playParticipantJoinSound(participant);
                subscribeParticipantPublications(participant, Track, 'participant-connected');
                this.syncParticipantsFromRoom(this.room, Track);
                void (async () => {
                    await this.loadMeetingDetails();
                    if (this.room) {
                        this.syncParticipantsFromRoom(this.room, Track);
                    }
                })().catch(() => {});
                scheduleRemoteSubscriptionSweep(Track, 'participant-connected');
            },
            onParticipantDisconnected: (participant, { Track }) => {
                this.playParticipantLeaveSound(participant);
                const participantId = String(participant?.identity || '').trim();
                if (participantId && this.state.activeSpeakerIds instanceof Set) {
                    this.state.activeSpeakerIds.delete(participantId);
                }
                for (const publication of participant.trackPublications.values()) {
                    removePublication(publication, Track, participant);
                }
                this.removeParticipantView(participant.identity);
                this.syncParticipantsFromRoom(this.room, Track);
            },
            onActiveSpeakersChanged: (participants, { Track }) => {
                this.setActiveSpeakers(participants, Track);
            },
            onTrackMuted: (publication, participant, { Track }) => {
                const participantId = String(participant?.identity || '').trim();
                if (!participantId) return;
                const isVideoTrack = publication?.kind === Track.Kind.Video;
                if (isVideoTrack) {
                    removePublication(publication, Track, participant);
                } else if (this.isMicrophonePublication(publication, Track, participant)) {
                    this.setParticipantMicState(participantId, false);
                }
                if (participantId === String(this.room?.localParticipant?.identity || '').trim()) {
                    this.syncLocalMediaStateFromRoom(Track);
                    this.renderMeetingSummary();
                }
            },
            onTrackUnmuted: (publication, participant, { Track }) => {
                const participantId = String(participant?.identity || '').trim();
                if (!participantId) return;
                const isVideoTrack = publication?.kind === Track.Kind.Video;
                if (isVideoTrack) {
                    renderPublication(participant, publication, publication?.track || null, Track);
                }
                if (this.isMicrophonePublication(publication, Track, participant)) {
                    const sourceParticipant = participantId === this.room?.localParticipant?.identity
                        ? this.room.localParticipant
                        : this.room?.remoteParticipants?.get?.(participantId) || participant;
                    this.setParticipantMicState(participantId, this.isParticipantMicOn(sourceParticipant, Track));
                }
                if (participantId === String(this.room?.localParticipant?.identity || '').trim()) {
                    this.syncLocalMediaStateFromRoom(Track);
                    this.renderMeetingSummary();
                }
                this.syncParticipantsFromRoom(this.room, Track);
            },
            onDataReceived: (payload, participant) => {
                try {
                    const text = new TextDecoder().decode(payload);
                    const data = JSON.parse(text);
                    this.emitWebMeetInternalEvent('livekit', data, {
                        participantId: String(participant?.identity || '').trim()
                    });
                } catch (err) {
                    // Ignore malformed data-channel messages from other clients.
                }
            },
            onDisconnected: () => {
                this.resetRoomUiState({ forceRenderAll: true, applyVideoFullscreenMode: false });
            },
            onConnected: ({ room, Track }) => {
                this.state.roomState = 'Connected';
                this.syncParticipantsFromRoom(this.room, Track);
                void (async () => {
                    await this.loadMeetingDetails();
                    if (this.room) {
                        this.syncParticipantsFromRoom(this.room, Track);
                    }
                })().catch(() => {});
                for (const participant of room.remoteParticipants.values()) {
                    subscribeParticipantPublications(participant, Track, 'connected');
                }
                scheduleRemoteSubscriptionSweep(Track, 'connected');
                this.startPresenceHeartbeat();
                this.startMeetingEvents();
                this.renderMeetingSummary();
            },
            onConnectError: (error) => {
                this.state.roomState = error instanceof Error ? error.message : String(error);
                this.stopPresenceHeartbeat();
                this.renderMeetingSummary();
            }
        });
    },

    resetRoomUiState(options = {}) {
        const forceRenderAll = Boolean(options.forceRenderAll);
        const applyVideoFullscreenMode = Boolean(options.applyVideoFullscreenMode);
        this.room = this.roomController.getRoom();
        this.stopPresenceHeartbeat();
        this.stopMeetingEvents();
        this.mediaController.reset();
        this.state.roomState = 'Disconnected';
        this.state.media = { microphone: false, camera: false, screen: false };
        this.state.mediaDeafened = false;
        this.state.mediaDeafenRestoreMicrophone = false;
        this.state.mediaLoading = { microphone: false, camera: false, screen: false };
        this.state.participants = [];
        this.state.activeSpeakerIds = new Set();
        this.state.videoGridFullscreen = false;
        this.participantLayoutController.clearAll('Join a meeting to attach media tracks.');
        if (applyVideoFullscreenMode) {
            this.applyVideoGridFullscreenMode();
        }
        if (forceRenderAll) {
            this.renderAll();
        } else {
            this.renderMeetingSummary();
            this.renderFeedLists();
        }
    },

    muteRoomPlaybackElements() {
        const mediaElements = [
            ...this.participantLayoutController.getTrackEntries()
                .filter((entry) => entry?.kind === 'audio' || entry?.kind === 'video')
                .map((entry) => entry.element)
                .filter(Boolean),
            ...Array.from(this.element?.querySelectorAll?.('audio, video') || [])
        ];
        for (const mediaElement of new Set(mediaElements)) {
            try { mediaElement.muted = true; } catch (_) {}
            try { mediaElement.volume = 0; } catch (_) {}
            try { mediaElement.pause?.(); } catch (_) {}
        }
    },

    unsubscribeRemotePublications(room = this.roomController.getRoom()) {
        for (const participant of room?.remoteParticipants?.values?.() || []) {
            for (const publication of participant?.trackPublications?.values?.() || []) {
                try {
                    const result = publication?.setSubscribed?.(false);
                    if (result && typeof result.catch === 'function') {
                        result.catch(() => {});
                    }
                } catch (_) {
                    // Ignore subscription changes rejected during disconnect.
                }
            }
        }
    },

    async stopRoomMediaBeforeDisconnect(room = this.roomController.getRoom()) {
        this.muteRoomPlaybackElements();
        this.unsubscribeRemotePublications(room);
        await this.mediaController.stopAllLocalMedia(room);
        this.state.mediaDeafened = true;
        this.state.mediaDeafenRestoreMicrophone = false;
        this.state.media = { microphone: false, camera: false, screen: false };
        this.state.mediaLoading = { microphone: false, camera: false, screen: false };
        this.renderMeetingSummary();
    },

    async disconnectRoom(options = {}) {
        const room = this.roomController.getRoom();
        if (!room) return;
        if (options.stopMediaFirst !== false) {
            await this.stopRoomMediaBeforeDisconnect(room);
        }
        await this.roomController.disconnect();
        this.resetRoomUiState({ forceRenderAll: true, applyVideoFullscreenMode: true });
    },

    async toggleMicrophone() {
        if (this.state.mediaDeafened && !this.state.media.microphone) {
            this.state.mediaDeafened = false;
            this.state.mediaDeafenRestoreMicrophone = false;
            this.applyOutputVolumePreviewToAllAudioElements();
        }
        await this.runMediaToggleWithLoading('microphone', () => this.mediaController.toggleMicrophone());
    },

    async toggleDeafen() {
        if (!this.state.session?.participantIdentity) return;
        if (Object.values(this.state.mediaLoading || {}).some(Boolean)) return;
        const shouldDeafen = !this.state.mediaDeafened;
        const shouldRestoreMicrophone = !shouldDeafen
            && Boolean(this.state.mediaDeafenRestoreMicrophone)
            && !this.state.media.microphone;
        if (shouldDeafen) {
            this.state.mediaDeafenRestoreMicrophone = Boolean(this.state.media.microphone);
        }
        this.state.mediaDeafened = shouldDeafen;
        this.applyOutputVolumePreviewToAllAudioElements();
        if (shouldDeafen && this.state.media.microphone) {
            await this.toggleMicrophone();
        } else if (shouldRestoreMicrophone) {
            try {
                await this.toggleMicrophone();
            } finally {
                this.state.mediaDeafenRestoreMicrophone = false;
            }
        } else {
            if (!shouldDeafen) {
                this.state.mediaDeafenRestoreMicrophone = false;
            }
            this.renderMeetingSummary();
        }
    },

    async toggleCamera() {
        await this.runMediaToggleWithLoading('camera', () => this.mediaController.toggleCamera());
    },

    async toggleScreenShare() {
        await this.runMediaToggleWithLoading('screen', () => this.mediaController.toggleScreenShare());
    },

    async waitForLocalVideoCardVisible(timeoutMs = 2500) {
        const start = Date.now();
        const localParticipantId = String(
            this.room?.localParticipant?.identity
            || this.state.session?.participantIdentity
            || ''
        ).trim();
        if (!localParticipantId) return false;

        while ((Date.now() - start) < timeoutMs) {
            const view = this.participantLayoutController.getParticipantView(localParticipantId);
            const videoElement = view?.videoElement || null;
            const videoReady = !videoElement
                || Number(videoElement.readyState || 0) >= 1
                || Boolean(videoElement.srcObject);
            if (view?.hasVideo && videoElement?.isConnected && videoReady) {
                return true;
            }
            await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
        return false;
    },

    setLocalVideoCardLoading(isLoading) {
        const localParticipantId = String(
            this.room?.localParticipant?.identity
            || this.state.session?.participantIdentity
            || ''
        ).trim();
        if (!localParticipantId) return;
        this.participantLayoutController.setParticipantVideoLoading(localParticipantId, isLoading);
    },

    async runMediaToggleWithLoading(type, action) {
        if (Object.values(this.state.mediaLoading || {}).some(Boolean)) {
            return;
        }
        const shouldWaitForLocalVideo = (type === 'camera' || type === 'screen')
            && !this.mediaController.isLocalSourceEnabled(type);
        this.setMediaLoading(type, true);
        if (shouldWaitForLocalVideo) {
            this.setLocalVideoCardLoading(true);
        }
        let localVideoVisible = false;
        try {
            await action();
            if (shouldWaitForLocalVideo && this.mediaController.isLocalSourceEnabled(type)) {
                localVideoVisible = await this.waitForLocalVideoCardVisible();
            }
        } finally {
            const sourceStillEnabled = shouldWaitForLocalVideo && this.mediaController.isLocalSourceEnabled(type);
            if (shouldWaitForLocalVideo && (!sourceStillEnabled || localVideoVisible)) {
                this.setLocalVideoCardLoading(false);
            }
            this.setMediaLoading(type, false);
        }
    }

};
