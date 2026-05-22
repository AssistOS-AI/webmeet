import { getCurrentActorDisplayName } from '../services/dashboard-utils.js';
import { runWebMeetTool } from '../services/webmeet-api-client.js';
import {
    getCurrentProfileAvatar,
    normalizeAvatarConfig
} from '../services/webmeet-profile-avatar-runtime.js';
import {
    buildWebMeetAvatarSource,
    buildWebMeetAvatarOverrideConfig,
    clearWebMeetAvatarOverride,
    getWebMeetAvatarPreset,
    loadWebMeetAvatarOverride,
    saveWebMeetAvatarOverride
} from '../services/webmeet-avatar-override.js';

const runTool = runWebMeetTool;

export const meetingActionMethods = {
    async createMeeting() {
        if (!this.canManageRooms()) {
            this.setError('Only admin can create rooms.');
            return;
        }
        if (!this.state.selectedWorkspaceId) {
            this.setError('Current Explorer workspace is unavailable.');
            return;
        }

        const result = await assistOS.UI.showModal('create-room-modal', {}, true);
        if (!result || !result.roomTitle) return;

        const meeting = await runTool('webmeet_meeting_create', {
            workspaceId: this.state.selectedWorkspaceId,
            title: result.roomTitle,
            roomType: result.roomType
        });

        if (result.roomType === 'guest' && meeting?.guestToken) {
            const guestUrl = this.buildGuestJoinUrl(meeting.id, meeting.guestToken);
            await assistOS.UI.showModal('confirm-action-modal', {
                message: `Public meeting created! Share this link:\n\n${guestUrl}\n\n(Click Yes to copy to clipboard)`
            }, true);
            try {
                await navigator.clipboard.writeText(guestUrl);
                this.setError('Public meeting link copied to clipboard!');
            } catch {
                this.setError(`Public meeting link: ${guestUrl}`);
            }
        }

        this.state.selectedMeetingId = meeting?.id || this.state.selectedMeetingId;
        await this.loadMeetings();
        this.renderAll();
    },

    buildGuestJoinUrl(meetingId, guestToken) {
        const url = new URL('/public-services/webmeet/guest', window.location.origin);
        const params = new URLSearchParams({
            room: String(meetingId || ''),
            token: String(guestToken || '')
        });
        url.search = params.toString();
        return url.toString();
    },

    async getGuestInviteLink(meeting) {
        if (!meeting || meeting.roomType !== 'guest') {
            return '';
        }
        let guestToken = String(meeting.guestToken || '').trim();
        if (!guestToken) {
            try {
                const details = await runTool('webmeet_meeting_get', { meetingId: meeting.id });
                guestToken = String(details?.meeting?.guestToken || '').trim();
            } catch {
                guestToken = '';
            }
        }
        return guestToken ? this.buildGuestJoinUrl(meeting.id, guestToken) : '';
    },

    async copyGuestInviteLink(target) {
        const meeting = this.getMeetingFromActionTarget(target);
        if (!meeting || meeting.roomType !== 'guest') {
            this.setError('Invite links are available only for public meetings.');
            return;
        }
        const guestUrl = await this.getGuestInviteLink(meeting);
        if (!guestUrl) {
            this.setError('Public meeting invite link is unavailable.');
            return;
        }
        try {
            await navigator.clipboard.writeText(guestUrl);
            this.setError('Public meeting invite link copied to clipboard.');
        } catch {
            this.setError(`Public meeting invite link: ${guestUrl}`);
        }
    },

    getMeetingFromActionTarget(target) {
        const source = target?.target || target;
        const meetingId = String(source?.dataset?.id || source?.closest?.('[data-id]')?.dataset?.id || '').trim();
        if (!meetingId) {
            return this.selectedMeeting;
        }
        return this.state.meetings.find((entry) => entry.id === meetingId) || null;
    },

    async renameMeeting(target) {
        if (!this.canManageRooms()) {
            this.setError('Only admin can rename rooms.');
            return;
        }
        const meeting = this.getMeetingFromActionTarget(target);
        if (!meeting) {
            this.setError('Room unavailable.');
            return;
        }
        const title = String(window.prompt('Room title', meeting.title || '') || '').trim();
        if (!title || title === meeting.title) {
            return;
        }
        const updated = await runTool('webmeet_meeting_rename', {
            meetingId: meeting.id,
            title
        });
        if (updated?.title) {
            this.applyMeetingRename(meeting.id, updated.title, updated.updatedAt || '');
            if (String(this.state.session?.meeting?.id || '').trim() === String(meeting.id || '').trim()) {
                try {
                    await this.publishRealtimePayload({
                        type: 'meeting.renamed',
                        meetingId: meeting.id,
                        title: updated.title,
                        updatedAt: updated.updatedAt || new Date().toISOString()
                    });
                } catch (_) {
                    // Persisted rename already succeeded; realtime delivery is best effort.
                }
            }
        }
        await this.loadMeetings();
        this.renderAll();
    },

    async joinMeeting(options = {}) {
        const meeting = this.selectedMeeting;
        if (!meeting) {
            this.setError('Select a meeting first.');
            return;
        }
        this.setConnectingRoomTransition(meeting.title || 'room');
        const displayName = String(options.displayNameOverride || getCurrentActorDisplayName()).trim();
        const participantId = this.getStableParticipantId(displayName);
        const payload = { meetingId: meeting.id, participantId };
        if (displayName) {
            payload.displayName = displayName;
        }
        this.state.session = await this.roomRuntime.joinAuthenticated(payload);
        try {
            await this.roomRuntime.connect();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.state.roomState = message;
            this.setError(message);
            return;
        } finally {
            this.clearRoomTransitionMessage({ render: false });
            this.renderMeetingSummary();
        }
        void this.publishCurrentParticipantAvatar({ force: true }).catch((error) => {
            const message = error instanceof Error ? error.message : String(error || 'Avatar publish failed.');
            this.setError(`Joined room, but WebMeet could not publish the avatar: ${message}`);
        });
    },

    buildParticipantAvatarProjection(sourceAvatar = null, participantId = '') {
        const source = sourceAvatar && typeof sourceAvatar === 'object' ? sourceAvatar : {};
        const profileUserId = String(source.user?.id || '').trim();
        const fallbackAvatarId = `profile:${profileUserId || participantId}`;
        return {
            enabled: source.enabled !== false,
            config: normalizeAvatarConfig(source.config, fallbackAvatarId),
            fallbackLetter: source.fallbackLetter || ''
        };
    },

    getCurrentAvatarOverrideUserId() {
        if (this.isGuestSession()) {
            return '';
        }
        return String(this.currentActor?.id || this.state.session?.participant?.userId || '').trim();
    },

    loadCurrentWebMeetAvatarOverride() {
        const userId = this.getCurrentAvatarOverrideUserId();
        return loadWebMeetAvatarOverride(userId);
    },

    setCurrentWebMeetAvatarOverride(override = null) {
        const userId = this.getCurrentAvatarOverrideUserId();
        const normalized = saveWebMeetAvatarOverride(userId, override);
        this.state.webMeetAvatarOverride = normalized;
        return normalized;
    },

    clearCurrentWebMeetAvatarOverride() {
        const userId = this.getCurrentAvatarOverrideUserId();
        clearWebMeetAvatarOverride(userId);
        this.state.webMeetAvatarOverride = null;
    },

    async resolveCurrentWebMeetAvatarSource(options = {}) {
        const participantId = String(options.participantId || this.state.session?.participantIdentity || '').trim();
        const userId = this.getCurrentAvatarOverrideUserId();
        const override = this.loadCurrentWebMeetAvatarOverride();
        this.state.webMeetAvatarOverride = override;
        let profileAvatar = options.avatar && typeof options.avatar === 'object'
            ? options.avatar
            : null;
        if (!profileAvatar) {
            try {
                profileAvatar = await getCurrentProfileAvatar({ force: Boolean(options.force) });
            } catch (error) {
                if (!override) throw error;
                profileAvatar = null;
            }
        }
        return buildWebMeetAvatarSource({
            profileAvatar,
            override,
            userId,
            participantId
        });
    },

    async resolveCurrentParticipantAvatarProjection(options = {}) {
        const participantId = String(this.state.session?.participantIdentity || '').trim();
        if (!participantId) return null;
        const sourceAvatar = options.avatar && typeof options.avatar === 'object'
            ? options.avatar
            : await this.resolveCurrentWebMeetAvatarSource({
                force: Boolean(options.force),
                participantId
            });
        return {
            sourceAvatar,
            avatar: this.buildParticipantAvatarProjection(sourceAvatar, participantId)
        };
    },

    async applyWebMeetAvatarPreset(target) {
        const source = target?.target || target;
        const presetId = String(source?.dataset?.avatarPreset || source?.closest?.('[data-avatar-preset]')?.dataset?.avatarPreset || '').trim();
        const preset = getWebMeetAvatarPreset(presetId);
        let profileAvatar = null;
        try {
            profileAvatar = await getCurrentProfileAvatar({ force: true });
        } catch (_) {
            profileAvatar = null;
        }
        const currentOverride = this.loadCurrentWebMeetAvatarOverride();
        this.state.webMeetAvatarOverride = currentOverride;
        const config = buildWebMeetAvatarOverrideConfig({
            profileAvatar,
            override: currentOverride,
            userId: this.getCurrentAvatarOverrideUserId(),
            participantId: this.state.session?.participantIdentity || '',
            patch: preset.patch
        });
        this.setCurrentWebMeetAvatarOverride({ config });
        this.state.webMeetAvatarOverrideDraft = this.state.webMeetAvatarOverride;
        this.state.avatarQuickMenuVisible = false;
        const published = await this.publishCurrentParticipantAvatar({ force: true });
        this.renderAvatarControls?.();
        this.renderMeetingSummary();
        this.renderParticipantLayout?.();
        this.renderMeetingList?.();
        this.setError(published
            ? `WebMeet avatar set to ${preset.label} and published.`
            : `WebMeet avatar preset saved. Join a room to publish ${preset.label}.`);
    },

    async resetWebMeetAvatarOverride() {
        this.clearCurrentWebMeetAvatarOverride();
        this.state.webMeetAvatarOverrideDraft = null;
        this.state.avatarQuickMenuVisible = false;
        const published = await this.publishCurrentParticipantAvatar({ force: true });
        this.renderAvatarControls?.();
        this.renderMeetingSummary();
        this.renderParticipantLayout?.();
        this.renderMeetingList?.();
        this.setError(published
            ? 'WebMeet avatar reset to profile avatar and published.'
            : 'WebMeet avatar reset to profile avatar. Join a room to publish it.');
    },

    toggleAvatarQuickMenu() {
        this.state.avatarQuickMenuVisible = !this.state.avatarQuickMenuVisible;
        this.renderAvatarControls?.();
    },

    syncWebMeetAvatarSettingsDraftFromInputs() {
        const currentOverride = this.loadCurrentWebMeetAvatarOverride();
        this.state.webMeetAvatarOverride = currentOverride;
        const currentConfig = this.state.webMeetAvatarOverrideDraft?.config
            || currentOverride?.config
            || this.state.session?.participant?.profileAvatar?.config
            || {};
        const presetId = String(this.avatarPresetSelect?.value || '').trim();
        const presetPatch = presetId ? getWebMeetAvatarPreset(presetId).patch : {};
        const fallbackId = `profile:${this.getCurrentAvatarOverrideUserId() || this.state.session?.participantIdentity || 'current-user'}`;
        const generated = this.avatarGeneratedInput?.checked !== false;
        this.state.webMeetAvatarOverrideDraft = {
            config: normalizeAvatarConfig({
                ...currentConfig,
                generated,
                src: String(this.avatarSrcInput?.value || '').trim(),
                packSrc: String(this.avatarPackSrcInput?.value || '').trim(),
                assetMode: String(this.avatarAssetModeSelect?.value || '').trim(),
                emotion: String(this.avatarEmotionSelect?.value || '').trim(),
                size: String(this.avatarSizeInput?.value || '').trim(),
                thought: String(this.avatarThoughtInput?.value || '').trim(),
                thoughtMode: String(this.avatarThoughtModeSelect?.value || '').trim(),
                mode: String(this.avatarModeSelect?.value || '').trim(),
                shape: String(this.avatarShapeSelect?.value || '').trim(),
                theme: String(this.avatarThemeSelect?.value || '').trim(),
                animated: this.avatarAnimatedInput?.checked !== false,
                listen: this.avatarListenInput?.checked === true,
                style: String(this.avatarStyleSelect?.value || '').trim(),
                palette: String(this.avatarPaletteSelect?.value || '').trim(),
                complexity: String(this.avatarComplexitySelect?.value || '').trim(),
                ...presetPatch
            }, fallbackId)
        };
        this.renderAvatarControls?.();
    },

    async applyWebMeetAvatarSettings() {
        this.syncWebMeetAvatarSettingsDraftFromInputs();
        const draft = this.state.webMeetAvatarOverrideDraft;
        if (draft) {
            this.setCurrentWebMeetAvatarOverride(draft);
            this.state.webMeetAvatarOverrideDraft = this.state.webMeetAvatarOverride;
        } else {
            this.clearCurrentWebMeetAvatarOverride();
            this.state.webMeetAvatarOverrideDraft = null;
        }
        const published = await this.publishCurrentParticipantAvatar({ force: true });
        this.renderAvatarControls?.();
        this.renderMeetingSummary();
        this.renderParticipantLayout?.();
        this.renderMeetingList?.();
        if (draft) {
            this.setError(published
                ? 'WebMeet avatar override applied and published.'
                : 'WebMeet avatar override saved. Join a room to publish it.');
            return;
        }
        this.setError(published
            ? 'WebMeet avatar reset to profile avatar and published.'
            : 'WebMeet avatar reset to profile avatar. Join a room to publish it.');
    },

    async publishCurrentParticipantAvatarState(profileAvatar = null, sourceAvatar = null) {
        const meetingId = String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim();
        const participantId = String(this.state.session?.participantIdentity || '').trim();
        if (!meetingId || !participantId) return;

        let avatarProjection = profileAvatar && typeof profileAvatar === 'object'
            ? profileAvatar
            : null;
        let avatarSource = sourceAvatar && typeof sourceAvatar === 'object' ? sourceAvatar : null;
        if (!avatarProjection) {
            const resolved = await this.resolveCurrentParticipantAvatarProjection({ force: true });
            avatarProjection = resolved?.avatar || null;
            avatarSource = resolved?.sourceAvatar || null;
        }
        if (!avatarProjection) return;

        const userId = String(
            avatarSource?.user?.id
            || avatarProjection?.config?.agentId?.replace(/^profile:/, '')
            || this.currentActor?.id
            || ''
        ).trim();
        const localParticipant = this.room?.localParticipant || null;
        if (localParticipant && typeof localParticipant.setAttributes === 'function') {
            try {
                const attributes = {
                    ...(localParticipant.attributes && typeof localParticipant.attributes === 'object'
                        ? localParticipant.attributes
                        : {}),
                    ...(userId ? {
                        webmeetUserId: userId,
                        userId,
                        workspaceUserId: userId,
                        ploinkyUserId: userId
                    } : {}),
                    webmeetProfileAvatar: JSON.stringify(avatarProjection)
                };
                await localParticipant.setAttributes(attributes);
            } catch (_) {
                // The data-channel payload below is the immediate room-state update.
            }
        }
        await this.publishRealtimePayload({
            type: 'participant.avatar.updated',
            meetingId,
            participantId,
            userId,
            profileAvatar: avatarProjection
        });
    },

    getCurrentPublishedParticipantAvatarState() {
        const localAttributes = this.room?.localParticipant?.attributes && typeof this.room.localParticipant.attributes === 'object'
            ? this.room.localParticipant.attributes
            : {};
        let profileAvatar = null;
        const rawProfileAvatar = String(localAttributes.webmeetProfileAvatar || '').trim();
        if (rawProfileAvatar) {
            try {
                const parsed = JSON.parse(rawProfileAvatar);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    profileAvatar = parsed;
                }
            } catch (_) {
                profileAvatar = null;
            }
        }
        if (!profileAvatar && this.state.session?.participant?.profileAvatar && typeof this.state.session.participant.profileAvatar === 'object') {
            profileAvatar = this.state.session.participant.profileAvatar;
        }
        if (!profileAvatar) return null;
        const userId = String(
            localAttributes.ploinkyUserId
            || localAttributes.workspaceUserId
            || localAttributes.userId
            || localAttributes.webmeetUserId
            || this.currentActor?.id
            || this.state.session?.participant?.userId
            || ''
        ).trim();
        return {
            profileAvatar,
            sourceAvatar: {
                enabled: profileAvatar.enabled !== false,
                config: profileAvatar.config || null,
                fallbackLetter: profileAvatar.fallbackLetter || '',
                user: userId ? { id: userId } : null
            }
        };
    },

    async republishCurrentParticipantAvatarState() {
        const current = this.getCurrentPublishedParticipantAvatarState?.() || null;
        await this.publishCurrentParticipantAvatarState(
            current?.profileAvatar || null,
            current?.sourceAvatar || null
        );
    },

    async publishCurrentParticipantAvatar(options = {}) {
        const meetingId = String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim();
        const participantId = String(this.state.session?.participantIdentity || '').trim();
        if (!meetingId || !participantId) return null;
        const resolved = await this.resolveCurrentParticipantAvatarProjection(options);
        if (!resolved?.avatar) return null;
        const { avatar, sourceAvatar } = resolved;
        const updated = await this.roomRuntime.publishAvatar(avatar);
        const profileAvatar = avatar && typeof avatar === 'object'
            ? {
                ...avatar,
                ...(updated?.profileAvatar && typeof updated.profileAvatar === 'object'
                    ? { updatedAt: updated.profileAvatar.updatedAt || avatar.updatedAt }
                    : {})
            }
            : (updated?.profileAvatar || null);
        if (profileAvatar && this.state.session?.participant) {
            this.state.session.participant.profileAvatar = profileAvatar;
        }
        const existing = Array.isArray(this.state.participants) ? this.state.participants : [];
        let matchedParticipant = false;
        this.state.participants = existing.map((entry) => {
            const matched = String(entry?.id || '').trim() === participantId;
            if (matched) {
                matchedParticipant = true;
            }
            return matched
                ? { ...entry, profileAvatar }
                : entry;
        });
        if (!matchedParticipant && this.state.session?.participant) {
            this.state.participants = [
                ...this.state.participants,
                {
                    ...this.state.session.participant,
                    profileAvatar
                }
            ];
        }
        const userId = String(
            sourceAvatar?.user?.id
            || profileAvatar?.config?.agentId?.replace(/^profile:/, '')
            || this.currentActor?.id
            || ''
        ).trim();
        if (options.skipRealtime !== true) {
            await this.publishCurrentParticipantAvatarState(profileAvatar, sourceAvatar);
        }
        this.applyRealtimeParticipantAvatar?.({
            meetingId,
            participantId,
            userId,
            profileAvatar
        });
        return {
            profileAvatar,
            sourceAvatar,
            userId
        };
    },

    async leaveMeeting() {
        if (this.state.leavingMeeting) return;
        const wasGuestSession = this.isGuestSession();
        const currentMeetingTitle = this.getMeetingTitleById(
            this.state.session?.meeting?.id || this.state.selectedMeetingId,
            this.selectedMeeting?.title || 'room'
        );
        this.state.leavingMeeting = true;
        this.state.roomState = 'Disconnecting';
        this.setDisconnectingRoomTransition(currentMeetingTitle, { render: false });
        this.renderAll();
        try {
            await this.unjoinCurrentSession({ preserveDisplayName: false, manageTransition: false });
            if (wasGuestSession && typeof this.hostContext?.onGuestExit === 'function') {
                this.hostContext.onGuestExit();
            }
        } finally {
            this.state.leavingMeeting = false;
            this.clearRoomTransitionMessage({ render: false });
            this.renderAll();
        }
    },

    async unjoinCurrentSession(options = {}) {
        const preserveDisplayName = Boolean(options.preserveDisplayName);
        const manageTransition = options.manageTransition !== false;
        const previousMeetingId = String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim();
        const previousParticipantId = String(this.state.session?.participantIdentity || '').trim();
        const preservedName = String(this.state.session?.participant?.displayName || '').trim();
        const wasGuestSession = this.isGuestSession();
        if (manageTransition) {
            this.setDisconnectingRoomTransition(
                this.getMeetingTitleById(previousMeetingId, this.selectedMeeting?.title || 'room'),
                { render: false }
            );
            this.renderMeetingSummary();
        }
        this.stopPresenceHeartbeat();
        this.stopSpeechRecognition();
        await this.roomRuntime.disconnect();

        if (previousMeetingId && previousParticipantId) {
            try {
                await this.roomRuntime.leaveCurrentSession();
            } catch (error) {
                // Ignore leave failures during unload or room switching.
            }
        }

        this.removeParticipantFromMeetingList(previousMeetingId, previousParticipantId);
        this.state.session = preserveDisplayName && preservedName ? { participant: { displayName: preservedName } } : null;
        if (!wasGuestSession) {
            await this.loadParticipantsForMeetings();
        }
        if (manageTransition) {
            this.clearRoomTransitionMessage({ render: false });
        }
        this.renderAll();
    },

    async sendPublicChat(meetingId, message) {
        return this.roomRuntime.sendChat(meetingId, message);
    },

    async attachObserver() {
        await this.attachAgent('observer', 'passive');
    },

    async attachAssistant() {
        await this.attachAgent('assistant_on_mention', 'on_mention');
    },

    async attachScribe() {
        await this.attachAgent('scribe', 'post_event');
    },

    async attachAgent(agentType, mode) {
        if (this.isGuestSession()) {
            this.setError('Only admin can attach meeting agents.');
            return;
        }
        const meeting = this.selectedMeeting;
        if (!meeting) {
            this.setError('Select a meeting before attaching AI agents.');
            return;
        }
        try {
            const agent = await runTool('webmeet_agent_attach', { meetingId: meeting.id, agentType, mode });
            await this.loadMeetingDetails();
            if (this.room && window.LivekitClient?.Track) {
                this.syncParticipantsFromRoom(this.room, window.LivekitClient.Track);
            }
            try {
                await this.publishRealtimePayload({
                    type: 'agent.dispatched',
                    meetingId: meeting.id,
                    agentId: agent?.id || '',
                    agentType,
                    mode
                });
            } catch (_) {
                // Persisted dispatch already succeeded; realtime delivery is best effort.
            }
            this.renderAll();
        } catch (error) {
            this.setError(error instanceof Error ? error.message : String(error));
        }
    },

    async detachAgent(target) {
        const source = target?.target || target;
        const agentId = String(source?.dataset?.agentId || source?.dataset?.id || '').trim();
        await this.detachAgentById(agentId);
    },

    async detachAgentFromCard(target) {
        const source = target?.target || target;
        const agentId = String(source?.dataset?.agentId || source?.closest?.('[data-agent-id]')?.dataset?.agentId || '').trim();
        await this.detachAgentById(agentId);
    },

    async detachAgentById(agentId) {
        if (this.isGuestSession() || !this.canManageRooms()) {
            this.setError('Only admin can disable meeting agents.');
            return;
        }
        const meeting = this.selectedMeeting;
        if (!meeting) {
            this.setError('Select a meeting before disabling AI agents.');
            return;
        }
        const id = String(agentId || '').trim();
        if (!id) {
            this.setError('AI agent unavailable.');
            return;
        }
        try {
            const stoppedAgent = await runTool('webmeet_agent_detach', { meetingId: meeting.id, agentId: id });
            await this.loadMeetingDetails();
            if (this.room && window.LivekitClient?.Track) {
                this.syncParticipantsFromRoom(this.room, window.LivekitClient.Track);
            }
            try {
                await this.publishRealtimePayload({
                    type: 'agent.detached',
                    meetingId: meeting.id,
                    agentId: id,
                    agentType: stoppedAgent?.agentType || '',
                    mode: stoppedAgent?.mode || ''
                });
            } catch (_) {
                // Persisted detach already succeeded; realtime delivery is best effort.
            }
            this.renderAll();
        } catch (error) {
            this.setError(error instanceof Error ? error.message : String(error));
        }
    },

    async startRecording() {
        if (!this.canManageRooms()) {
            this.setError('Only admin can manage recording.');
            return;
        }
        const meeting = this.selectedMeeting;
        if (!meeting) {
            this.setError('Select a meeting before starting recording.');
            return;
        }
        await runTool('webmeet_recording_start', { meetingId: meeting.id });
        await this.loadMeetingDetails();
        this.renderAll();
    },

    async stopRecording() {
        if (!this.canManageRooms()) {
            this.setError('Only admin can manage recording.');
            return;
        }
        const meeting = this.selectedMeeting;
        if (!meeting) {
            this.setError('Select a meeting before stopping recording.');
            return;
        }
        await runTool('webmeet_recording_stop', { meetingId: meeting.id });
        await this.loadMeetingDetails();
        this.renderAll();
    },

    async toggleRecording() {
        const meeting = this.selectedMeeting;
        if (!meeting) {
            this.setError('Select a meeting before toggling recording.');
            return;
        }

        const latestRecording = [...this.state.recordings].reverse()[0];
        if (latestRecording && latestRecording.status === 'recording') {
            await this.stopRecording();
        } else {
            await this.startRecording();
        }
    },

    async deleteMeeting(target) {
        if (!this.canManageRooms()) {
            this.setError('Only admin can delete rooms.');
            return;
        }
        const meeting = this.getMeetingFromActionTarget(target);
        if (!meeting) {
            this.setError('Room unavailable.');
            return;
        }
        const confirmed = window.confirm(`Delete "${meeting.title || 'this room'}"?`);
        if (!confirmed) {
            return;
        }
        await runTool('webmeet_delete_meeting', { meetingId: meeting.id });
        await this.loadMeetings();
        this.renderAll();
    },

    async openTranscript(target) {
        if (!this.canManageRooms()) {
            this.setError('Only admin can view transcripts.');
            return;
        }
        const meeting = this.getMeetingFromActionTarget(target);
        if (!meeting) return;
        await assistOS.UI.showModal('webmeet-transcript-modal', {
            meetingId: meeting.id,
            meetingTitle: meeting.title
        }, true);
    },

    async openArtifacts(target) {
        if (!this.canManageRooms()) {
            this.setError('Only admin can view artifacts.');
            return;
        }
        const meeting = this.getMeetingFromActionTarget(target);
        if (!meeting) return;
        await assistOS.UI.showModal('webmeet-artifacts-modal', {
            meetingId: meeting.id,
            meetingTitle: meeting.title
        }, true);
    },

    async openRecordings(target) {
        if (!this.canManageRooms()) {
            this.setError('Only admin can view recordings.');
            return;
        }
        const meeting = this.getMeetingFromActionTarget(target);
        if (!meeting) return;
        await assistOS.UI.showModal('webmeet-recordings-modal', {
            meetingId: meeting.id,
            meetingTitle: meeting.title
        }, true);
    },

    async openAI(target) {
        if (!this.canManageRooms()) {
            this.setError('Only admin can manage AI agents.');
            return;
        }
        const meeting = this.getMeetingFromActionTarget(target);
        if (!meeting) return;
        await assistOS.UI.showModal('webmeet-ai-modal', {
            meetingId: meeting.id,
            meetingTitle: meeting.title
        }, true);
    },

    async showRoomAiMenu(target) {
        const meeting = this.getMeetingFromActionTarget(target);
        if (!meeting) return;
        await assistOS.UI.showActionBox(target, meeting.id, 'webmeet-room-ai-menu', 'append', { id: meeting.id });
    }

};
