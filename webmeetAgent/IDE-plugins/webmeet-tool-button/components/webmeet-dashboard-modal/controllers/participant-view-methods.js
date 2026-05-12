export const participantViewMethods = {
    getParticipantDisplayName(participant) {
        return String(
            participant?.name
            || participant?.displayName
            || participant?.identity
            || 'Participant'
        ).trim() || 'Participant';
    },

    getAgentForParticipant(participant) {
        const identity = String(participant?.identity || '').trim();
        if (!identity) return null;
        const attributes = participant?.attributes && typeof participant.attributes === 'object'
            ? participant.attributes
            : {};
        const meetingId = String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim();
        const activeAgents = Array.isArray(this.state.agents)
            ? this.state.agents.filter((entry) => entry && !entry.deletedAt && String(entry.status || '').trim() !== 'stopped')
            : [];
        return activeAgents.find((entry) => {
            const participantIdentity = String(entry.participantIdentity || entry.participant?.identity || '').trim();
            if (participantIdentity && participantIdentity === identity) {
                return true;
            }
            if (String(attributes.webmeetAgent || '').toLowerCase() !== 'true') {
                return false;
            }
            if (meetingId && String(attributes.webmeetMeetingId || '').trim() !== meetingId) {
                return false;
            }
            const agentType = String(entry.agentType || '').trim();
            const agentMode = String(entry.mode || '').trim();
            return String(attributes.webmeetAgentType || '').trim() === agentType
                && String(attributes.webmeetAgentMode || '').trim() === agentMode;
        }) || null;
    },

    setVideoGridEmptyState(message) {
        this.participantLayoutController.setVideoGridEmptyState(message);
    },

    syncVideoGridVisibility() {
        this.participantLayoutController.syncVideoGridVisibility();
    },

    applyParticipantViewState(view) {
        this.participantLayoutController.applyParticipantViewState(view);
    },

    upsertParticipantView(participant) {
        return this.participantLayoutController.upsertParticipantView(participant);
    },

    renderParticipantLayout() {
        this.participantLayoutController.renderParticipantLayout();
    },

    setFocusedParticipant(participantId) {
        this.participantLayoutController.setFocusedParticipant(participantId);
    },

    focusParticipantCard(target) {
        this.participantLayoutController.focusParticipantCard(target);
    },

    setParticipantMicState(participantId, isMicOn) {
        this.participantLayoutController.setParticipantMicState(participantId, isMicOn);
        const id = String(participantId || '').trim();
        if (!id) return;
        let updated = false;
        const nextMicState = Boolean(isMicOn);
        const map = this.state.meetingParticipantsById || {};
        for (const meetingId of Object.keys(map)) {
            const entries = Array.isArray(map[meetingId]) ? map[meetingId] : [];
            for (const entry of entries) {
                if (String(entry?.id || '').trim() !== id) continue;
                if (entry.micOn !== nextMicState) {
                    entry.micOn = nextMicState;
                    updated = true;
                }
            }
        }
        if (updated) {
            this.renderMeetingList();
        }
    },

    attachVideoTrack(participantId, trackSid, mediaElement) {
        this.participantLayoutController.attachVideoTrack(participantId, trackSid, mediaElement);
    },

    clearVideoTrack(trackSid) {
        this.participantLayoutController.clearVideoTrack(trackSid);
    },

    attachAudioTrack(participantId, trackSid, mediaElement) {
        this.participantLayoutController.attachAudioTrack(participantId, trackSid, mediaElement);
    },

    removeTrack(trackSid) {
        this.participantLayoutController.removeTrack(trackSid);
    },

    removeParticipantView(participantId) {
        this.participantLayoutController.removeParticipantView(participantId);
    },

    isParticipantMicOn(participant, Track) {
        if (!participant?.trackPublications?.values) return false;
        for (const publication of participant.trackPublications.values()) {
            if (!publication) continue;
            const isAudioKind = publication.kind === Track.Kind.Audio;
            const isMicSource = publication.source === Track.Source.Microphone;
            if (isAudioKind || isMicSource) {
                return !publication.isMuted;
            }
        }
        return false;
    },

    syncParticipantsFromRoom(room, Track) {
        if (!room) return;
        const items = [{
            identity: room.localParticipant?.identity || this.state.session?.participantIdentity || '',
            name: room.localParticipant?.name || this.state.session?.participant?.displayName || 'You',
            attributes: room.localParticipant?.attributes || {},
            kind: 'local'
        }];
        for (const participant of room.remoteParticipants.values()) {
            items.push({
                identity: participant.identity || '',
                name: participant.name || participant.identity || 'Remote',
                attributes: participant.attributes || {},
                kind: 'remote'
            });
        }

        const keep = new Set();
        for (const item of items) {
            const id = String(item.identity || '').trim();
            if (!id) continue;
            keep.add(id);
            const view = this.upsertParticipantView(item);
            if (!view) continue;
            const sourceParticipant = item.kind === 'local' ? room.localParticipant : room.remoteParticipants.get(id);
            view.micOn = this.isParticipantMicOn(sourceParticipant, Track);
            this.applyParticipantViewState(view);
        }

        for (const participantId of this.participantLayoutController.getParticipantIds()) {
            if (!keep.has(participantId)) {
                this.removeParticipantView(participantId);
            }
        }

        this.state.participants = items;
        if (this.selectedMeeting?.id) {
            this.state.meetingParticipantsById[this.selectedMeeting.id] = items.map((entry) => ({
                id: entry.identity,
                name: entry.name,
                isAgent: Boolean(this.getAgentForParticipant(entry)),
                micOn: Boolean(
                    this.participantLayoutController
                        .getParticipantView?.(entry.identity)
                        ?.micOn
                )
            })).filter((entry) => entry.id);
            this.renderMeetingList();
        }
        this.renderParticipantLayout();
        this.syncLocalMediaStateFromRoom(Track);
        this.renderFeedLists();
    },

    syncLocalMediaStateFromRoom(TrackRef = null) {
        this.mediaController.syncLocalMediaStateFromRoom(TrackRef);
    },

    setMediaLoading(type, value) {
        const mediaType = String(type || '').trim();
        if (!Object.prototype.hasOwnProperty.call(this.state.mediaLoading, mediaType)) {
            return;
        }
        this.state.mediaLoading = {
            ...this.state.mediaLoading,
            [mediaType]: Boolean(value)
        };
        this.renderMeetingSummary();
    }

};
