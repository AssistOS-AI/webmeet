import { getCurrentActorDisplayName } from '../services/dashboard-utils.js';
import { runWebMeetTool } from '../services/webmeet-api-client.js';
import {
    getCurrentProfileAvatar,
    normalizeAvatarConfig
} from '/explorer/services/profile-avatar-client.js';

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
                message: `Guest Room created! Share this link:\n\n${guestUrl}\n\n(Click Yes to copy to clipboard)`
            }, true);
            try {
                await navigator.clipboard.writeText(guestUrl);
                this.setError('Guest link copied to clipboard!');
            } catch {
                this.setError(`Guest link: ${guestUrl}`);
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
            this.setError('Invite links are available only for guest rooms.');
            return;
        }
        const guestUrl = await this.getGuestInviteLink(meeting);
        if (!guestUrl) {
            this.setError('Guest invite link is unavailable.');
            return;
        }
        try {
            await navigator.clipboard.writeText(guestUrl);
            this.setError('Guest invite link copied to clipboard.');
        } catch {
            this.setError(`Guest invite link: ${guestUrl}`);
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
        const displayName = String(options.displayNameOverride || getCurrentActorDisplayName()).trim();
        const participantId = this.getStableParticipantId(displayName);
        const payload = { meetingId: meeting.id, participantId };
        if (displayName) {
            payload.displayName = displayName;
        }
        let initialAvatar = null;
        try {
            const sourceAvatar = options.avatar && typeof options.avatar === 'object'
                ? options.avatar
                : await getCurrentProfileAvatar({ force: true });
            const fallbackAvatarId = `profile:${sourceAvatar.user?.id || participantId}`;
            initialAvatar = {
                enabled: sourceAvatar.enabled !== false,
                config: normalizeAvatarConfig(sourceAvatar.config, fallbackAvatarId),
                fallbackLetter: sourceAvatar.fallbackLetter || ''
            };
        } catch (_) {
            // Joining should not fail just because the optional avatar projection is unavailable.
        }
        if (initialAvatar) {
            payload.avatar = initialAvatar;
        }
        this.state.session = await runTool('webmeet_meeting_join', payload);
        try {
            await this.connectRoom();
            await this.publishCurrentParticipantAvatar({ force: true, ...(initialAvatar ? { avatar: initialAvatar } : {}) });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.state.roomState = message;
            this.setError(message);
        } finally {
            this.renderMeetingSummary();
        }
    },

    async publishCurrentParticipantAvatar(options = {}) {
        if (this.isGuestSession()) return;
        const meetingId = String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim();
        const participantId = String(this.state.session?.participantIdentity || '').trim();
        if (!meetingId || !participantId) return;
        try {
            const sourceAvatar = options.avatar && typeof options.avatar === 'object'
                ? options.avatar
                : await getCurrentProfileAvatar({ force: Boolean(options.force) });
            const fallbackAvatarId = `profile:${sourceAvatar.user?.id || participantId}`;
            const avatar = {
                enabled: sourceAvatar.enabled !== false,
                config: normalizeAvatarConfig(sourceAvatar.config, fallbackAvatarId),
                fallbackLetter: sourceAvatar.fallbackLetter || ''
            };
            const updated = await runTool('webmeet_participant_avatar_update', {
                meetingId,
                participantId,
                avatar
            });
            const profileAvatar = updated?.profileAvatar || null;
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
            if (this.room && window.LivekitClient?.Track) {
                this.syncParticipantsFromRoom(this.room, window.LivekitClient.Track);
            }
            const userId = String(
                sourceAvatar.user?.id
                || profileAvatar?.config?.agentId?.replace(/^profile:/, '')
                || ''
            ).trim();
            await this.publishRealtimePayload({
                type: 'participant.avatar.updated',
                meetingId,
                participantId,
                userId,
                profileAvatar
            });
        } catch (_) {
            // Avatar projection is best-effort; room join and media state remain authoritative.
        }
    },

    async leaveMeeting() {
        if (this.state.leavingMeeting) return;
        const wasGuestSession = this.isGuestSession();
        this.state.leavingMeeting = true;
        this.state.roomState = 'Disconnecting';
        this.renderAll();
        try {
            await this.unjoinCurrentSession({ preserveDisplayName: false });
            if (wasGuestSession && typeof this.hostContext?.onGuestExit === 'function') {
                this.hostContext.onGuestExit();
            }
        } finally {
            this.state.leavingMeeting = false;
            this.renderAll();
        }
    },

    async unjoinCurrentSession(options = {}) {
        const preserveDisplayName = Boolean(options.preserveDisplayName);
        const previousMeetingId = String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim();
        const previousParticipantId = String(this.state.session?.participantIdentity || '').trim();
        const preservedName = String(this.state.session?.participant?.displayName || '').trim();
        const wasGuestSession = this.isGuestSession();
        this.stopPresenceHeartbeat();
        this.stopSpeechRecognition();
        await this.disconnectRoom();

        if (previousMeetingId && previousParticipantId && wasGuestSession) {
            try {
                await this.callPublicGuestApi(previousMeetingId, 'guest-leave', {});
            } catch (error) {
                // Ignore leave failures during unload or room switching.
            }
        } else if (previousMeetingId && previousParticipantId) {
            try {
                await runTool('webmeet_meeting_leave', {
                    meetingId: previousMeetingId,
                    participantId: previousParticipantId
                });
            } catch (error) {
                // Ignore leave failures during unload or room switching.
            }
        }

        this.removeParticipantFromMeetingList(previousMeetingId, previousParticipantId);
        this.state.session = preserveDisplayName && preservedName ? { participant: { displayName: preservedName } } : null;
        if (!wasGuestSession) {
            await this.loadParticipantsForMeetings();
        }
        this.renderAll();
    },

    async sendPublicChat(meetingId, message) {
        return this.callPublicGuestApi(meetingId, 'guest-chat', { message });
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
