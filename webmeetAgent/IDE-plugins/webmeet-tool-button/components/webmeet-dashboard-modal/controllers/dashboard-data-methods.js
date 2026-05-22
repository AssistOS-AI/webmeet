import { runWebMeetTool } from '../services/webmeet-api-client.js';
import { isMissingMeetingError } from '../services/dashboard-utils.js';

const runTool = runWebMeetTool;

export const dashboardDataMethods = {
    async loadWorkspaces() {
        const payload = await runTool('webmeet_workspace_list');
        this.state.workspaces = Array.isArray(payload.workspaces) ? payload.workspaces : [];
    },

    async loadMeetings() {
        const loadSeq = this.meetingDetailsLoadSeq + 1;
        this.meetingDetailsLoadSeq = loadSeq;
        if (!this.state.selectedWorkspaceId) {
            this.state.meetings = [];
            this.state.meetingParticipantsById = {};
            this.state.selectedMeetingId = '';
            return;
        }
        const payload = await runTool('webmeet_meeting_list', {
            workspaceId: this.state.selectedWorkspaceId
        });
        this.state.meetings = Array.isArray(payload.meetings) ? payload.meetings : [];
        this.state.canManageRooms = payload.canManageRooms === true;
        await this.loadParticipantsForMeetings();
        if (loadSeq !== this.meetingDetailsLoadSeq) return;
        this.state.selectedMeetingId = this.state.meetings.some((entry) => entry.id === this.state.selectedMeetingId)
            ? this.state.selectedMeetingId
            : '';
        if (this.state.selectedMeetingId) {
            await this.loadMeetingDetails({ expectedMeetingId: this.state.selectedMeetingId });
        }
    },

    async refreshMeetingsFromWorkspaceEvent() {
        if (this.isGuestSession() || !this.state.selectedWorkspaceId) return;
        const previousSelectedMeetingId = String(this.state.selectedMeetingId || '').trim();
        await this.loadMeetings();
        if (previousSelectedMeetingId && this.state.meetings.some((entry) => entry.id === previousSelectedMeetingId)) {
            this.state.selectedMeetingId = previousSelectedMeetingId;
        }
        this.renderAll();
    },

    async refreshWorkspaceRosterFromEvent() {
        if (this.isGuestSession() || !this.state.selectedWorkspaceId || !this.state.meetings.length) return;
        await this.loadMeetings();
        this.renderMeetingList();
        this.renderMeetingSummary();
    },

    async refreshMeetingDetailsFromRealtimeEvent() {
        const selectedMeetingId = String(this.state.selectedMeetingId || '').trim();
        try {
            await this.loadMeetingDetails({
                expectedMeetingId: selectedMeetingId,
                includeParticipants: !this.room
            });
            this.renderAll();
        } catch (_) {
            // Realtime events are best-effort; direct user actions still surface failures.
        }
    },

    runBestEffortRealtimeRefresh(refreshFn) {
        void Promise.resolve()
            .then(() => refreshFn())
            .catch(() => {
                // Avoid unhandled promise rejections for transient MCP/session resets.
            });
    },

    scheduleWorkspaceMeetingsRefresh() {
        this.clearWorkspaceMeetingsRefreshTimer();
        this.workspaceMeetingsRefreshTimer = window.setTimeout(() => {
            this.workspaceMeetingsRefreshTimer = null;
            this.runBestEffortRealtimeRefresh(() => this.refreshMeetingsFromWorkspaceEvent());
        }, 100);
    },

    scheduleWorkspaceRosterRefresh() {
        this.clearWorkspaceRosterRefreshTimer();
        this.workspaceRosterRefreshTimer = window.setTimeout(() => {
            this.workspaceRosterRefreshTimer = null;
            this.runBestEffortRealtimeRefresh(() => this.refreshWorkspaceRosterFromEvent());
        }, 100);
    },

    clearWorkspaceMeetingsRefreshTimer() {
        if (!this.workspaceMeetingsRefreshTimer) return;
        window.clearTimeout(this.workspaceMeetingsRefreshTimer);
        this.workspaceMeetingsRefreshTimer = null;
    },

    clearWorkspaceRosterRefreshTimer() {
        if (!this.workspaceRosterRefreshTimer) return;
        window.clearTimeout(this.workspaceRosterRefreshTimer);
        this.workspaceRosterRefreshTimer = null;
    },

    async refreshMeetingsAfterMissingMeeting(missingMeetingId) {
        const payload = await runTool('webmeet_meeting_list', {
            workspaceId: this.state.selectedWorkspaceId
        });
        this.state.meetings = Array.isArray(payload.meetings) ? payload.meetings : [];
        this.state.canManageRooms = payload.canManageRooms === true;
        await this.loadParticipantsForMeetings();
        return this.state.meetings.some((entry) => entry.id === missingMeetingId);
    },

    async fetchPublicMeetingDetails(meetingId) {
        return this.guestManager.fetchPublicMeetingDetails(meetingId);
    },

    async loadParticipantsForMeetings() {
        const meetings = Array.isArray(this.state.meetings) ? this.state.meetings : [];
        const mapMeetingRoster = (details, meetingId) => {
            const participants = Array.isArray(details?.participants) ? details.participants : [];
            const agents = Array.isArray(details?.agents)
                ? details.agents.filter((entry) => entry && !entry.deletedAt && String(entry.status || '').trim() !== 'stopped')
                : [];
            const previousRoster = Array.isArray(this.state.meetingParticipantsById?.[meetingId])
                ? this.state.meetingParticipantsById[meetingId]
                : [];
            const previousMicStateById = new Map(
                previousRoster.map((entry) => [String(entry?.id || '').trim(), entry?.micOn])
            );
            const roster = participants.map((entry) => ({
                id: String(entry?.id || '').trim(),
                name: String(entry?.displayName || entry?.id || 'Participant').trim() || 'Participant',
                micOn: typeof entry?.micOn === 'boolean'
                    ? entry.micOn
                    : (typeof previousMicStateById.get(String(entry?.id || '').trim()) === 'boolean'
                        ? previousMicStateById.get(String(entry?.id || '').trim())
                        : false),
                isAgent: false
            })).filter((entry) => entry.id);
            for (const agent of agents) {
                const participantIdentity = String(agent?.participantIdentity || agent?.participant?.identity || '').trim();
                if (!participantIdentity || roster.some((entry) => entry.id === participantIdentity)) {
                    continue;
                }
                const label = String(
                    agent?.participant?.name
                    || agent?.participant?.identity
                    || agent?.agentType
                    || 'AI Agent'
                ).trim() || 'AI Agent';
                roster.push({
                    id: participantIdentity,
                    name: `${label} (AI)`,
                    micOn: typeof previousMicStateById.get(participantIdentity) === 'boolean'
                        ? previousMicStateById.get(participantIdentity)
                        : false,
                    isAgent: true
                });
            }
            return roster;
        };
        if (this.isGuestSession()) {
            const meeting = meetings[0];
            if (meeting?.id) {
                try {
                    const details = await this.fetchPublicMeetingDetails(meeting.id);
                    this.state.meetingParticipantsById = {
                        [meeting.id]: mapMeetingRoster(details, meeting.id)
                    };
                } catch (error) {
                    this.state.meetingParticipantsById = {};
                }
            } else {
                this.state.meetingParticipantsById = {};
            }
            return;
        }
        const results = await Promise.allSettled(
            meetings.map((meeting) => runTool('webmeet_meeting_get', { meetingId: meeting.id }))
        );
        const nextMap = {};
        const missingMeetingIds = new Set();
        for (let index = 0; index < meetings.length; index += 1) {
            const meeting = meetings[index];
            const result = results[index];
            if (result.status !== 'fulfilled') {
                if (isMissingMeetingError(result.reason)) {
                    missingMeetingIds.add(String(meeting.id || '').trim());
                }
                nextMap[meeting.id] = [];
                continue;
            }
            nextMap[meeting.id] = mapMeetingRoster(result.value, meeting.id);
        }
        if (missingMeetingIds.size) {
            this.state.meetings = meetings.filter((entry) => !missingMeetingIds.has(String(entry?.id || '').trim()));
            for (const meetingId of missingMeetingIds) {
                delete nextMap[meetingId];
            }
            if (missingMeetingIds.has(String(this.state.selectedMeetingId || '').trim())) {
                this.state.selectedMeetingId = '';
                this.state.participants = [];
                this.state.chat = [];
                this.state.transcript = [];
                this.state.artifacts = [];
                this.state.recordings = [];
                this.state.tasks = [];
                this.state.decisions = [];
                this.state.agents = [];
                this.state.session = null;
            }
        }
        this.state.meetingParticipantsById = nextMap;
    },

    async loadMeetingDetails(options = {}) {
        const expectedMeetingId = String(options.expectedMeetingId || this.state.selectedMeetingId || '').trim();
        const includeParticipants = options.includeParticipants === true || (!this.room && options.includeParticipants !== false);
        const loadSeq = this.meetingDetailsLoadSeq + 1;
        this.meetingDetailsLoadSeq = loadSeq;
        const meeting = this.selectedMeeting;
        if (meeting && expectedMeetingId && meeting.id !== expectedMeetingId) {
            return;
        }
        if (!meeting) {
            if (expectedMeetingId && this.state.meetings.some((entry) => entry.id === expectedMeetingId)) {
                return;
            }
            this.state.chat = [];
            this.state.transcript = [];
            this.state.artifacts = [];
            this.state.recordings = [];
            this.state.tasks = [];
            this.state.decisions = [];
            this.state.agents = [];
            this.state.session = null;
            this.state.participants = [];
            this.state.participantAudioSettings = {};
            return;
        }
        this.loadParticipantAudioSettings();
        if (this.isGuestSession()) {
            try {
                const details = await this.fetchPublicMeetingDetails(meeting.id);
                if (loadSeq !== this.meetingDetailsLoadSeq || this.state.selectedMeetingId !== meeting.id) return;
                if (includeParticipants) {
                    this.state.participants = Array.isArray(details?.participants) ? details.participants : [];
                }
                this.state.chat = Array.isArray(details?.chat) ? details.chat : [];
                this.state.transcript = Array.isArray(details?.transcript) ? details.transcript : [];
                this.state.artifacts = Array.isArray(details?.artifacts) ? details.artifacts : [];
                this.state.recordings = Array.isArray(details?.recordings) ? details.recordings : [];
                this.state.tasks = Array.isArray(details?.tasks) ? details.tasks : [];
                this.state.decisions = Array.isArray(details?.decisions) ? details.decisions : [];
                this.state.agents = Array.isArray(details?.agents) ? details.agents : [];
            } catch (error) {
                if (loadSeq !== this.meetingDetailsLoadSeq || this.state.selectedMeetingId !== meeting.id) return;
                if (includeParticipants) {
                    this.state.participants = [];
                }
                this.state.chat = [];
                this.state.transcript = [];
                this.state.artifacts = [];
                this.state.recordings = [];
                this.state.tasks = [];
                this.state.decisions = [];
                this.state.agents = [];
            }
            return;
        }
        let detailsPayload = null;
        let chatPayload;
        let transcriptPayload = { transcript: [] };
        let artifactPayload = { artifacts: [], recordings: [], tasks: [], decisions: [] };
        let agentPayload = { agents: [] };
        try {
            const canManageMeetingData = this.canManageRooms();
            if (canManageMeetingData) {
                [detailsPayload, chatPayload, transcriptPayload, artifactPayload, agentPayload] = await Promise.all([
                    runTool('webmeet_meeting_get', { meetingId: meeting.id }),
                    runTool('webmeet_chat_list', { meetingId: meeting.id }),
                    runTool('webmeet_transcript_list', { meetingId: meeting.id }),
                    runTool('webmeet_artifact_list', { meetingId: meeting.id }),
                    runTool('webmeet_agent_list', { meetingId: meeting.id })
                ]);
            } else {
                [detailsPayload, chatPayload] = await Promise.all([
                    runTool('webmeet_meeting_get', { meetingId: meeting.id }),
                    runTool('webmeet_chat_list', { meetingId: meeting.id })
                ]);
            }
        } catch (error) {
            if (loadSeq !== this.meetingDetailsLoadSeq || this.state.selectedMeetingId !== meeting.id) return;
            if (!isMissingMeetingError(error)) {
                throw error;
            }
            const stillListed = await this.refreshMeetingsAfterMissingMeeting(meeting.id);
            if (loadSeq !== this.meetingDetailsLoadSeq || this.state.selectedMeetingId !== meeting.id) return;
            if (stillListed) {
                return;
            }
            this.state.meetings = this.state.meetings.filter((entry) => entry.id !== meeting.id);
            this.state.selectedMeetingId = '';
            this.state.chat = [];
            this.state.transcript = [];
            this.state.artifacts = [];
            this.state.recordings = [];
            this.state.tasks = [];
            this.state.decisions = [];
            this.state.agents = [];
            this.state.session = null;
            this.state.participants = [];
            this.state.participantAudioSettings = {};
            this.setError('Room is no longer available. Refreshing rooms.');
            return;
        }
        if (loadSeq !== this.meetingDetailsLoadSeq || this.state.selectedMeetingId !== meeting.id) return;
        if (includeParticipants) {
            this.state.participants = Array.isArray(detailsPayload?.participants) ? detailsPayload.participants : [];
        }
        this.state.chat = Array.isArray(chatPayload.messages) ? chatPayload.messages : [];
        this.state.transcript = Array.isArray(transcriptPayload.transcript) ? transcriptPayload.transcript : [];
        this.state.artifacts = Array.isArray(artifactPayload.artifacts) ? artifactPayload.artifacts : [];
        this.state.recordings = Array.isArray(artifactPayload.recordings) ? artifactPayload.recordings : [];
        this.state.tasks = Array.isArray(artifactPayload.tasks) ? artifactPayload.tasks : [];
        this.state.decisions = Array.isArray(artifactPayload.decisions) ? artifactPayload.decisions : [];
        this.state.agents = Array.isArray(agentPayload.agents) ? agentPayload.agents : [];
    },

    applyMeetingRename(meetingId, title, updatedAt = '') {
        const targetMeetingId = String(meetingId || '').trim();
        const nextTitle = String(title || '').trim();
        if (!targetMeetingId || !nextTitle) return false;
        let changed = false;
        const updateEntry = (entry) => {
            if (!entry || String(entry.id || '').trim() !== targetMeetingId) return;
            if (entry.title !== nextTitle) {
                entry.title = nextTitle;
                changed = true;
            }
            if (updatedAt && entry.updatedAt !== updatedAt) {
                entry.updatedAt = updatedAt;
            }
        };
        this.state.meetings.forEach(updateEntry);
        updateEntry(this.state.session?.meeting);
        if (changed) {
            this.renderMeetingList();
            this.renderMeetingSummary();
        }
        return changed;
    },

    async handleParticipantRosterEvent(event) {
        let eventData = {};
        try {
            eventData = JSON.parse(String(event?.data || '{}'));
        } catch (_) {
            return;
        }
        const payload = eventData?.payload || eventData;
        const meetingId = String(payload?.meetingId || eventData?.meetingId || this.state.selectedMeetingId || '').trim();
        const participantId = String(payload?.participantId || eventData?.participantId || '').trim();
        if (!meetingId) return;

        if (participantId && (eventData.type === 'participant.left' || eventData.type === 'participant.timed_out')) {
            this.removeParticipantFromMeetingList(meetingId, participantId);
            this.renderMeetingList();
        }

        try {
            await this.loadParticipantsForMeetings();
            if (meetingId && meetingId === String(this.state.selectedMeetingId || '').trim()) {
                await this.refreshMeetingDetailsFromRealtimeEvent();
            }
            this.renderMeetingList();
        } catch (_) {
            // Keep the immediate event update; the next event or explicit room load can resync.
        }
    }
};
