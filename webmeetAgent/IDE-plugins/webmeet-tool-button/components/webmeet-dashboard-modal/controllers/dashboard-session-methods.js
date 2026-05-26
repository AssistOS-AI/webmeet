import {
    buildStableParticipantId,
    createParticipantInstanceId,
    isAdminActor,
    readGuestSessionFromUrl
} from '../services/dashboard-utils.js';

export const dashboardSessionMethods = {
    async bootstrap() {
        try {
            const guestSession = readGuestSessionFromUrl();
            if (guestSession?.meeting?.id && guestSession?.participantToken) {
                await this.bootstrapGuestSession(guestSession);
                return;
            }
            await this.loadWorkspaces();
            this.state.selectedWorkspaceId = this.state.workspaces[0]?.id || '';
            if (this.state.selectedWorkspaceId) {
                await this.loadMeetings();
                this.startWorkspaceEvents();
            }
            this.renderAll();
        } catch (error) {
            this.setError(error instanceof Error ? error.message : String(error));
        }
    },

    async bootstrapGuestSession(session) {
        await this.guestManager.bootstrapGuestSession(session);
        void this.publishCurrentParticipantAvatar({ force: true }).catch((error) => {
            const message = error instanceof Error ? error.message : String(error || 'Avatar publish failed.');
            this.setError(`Joined room, but WebMeet could not publish the avatar: ${message}`);
        });
    },

    canManageRooms() {
        if (typeof this.state.canManageRooms === 'boolean') {
            return this.state.canManageRooms;
        }
        return isAdminActor(this.currentActor);
    },

    isGuestSession() {
        if (this.guestManager && typeof this.guestManager.isGuestSession === 'function') {
            return this.guestManager.isGuestSession();
        }
        const session = this.state?.session;
        return session?.guest === true || Boolean(session?.publicApiBaseUrl);
    },

    getGuestToken() {
        return String(this.state.session?.guestToken || '').trim();
    },

    async callPublicGuestApi(meetingId, action, body = {}) {
        return this.guestManager.callPublicGuestApi(meetingId, action, body);
    },

    registerWindowPresenceHandlers() {
        this.presenceController.registerWindowHandlers();
    },

    unregisterWindowPresenceHandlers() {
        this.presenceController.unregisterWindowHandlers();
    },

    sendLeaveKeepalive(meetingId, participantId) {
        this.presenceController.sendLeaveKeepalive(meetingId, participantId);
    },

    getStableParticipantId(displayName = '') {
        if (this.cachedStableParticipantId) {
            return this.cachedStableParticipantId;
        }
        const userEmail = String(window?.assistOS?.user?.email || '').trim();
        const baseSeed = userEmail || (String(displayName || 'user').trim() || 'user');
        const sessionKey = 'webmeet.participant.instanceId';
        try {
            let instanceId = String(window?.sessionStorage?.getItem(sessionKey) || '').trim();
            if (!instanceId) {
                instanceId = createParticipantInstanceId();
                window?.sessionStorage?.setItem(sessionKey, instanceId);
            }
            const created = buildStableParticipantId(`${baseSeed}-${instanceId}`);
            this.cachedStableParticipantId = created;
            return created;
        } catch {
            this.cachedStableParticipantId = buildStableParticipantId(`${baseSeed}-${createParticipantInstanceId()}`);
            return this.cachedStableParticipantId;
        }
    },

    removeParticipantFromMeetingList(meetingId, participantId) {
        this.meetingListController.removeParticipantFromMeetingMap(
            this.state.meetingParticipantsById,
            meetingId,
            participantId
        );
    },

    async selectMeeting(element) {
        const nextMeetingId = String(element?.dataset?.id || '').trim();
        this.state.selectedMeetingId = nextMeetingId;
        try {
            await this.loadMeetingDetails({ expectedMeetingId: nextMeetingId });
        } finally {
            this.renderAll();
        }
    },

    async selectAndJoinMeeting(element) {
        const nextMeetingId = String(element?.dataset?.id || '').trim();
        if (!nextMeetingId) return;
        if (this.state.joiningMeetingId) return;
        const currentMeetingId = String(this.state.session?.meeting?.id || '').trim();
        const currentlyJoined = Boolean(this.state.session?.participantIdentity);
        const switchingRoom = Boolean(currentlyJoined && currentMeetingId && currentMeetingId !== nextMeetingId);
        if (currentlyJoined && currentMeetingId === nextMeetingId) {
            this.state.selectedMeetingId = nextMeetingId;
            try {
                await this.loadMeetingDetails({ expectedMeetingId: nextMeetingId });
            } finally {
                this.renderAll();
            }
            return;
        }

        if (switchingRoom) {
            const currentMeeting = this.state.meetings.find((entry) => entry.id === currentMeetingId);
            const nextMeeting = this.state.meetings.find((entry) => entry.id === nextMeetingId);
            const confirmed = window.confirm(
                `Leave "${currentMeeting?.title || 'current room'}" and join "${nextMeeting?.title || 'selected room'}"?`
            );
            if (!confirmed) {
                return;
            }
            this.setDisconnectingRoomTransition(currentMeeting?.title || 'room');
            await this.unjoinCurrentSession({ preserveDisplayName: true, manageTransition: false });
        }

        this.state.selectedMeetingId = nextMeetingId;
        this.state.joiningMeetingId = nextMeetingId;
        this.setConnectingRoomTransition(this.getMeetingTitleById(nextMeetingId, 'room'), { render: false });
        this.renderMeetingList();
        try {
            await this.loadMeetingDetails({ expectedMeetingId: nextMeetingId });
            this.renderAll();
            if (!this.selectedMeeting) {
                this.clearRoomTransitionMessage();
                return;
            }
            const defaultName = String(this.state.session?.participant?.displayName || '').trim();
            await this.joinMeeting({ displayNameOverride: defaultName });
            this.setMobilePanel('room');
        } catch (error) {
            const message = String(error?.message || error || '').trim();
            if (message.includes('Unsupported state or unable to authenticate data')) {
                this.setError('Room data cannot be decrypted with the current WebMeet key. Restore the previous Ploinky master key or recreate the room.');
            } else {
                this.setError(message || 'Failed to join room.');
            }
        } finally {
            if (this.state.joiningMeetingId === nextMeetingId) {
                this.state.joiningMeetingId = '';
                this.renderMeetingList();
            }
            if (!this.state.session?.participantIdentity) {
                this.clearRoomTransitionMessage({ render: false });
                this.renderMeetingSummary();
            }
        }
    },

    async sendChat() {
        return this.chatComponent.sendChat();
    },

    async appendTranscript() {
        return this.chatComponent.appendTranscript();
    },

    startSpeechRecognition() {
        this.chatComponent.startSpeechRecognition();
        this.speechRecognition = this.chatComponent.speechRecognition;
    },

    stopSpeechRecognition() {
        this.chatComponent.stopSpeechRecognition();
        this.speechRecognition = null;
    },

    async startAutoTranscript() {
        this.startSpeechRecognition();
    },

    async stopAutoTranscript() {
        this.stopSpeechRecognition();
    },

    async closeModal(target) {
        if (this.state.session?.participantIdentity) {
            await this.unjoinCurrentSession({ preserveDisplayName: false });
        }
        this.participantLayoutController?.dispose?.();
        this.roomNotificationSoundService?.teardown?.();
        window.removeEventListener('assistOS:avatar-settings-updated', this.handleAvatarSettingsUpdatedEvent);
        window.removeEventListener('webmeet:participant-audio-preview', this.handleParticipantAudioPreviewEvent);
        assistOS.UI.closeModal(target || this.element);
    },

    isLocalParticipantIdentity(participant) {
        const participantIdentity = String(participant?.identity || participant || '').trim();
        const localIdentity = String(
            this.room?.localParticipant?.identity
            || this.state.session?.participantIdentity
            || ''
        ).trim();
        return Boolean(participantIdentity && localIdentity && participantIdentity === localIdentity);
    },

    playParticipantJoinSound(participant) {
        if (!participant?.identity || this.isLocalParticipantIdentity(participant)) return;
        this.roomNotificationSoundService?.playJoin?.();
    },

    playParticipantLeaveSound(participant) {
        if (!participant?.identity || this.isLocalParticipantIdentity(participant)) return;
        this.roomNotificationSoundService?.playLeave?.();
    }
};
