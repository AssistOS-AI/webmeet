function getParticipantUserIdFromParticipant(participant = null) {
    return String(
        participant?.userId
        || participant?.attributes?.ploinkyUserId
        || participant?.attributes?.workspaceUserId
        || participant?.attributes?.userId
        || participant?.attributes?.webmeetUserId
        || ''
    ).trim();
}

function getAvatarUpdatedAtMs(profileAvatar = null) {
    const value = String(profileAvatar?.updatedAt || '').trim();
    if (!value) return 0;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
}

function rememberProfileAvatar(avatarByUserId, userId, profileAvatar = null) {
    const normalizedUserId = String(userId || '').trim();
    if (!normalizedUserId || !profileAvatar || typeof profileAvatar !== 'object') return;
    const existing = avatarByUserId[normalizedUserId];
    if (!existing) {
        avatarByUserId[normalizedUserId] = profileAvatar;
        return;
    }
    const existingUpdatedAt = getAvatarUpdatedAtMs(existing);
    const nextUpdatedAt = getAvatarUpdatedAtMs(profileAvatar);
    if (!existingUpdatedAt || !nextUpdatedAt || nextUpdatedAt >= existingUpdatedAt) {
        avatarByUserId[normalizedUserId] = profileAvatar;
    }
}

export const participantViewMethods = {
    getParticipantUserId: getParticipantUserIdFromParticipant,

    applyRealtimeParticipantAvatar(data = {}) {
        const participantId = String(data?.participantId || '').trim();
        const userId = String(data?.userId || '').trim();
        const profileAvatar = data?.profileAvatar && typeof data.profileAvatar === 'object'
            ? data.profileAvatar
            : null;
        if (!profileAvatar || (!participantId && !userId)) return false;
        const avatarByUserId = {
            ...(this.state.participantProfileAvatarsByUserId && typeof this.state.participantProfileAvatarsByUserId === 'object'
                ? this.state.participantProfileAvatarsByUserId
                : {})
        };
        const updateCache = (nextUserId) => {
            rememberProfileAvatar(avatarByUserId, nextUserId, profileAvatar);
        };
        updateCache(userId);
        let changed = false;
        this.state.participants = (Array.isArray(this.state.participants) ? this.state.participants : []).map((entry) => {
            const entryUserId = getParticipantUserIdFromParticipant(entry);
            const matches = (participantId && String(entry?.id || entry?.identity || '').trim() === participantId)
                || (userId && entryUserId === userId);
            if (!matches) return entry;
            changed = true;
            updateCache(entryUserId);
            return {
                ...entry,
                profileAvatar
            };
        });
        this.state.participantProfileAvatarsByUserId = avatarByUserId;
        for (const view of this.participantLayoutController?.getViews?.() || []) {
            const viewUserId = String(view?.avatarUserId || '').trim();
            const matches = (participantId && String(view?.id || '').trim() === participantId)
                || (userId && viewUserId === userId);
            if (!matches) continue;
            changed = true;
            view.avatarEnabled = profileAvatar.enabled !== false;
            view.avatarConfig = view.avatarEnabled ? profileAvatar.config || null : null;
            view.avatarFallbackLetter = profileAvatar.fallbackLetter || view.avatarFallbackLetter || '';
            view.avatarResolved = true;
            this.applyParticipantViewState(view);
        }
        return changed;
    },

    cacheParticipantProfileAvatars(participants = []) {
        const avatarByUserId = {
            ...(this.state.participantProfileAvatarsByUserId && typeof this.state.participantProfileAvatarsByUserId === 'object'
                ? this.state.participantProfileAvatarsByUserId
                : {})
        };
        for (const participant of Array.isArray(participants) ? participants : []) {
            const userId = getParticipantUserIdFromParticipant(participant);
            rememberProfileAvatar(avatarByUserId, userId, participant?.profileAvatar);
        }
        this.state.participantProfileAvatarsByUserId = avatarByUserId;
    },

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

    getParticipantAvatarUserId(participant) {
        if (participant?.kind === 'local') {
            return 'me';
        }
        const attributes = participant?.attributes && typeof participant.attributes === 'object'
            ? participant.attributes
            : {};
        const identity = String(participant?.identity || participant?.id || '').trim();
        const storedParticipant = Array.isArray(this.state.participants)
            ? this.state.participants.find((entry) => String(entry?.id || '').trim() === identity)
            : null;
        const storedAttributes = storedParticipant?.attributes && typeof storedParticipant.attributes === 'object'
            ? storedParticipant.attributes
            : {};
        const candidates = [
            attributes.ploinkyUserId,
            attributes.workspaceUserId,
            attributes.userId,
            attributes.webmeetUserId,
            storedAttributes.ploinkyUserId,
            storedAttributes.workspaceUserId,
            storedAttributes.userId,
            storedAttributes.webmeetUserId,
            storedParticipant?.userId
        ];
        return String(candidates.find((value) => String(value || '').trim()) || '').trim();
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
        const storedById = new Map(
            (Array.isArray(this.state.participants) ? this.state.participants : [])
                .map((entry) => [String(entry?.id || '').trim(), entry])
                .filter(([id]) => id)
        );
        const avatarByUserId = {
            ...(this.state.participantProfileAvatarsByUserId && typeof this.state.participantProfileAvatarsByUserId === 'object'
                ? this.state.participantProfileAvatarsByUserId
                : {})
        };
        const getStoredUserId = getParticipantUserIdFromParticipant;
        for (const entry of storedById.values()) {
            const userId = getStoredUserId(entry);
            rememberProfileAvatar(avatarByUserId, userId, entry?.profileAvatar);
        }
        const mergeStoredAttributes = (identity, livekitAttributes = {}) => {
            const stored = storedById.get(String(identity || '').trim()) || null;
            const storedAttributes = stored?.attributes && typeof stored.attributes === 'object'
                ? stored.attributes
                : {};
            const userId = String(stored?.userId || '').trim();
            return {
                ...storedAttributes,
                ...(userId ? {
                    webmeetUserId: userId,
                    userId,
                    workspaceUserId: userId,
                    ploinkyUserId: userId
                } : {}),
                ...(livekitAttributes && typeof livekitAttributes === 'object' ? livekitAttributes : {})
            };
        };
        const getStoredProfileAvatar = (identity, userId = '') => {
            const stored = storedById.get(String(identity || '').trim()) || null;
            const normalizedUserId = String(userId || '').trim();
            if (normalizedUserId && avatarByUserId[normalizedUserId] && typeof avatarByUserId[normalizedUserId] === 'object') {
                return avatarByUserId[normalizedUserId];
            }
            if (stored?.profileAvatar && typeof stored.profileAvatar === 'object') {
                return stored.profileAvatar;
            }
            return null;
        };
        const localIdentity = room.localParticipant?.identity || this.state.session?.participantIdentity || '';
        const isSpeaking = (identity) => this.isParticipantSpeaking?.(identity) === true;
        const localAttributes = mergeStoredAttributes(
            localIdentity,
            room.localParticipant?.attributes || {}
        );
        const localUserId = String(
            storedById.get(String(localIdentity || '').trim())?.userId
            || localAttributes.ploinkyUserId
            || localAttributes.workspaceUserId
            || localAttributes.userId
            || localAttributes.webmeetUserId
            || ''
        ).trim();
        const items = [{
            id: localIdentity,
            identity: localIdentity,
            displayName: room.localParticipant?.name || this.state.session?.participant?.displayName || 'You',
            name: room.localParticipant?.name || this.state.session?.participant?.displayName || 'You',
            attributes: localAttributes,
            userId: localUserId,
            profileAvatar: getStoredProfileAvatar(localIdentity, localUserId),
            isSpeaking: isSpeaking(localIdentity),
            kind: 'local'
        }];
        for (const participant of room.remoteParticipants.values()) {
            const identity = participant.identity || '';
            const attributes = mergeStoredAttributes(identity, participant.attributes || {});
            const userId = String(
                storedById.get(String(identity || '').trim())?.userId
                || attributes.ploinkyUserId
                || attributes.workspaceUserId
                || attributes.userId
                || attributes.webmeetUserId
                || ''
            ).trim();
            items.push({
                id: identity,
                identity,
                displayName: participant.name || participant.identity || 'Remote',
                name: participant.name || participant.identity || 'Remote',
                attributes,
                userId,
                profileAvatar: getStoredProfileAvatar(identity, userId),
                isSpeaking: isSpeaking(identity),
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
        for (const item of items) {
            const userId = getStoredUserId(item);
            rememberProfileAvatar(avatarByUserId, userId, item?.profileAvatar);
        }
        this.state.participantProfileAvatarsByUserId = avatarByUserId;
        if (this.selectedMeeting?.id) {
            this.state.meetingParticipantsById[this.selectedMeeting.id] = items.map((entry) => ({
                id: entry.identity,
                name: entry.name,
                isAgent: Boolean(this.getAgentForParticipant(entry)),
                isSpeaking: Boolean(entry.isSpeaking),
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

    isParticipantSpeaking(participantId) {
        const id = String(participantId || '').trim();
        return Boolean(id && this.state.activeSpeakerIds instanceof Set && this.state.activeSpeakerIds.has(id));
    },

    setActiveSpeakers(participants = [], Track = globalThis.LivekitClient?.Track || null) {
        const next = new Set();
        for (const participant of Array.isArray(participants) ? participants : []) {
            const identity = String(participant?.identity || '').trim();
            if (identity) next.add(identity);
        }
        this.state.activeSpeakerIds = next;
        this.syncParticipantsFromRoom(this.room, Track);
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
