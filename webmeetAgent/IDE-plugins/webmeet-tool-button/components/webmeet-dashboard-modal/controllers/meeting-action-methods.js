import { getCurrentActorDisplayName } from '../services/dashboard-utils.js';
import { runWebMeetTool } from '../services/webmeet-api-client.js';

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
        this.state.session = await runTool('webmeet_meeting_join', payload);
        try {
            await this.connectRoom();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.state.roomState = message;
            this.setError(message);
        } finally {
            this.renderMeetingSummary();
        }
    },

    async leaveMeeting() {
        const wasGuestSession = this.isGuestSession();
        await this.unjoinCurrentSession({ preserveDisplayName: false });
        if (wasGuestSession && typeof this.hostContext?.onGuestExit === 'function') {
            this.hostContext.onGuestExit();
        }
    },

    async unjoinCurrentSession(options = {}) {
        const preserveDisplayName = Boolean(options.preserveDisplayName);
        const previousMeetingId = String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim();
        const previousParticipantId = String(this.state.session?.participantIdentity || '').trim();
        const preservedName = String(this.state.session?.participant?.displayName || '').trim();
        const wasGuestSession = this.isGuestSession();
        this.stopPresenceHeartbeat();

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
        this.stopSpeechRecognition();
        await this.disconnectRoom();
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
            await runTool('webmeet_agent_attach', { meetingId: meeting.id, agentType, mode });
            await this.loadMeetingDetails();
            this.renderAll();
        } catch (error) {
            this.setError(error instanceof Error ? error.message : String(error));
        }
    },

    async startRecording() {
        if (this.isGuestSession()) {
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
        if (this.isGuestSession()) {
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
    }

};
