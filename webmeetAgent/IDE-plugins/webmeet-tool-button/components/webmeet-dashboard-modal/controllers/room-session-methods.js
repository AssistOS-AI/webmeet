export const roomSessionMethods = {
    async connectRoom() {
        if (!this.state.session?.participantToken || !this.state.session?.livekitUrl) {
            this.state.roomState = 'Join payload missing media token';
            this.renderMeetingSummary();
            return;
        }
        await this.disconnectRoom();

        const remoteVideoRefreshCounts = new WeakMap();

        const isRemoteVideoElementReady = (mediaElement) => {
            if (!mediaElement) return false;
            return Number(mediaElement.videoWidth || 0) > 0
                || Number(mediaElement.videoHeight || 0) > 0
                || Number(mediaElement.currentTime || 0) > 0
                || Number(mediaElement.readyState || 0) >= HTMLMediaElement.HAVE_CURRENT_DATA;
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

            if (track.kind === Track.Kind.Video) {
                const mediaElement = track.attach();
                mediaElement.autoplay = true;
                mediaElement.playsInline = true;
                const isLocalParticipant = participantId === this.room?.localParticipant?.identity;
                if (isLocalParticipant) {
                    mediaElement.muted = true;
                }
                this.attachVideoTrack(participantId, trackId, mediaElement);
                if (!isLocalParticipant) {
                    scheduleRemoteVideoReadinessCheck(participant, publication, mediaElement, Track, 'render-video');
                }
            } else if (track.kind === Track.Kind.Audio) {
                const isLocalParticipant = participantId === this.room?.localParticipant?.identity;
                if (!isLocalParticipant) {
                    const mediaElement = track.attach();
                    mediaElement.autoplay = true;
                    void this.applyAudioOutputDeviceToElement(mediaElement);
                    this.attachAudioTrack(participantId, trackId, mediaElement);
                    this.applyOutputVolumePreviewToElement(mediaElement);
                }
                this.setParticipantMicState(participantId, !publication.isMuted);
            }
        };

        const removePublication = (publication, TrackRef = null) => {
            const Track = TrackRef || window.LivekitClient?.Track;
            const trackId = String(publication?.trackSid || '').trim();
            if (!trackId) return;
            const trackInfo = this.participantLayoutController.getTrackEntry(trackId);
            this.removeTrack(trackId);
            if (Track && (trackInfo?.kind === 'audio' || publication.kind === Track.Kind.Audio)) {
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
            try {
                const result = publication.setSubscribed(shouldSubscribe);
                if (result && typeof result.catch === 'function') {
                    result.catch(() => {});
                }
            } catch (error) {
                // LiveKit may reject subscription changes during disconnect/reconnect.
            }
        };

        const refreshRemoteVideoSubscription = (publication, participant, reason) => {
            if (!publication || typeof publication.setSubscribed !== 'function') return;
            const refreshCount = remoteVideoRefreshCounts.get(publication) || 0;
            if (refreshCount >= 2) return;
            remoteVideoRefreshCounts.set(publication, refreshCount + 1);
            setPublicationSubscribed(publication, false, participant, `${reason}:refresh-off`);
            window.setTimeout(() => {
                setPublicationSubscribed(publication, true, participant, `${reason}:refresh-on`);
            }, 900);
        };

        const scheduleRemoteVideoReadinessCheck = (participant, publication, mediaElement, TrackRef = null, reason = 'remote-video') => {
            const Track = TrackRef || window.LivekitClient?.Track || null;
            const isVideoTrack = Track
                ? publication?.kind === Track.Kind.Video
                : publication?.track?.kind === 'video';
            if (!publication || !mediaElement || !isVideoTrack) return;

            for (const delay of [1500, 3500, 7000]) {
                window.setTimeout(() => {
                    if (!this.room || isRemoteVideoElementReady(mediaElement) || publication.isMuted) return;
                    const mediaStreamTrack = publication.track?.mediaStreamTrack || null;
                    if (mediaStreamTrack && mediaStreamTrack.readyState !== 'live') return;
                    refreshRemoteVideoSubscription(publication, participant, `${reason}:${delay}`);
                }, delay);
            }
        };

        const subscribePublication = (publication, participant = null, TrackRef = null, reason = 'subscribe') => {
            const participantId = String(participant?.identity || '').trim();
            const localParticipantId = String(this.room?.localParticipant?.identity || '').trim();
            if (!publication || !participantId || participantId === localParticipantId) return;
            const Track = TrackRef || window.LivekitClient?.Track || null;

            if (publication.track) {
                renderPublication(participant, publication, publication.track, TrackRef);
            }

            if (publication.isSubscribed && publication.track) {
                const mediaStreamTrack = publication.track.mediaStreamTrack || null;
                const isVideoTrack = Track
                    ? publication.kind === Track.Kind.Video
                    : publication.track.kind === 'video';
                const isStuckRemoteVideo = isVideoTrack
                    && !publication.isMuted
                    && mediaStreamTrack?.readyState === 'live'
                    && mediaStreamTrack.muted === true;
                if (isStuckRemoteVideo) {
                    refreshRemoteVideoSubscription(publication, participant, `${reason}:muted`);
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
                renderPublication(participant, publication, track, Track);
                this.syncParticipantsFromRoom(this.room, Track);
            },
            onTrackUnsubscribed: (_track, publication, _participant, { Track }) => {
                removePublication(publication, Track);
                this.syncParticipantsFromRoom(this.room, Track);
            },
            onLocalTrackPublished: (publication, { room, Track }) => {
                renderPublication(room.localParticipant, publication, null, Track);
                this.syncLocalMediaStateFromRoom(Track);
                this.renderMeetingSummary();
                this.syncParticipantsFromRoom(this.room, Track);
                scheduleRemoteSubscriptionSweep(Track, 'local-published');
            },
            onLocalTrackUnpublished: (publication, { Track }) => {
                removePublication(publication, Track);
                this.syncLocalMediaStateFromRoom(Track);
                this.renderMeetingSummary();
                this.syncParticipantsFromRoom(this.room, Track);
                scheduleRemoteSubscriptionSweep(Track, 'local-unpublished');
            },
            onRemoteTrackPublished: (publication, participant, { Track }) => {
                subscribePublication(publication, participant, Track, 'remote-track-published');
                this.syncParticipantsFromRoom(this.room, Track);
                scheduleRemoteSubscriptionSweep(Track, 'remote-track-published');
            },
            onParticipantConnected: (participant, { Track }) => {
                subscribeParticipantPublications(participant, Track, 'participant-connected');
                this.syncParticipantsFromRoom(this.room, Track);
                scheduleRemoteSubscriptionSweep(Track, 'participant-connected');
            },
            onParticipantDisconnected: (participant, { Track }) => {
                for (const publication of participant.trackPublications.values()) {
                    removePublication(publication, Track);
                }
                this.removeParticipantView(participant.identity);
                this.syncParticipantsFromRoom(this.room, Track);
            },
            onTrackMuted: (publication, participant, { Track }) => {
                const participantId = String(participant?.identity || '').trim();
                if (!participantId) return;
                const isVideoTrack = publication?.kind === Track.Kind.Video;
                if (isVideoTrack) {
                    removePublication(publication, Track);
                } else {
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
                const sourceParticipant = participantId === this.room?.localParticipant?.identity
                    ? this.room.localParticipant
                    : this.room?.remoteParticipants?.get?.(participantId) || participant;
                this.setParticipantMicState(participantId, this.isParticipantMicOn(sourceParticipant, Track));
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
                    if (data.type === 'chat' && data.meetingId === this.selectedMeeting?.id) {
                        if (!this.state.chat) this.state.chat = [];
                        this.state.chat.push(data.message);
                        this.renderFeedLists();
                    } else if (data.type === 'meeting.renamed') {
                        this.applyMeetingRename(data.meetingId, data.title, data.updatedAt || '');
                    }
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
        this.state.mediaLoading = { microphone: false, camera: false, screen: false };
        this.state.participants = [];
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

    async disconnectRoom() {
        if (!this.roomController.getRoom()) return;
        await this.roomController.disconnect();
        this.resetRoomUiState({ forceRenderAll: true, applyVideoFullscreenMode: true });
    },

    async toggleMicrophone() {
        await this.runMediaToggleWithLoading('microphone', () => this.mediaController.toggleMicrophone());
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
