import { isMicrophonePublication } from '../services/microphone-publication.js';
import { buildWebMeetAvatarSource } from '../services/webmeet-avatar-override.js';

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

function parseLiveKitProfileAvatar(attributes = {}) {
    const raw = String(attributes?.webmeetProfileAvatar || '').trim();
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : null;
    } catch (_) {
        return null;
    }
}

function normalizeProfileAvatar(profileAvatar = null) {
    return profileAvatar && typeof profileAvatar === 'object' && !Array.isArray(profileAvatar)
        ? profileAvatar
        : null;
}

function ensureRoomAvatarMap(owner) {
    if (!owner.state || typeof owner.state !== 'object') {
        owner.state = {};
    }
    if (
        !owner.state.roomAvatarsByParticipantId
        || typeof owner.state.roomAvatarsByParticipantId !== 'object'
        || Array.isArray(owner.state.roomAvatarsByParticipantId)
    ) {
        owner.state.roomAvatarsByParticipantId = {};
    }
    return owner.state.roomAvatarsByParticipantId;
}

function avatarSignature(profileAvatar = null) {
    try {
        return JSON.stringify(profileAvatar || null);
    } catch (_) {
        return '';
    }
}

function applyProfileAvatarToView(owner, view, profileAvatar) {
    const avatar = normalizeProfileAvatar(profileAvatar);
    if (!view || !avatar) return false;
    view.avatarEnabled = avatar.enabled !== false;
    view.avatarConfig = view.avatarEnabled && avatar.config && typeof avatar.config === 'object'
        ? avatar.config
        : null;
    view.avatarFallbackLetter = avatar.fallbackLetter || view.avatarFallbackLetter || '';
    view.avatarResolved = true;
    view.avatarSource = 'projected';
    owner.applyParticipantAvatarState?.(view);
    return true;
}

function setRoomAvatarFor(owner, participantId, profileAvatar) {
    const id = String(participantId || '').trim();
    const avatar = normalizeProfileAvatar(profileAvatar);
    if (!id || !avatar) return false;
    const roomAvatars = ensureRoomAvatarMap(owner);
    const previous = roomAvatars[id] || null;
    roomAvatars[id] = avatar;
    return avatarSignature(previous) !== avatarSignature(avatar);
}

function getRoomAvatarFor(owner, participantId) {
    const id = String(participantId || '').trim();
    if (!id) return null;
    return normalizeProfileAvatar(ensureRoomAvatarMap(owner)[id]);
}

function clearRoomAvatarFor(owner, participantId) {
    const id = String(participantId || '').trim();
    if (!id) return false;
    const roomAvatars = ensureRoomAvatarMap(owner);
    if (!Object.prototype.hasOwnProperty.call(roomAvatars, id)) return false;
    delete roomAvatars[id];
    return true;
}

export const participantViewMethods = {
    getParticipantUserId: getParticipantUserIdFromParticipant,

    setRoomAvatar(participantId, profileAvatar) {
        return setRoomAvatarFor(this, participantId, profileAvatar);
    },

    getRoomAvatar(participantId) {
        return getRoomAvatarFor(this, participantId);
    },

    clearRoomAvatar(participantId) {
        return clearRoomAvatarFor(this, participantId);
    },

    applyRealtimeParticipantAvatar(data = {}) {
        const participantId = String(data?.participantId || '').trim();
        const userId = String(data?.userId || '').trim();
        const profileAvatar = normalizeProfileAvatar(data?.profileAvatar);
        if (!profileAvatar || (!participantId && !userId)) return false;

        const matchedParticipantIds = new Set();
        if (participantId) {
            matchedParticipantIds.add(participantId);
        }
        for (const entry of Array.isArray(this.state.participants) ? this.state.participants : []) {
            const entryUserId = getParticipantUserIdFromParticipant(entry);
            const matches = (participantId && String(entry?.id || entry?.identity || '').trim() === participantId)
                || (userId && entryUserId === userId);
            if (matches) {
                const id = String(entry?.id || entry?.identity || '').trim();
                if (id) matchedParticipantIds.add(id);
            }
        }
        const sessionParticipantId = String(this.state.session?.participantIdentity || '').trim();
        const sessionUserId = String(this.currentActor?.id || this.state.session?.participant?.userId || '').trim();
        if (
            sessionParticipantId
            && (
                (participantId && sessionParticipantId === participantId)
                || (userId && sessionUserId && sessionUserId === userId)
            )
        ) {
            matchedParticipantIds.add(sessionParticipantId);
        }
        for (const view of this.participantLayoutController?.getViews?.() || []) {
            const viewUserId = String(view?.avatarUserId || '').trim();
            const matches = (participantId && String(view?.id || '').trim() === participantId)
                || (userId && viewUserId === userId);
            if (matches) {
                const id = String(view?.id || '').trim();
                if (id) matchedParticipantIds.add(id);
            }
        }
        let changed = false;
        for (const id of matchedParticipantIds) {
            const roomAvatarChanged = setRoomAvatarFor(this, id, profileAvatar);
            changed = roomAvatarChanged || changed;
            const view = this.participantLayoutController?.getParticipantView?.(id)
                || (this.participantLayoutController?.getViews?.() || [])
                    .find((entry) => String(entry?.id || '').trim() === id);
            if (roomAvatarChanged || view?.avatarSource !== 'projected') {
                changed = applyProfileAvatarToView(this, view, profileAvatar) || changed;
            }
        }
        return changed;
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

    applyParticipantAvatarState(view) {
        this.participantLayoutController.applyParticipantAvatarState(view);
    },

    upsertParticipantView(participant) {
        const participantId = String(participant?.identity || participant?.id || '').trim();
        const profileAvatar = normalizeProfileAvatar(participant?.profileAvatar)
            || getRoomAvatarFor(this, participantId);
        return this.participantLayoutController.upsertParticipantView({
            ...(participant && typeof participant === 'object' ? participant : {}),
            ...(profileAvatar ? { profileAvatar } : {})
        });
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
        this.remoteAudioNormalizer?.start?.(mediaElement, participantId);
    },

    removeTrack(trackSid) {
        const trackEntry = this.participantLayoutController.getTrackEntry(trackSid);
        if (trackEntry?.kind === 'audio' && trackEntry.element) {
            this.remoteAudioNormalizer?.stop?.(trackEntry.element);
        }
        this.participantLayoutController.removeTrack(trackSid);
    },

    removeParticipantView(participantId) {
        this.remoteAudioNormalizer?.stopParticipant?.(participantId);
        this.participantLayoutController.removeParticipantView(participantId);
    },

    getActiveCustomMicrophoneTrackForParticipant(participant = null) {
        const participantIdentity = String(participant?.identity || '').trim();
        const localIdentity = String(
            this.room?.localParticipant?.identity
            || this.state.session?.participantIdentity
            || ''
        ).trim();
        if (!participantIdentity || !localIdentity || participantIdentity !== localIdentity) {
            return null;
        }
        return this.mediaController?.activeMicrophoneCapture?.track || null;
    },

    isMicrophonePublication(publication, Track, participant = null) {
        return isMicrophonePublication(publication, Track, {
            allowLocalCustomFallback: true,
            activeMicrophoneTrack: this.getActiveCustomMicrophoneTrackForParticipant(participant)
        });
    },

    isParticipantMicOn(participant, Track) {
        if (!participant?.trackPublications?.values) return false;
        for (const publication of participant.trackPublications.values()) {
            if (!publication) continue;
            if (this.isMicrophonePublication(publication, Track, participant) && !publication.isMuted) {
                return true;
            }
        }
        return false;
    },

    syncParticipantsFromRoom(room, Track) {
        if (!room) return;
        const currentParticipants = Array.isArray(this.state.participants) ? this.state.participants : [];
        const storedById = new Map(
            currentParticipants
                .map((entry) => [String(entry?.id || '').trim(), entry])
                .filter(([id]) => id)
        );
        const mergeStoredAttributes = (identity, livekitAttributes = {}) => {
            const stored = storedById.get(String(identity || '').trim()) || null;
            const storedAttributes = stored?.attributes && typeof stored.attributes === 'object'
                ? stored.attributes
                : {};
            const { webmeetProfileAvatar: _storedProfileAvatarAttribute, ...safeStoredAttributes } = storedAttributes;
            const userId = String(stored?.userId || '').trim();
            return {
                ...safeStoredAttributes,
                ...(userId ? {
                    webmeetUserId: userId,
                    userId,
                    workspaceUserId: userId,
                    ploinkyUserId: userId
                } : {}),
                ...(livekitAttributes && typeof livekitAttributes === 'object' ? livekitAttributes : {})
            };
        };
        const localIdentity = room.localParticipant?.identity || this.state.session?.participantIdentity || '';
        const isSpeaking = (identity) => this.isParticipantSpeaking?.(identity) === true;
        const localAttributes = mergeStoredAttributes(
            localIdentity,
            room.localParticipant?.attributes || {}
        );
        const sessionParticipant = this.state.session?.participant && typeof this.state.session.participant === 'object'
            ? this.state.session.participant
            : null;
        const sessionParticipantId = String(
            this.state.session?.participantIdentity
            || sessionParticipant?.identity
            || sessionParticipant?.id
            || ''
        ).trim();
        const storedLocalParticipant = storedById.get(String(localIdentity || '').trim()) || null;
        const sessionMatchesLocal = Boolean(localIdentity && sessionParticipantId === String(localIdentity || '').trim());
        const localStoredParticipant = storedLocalParticipant && sessionMatchesLocal
            ? {
                ...sessionParticipant,
                ...storedLocalParticipant,
                attributes: {
                    ...(sessionParticipant?.attributes && typeof sessionParticipant.attributes === 'object'
                        ? sessionParticipant.attributes
                        : {}),
                    ...(storedLocalParticipant.attributes && typeof storedLocalParticipant.attributes === 'object'
                        ? storedLocalParticipant.attributes
                        : {})
                }
            }
            : (storedLocalParticipant || (sessionMatchesLocal ? sessionParticipant : null) || null);
        const localUserId = String(
            localStoredParticipant?.userId
            || localAttributes.ploinkyUserId
            || localAttributes.workspaceUserId
            || localAttributes.userId
            || localAttributes.webmeetUserId
            || ''
        ).trim();
        const localProfileSourceAvatar = normalizeProfileAvatar(
            localStoredParticipant?.profileAvatar
            || sessionParticipant?.profileAvatar
        );
        const localLiveKitAvatar = parseLiveKitProfileAvatar(localAttributes);
        if (localIdentity) {
            const currentLocalRoomAvatar = getRoomAvatarFor(this, localIdentity);
            const localSourceAvatar = buildWebMeetAvatarSource({
                profileAvatar: localProfileSourceAvatar || localLiveKitAvatar || currentLocalRoomAvatar,
                override: this.state.webMeetAvatarOverride || null,
                userId: localUserId,
                participantId: localIdentity
            });
            const effectiveLocalAvatar = this.webMeetRoom?.buildAvatarProjection
                ? this.webMeetRoom.buildAvatarProjection(localSourceAvatar, localIdentity)
                : localSourceAvatar;
            if (effectiveLocalAvatar) {
                setRoomAvatarFor(this, localIdentity, effectiveLocalAvatar);
            }
        }
        const items = [{
            id: localIdentity,
            identity: localIdentity,
            displayName: room.localParticipant?.name || this.state.session?.participant?.displayName || 'You',
            name: room.localParticipant?.name || this.state.session?.participant?.displayName || 'You',
            attributes: localAttributes,
            userId: localUserId,
            profileAvatar: getRoomAvatarFor(this, localIdentity),
            isSpeaking: isSpeaking(localIdentity),
            kind: 'local'
        }];
        for (const participant of room.remoteParticipants.values()) {
            const identity = participant.identity || '';
            const attributes = mergeStoredAttributes(identity, participant.attributes || {});
            const storedParticipant = storedById.get(String(identity || '').trim()) || null;
            const liveKitAvatar = parseLiveKitProfileAvatar(attributes);
            if (liveKitAvatar && !getRoomAvatarFor(this, identity)) {
                setRoomAvatarFor(this, identity, liveKitAvatar);
            }
            const userId = String(
                storedParticipant?.userId
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
                profileAvatar: getRoomAvatarFor(this, identity),
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
            view.micOn = Track
                ? this.isParticipantMicOn(sourceParticipant, Track)
                : Boolean(view.micOn);
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
