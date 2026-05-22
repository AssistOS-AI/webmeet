import { normalizeAvatarConfig } from '../services/webmeet-profile-avatar-runtime.js';
import { buildWebMeetAvatarSource } from '../services/webmeet-avatar-override.js';
import { runWebMeetTool } from '../services/webmeet-api-client.js';

const runTool = runWebMeetTool;
const AUTHENTICATED_WORKSPACE_EVENT_POLL_MS = 5000;

export const dashboardRealtimeMethods = {
    async publishRealtimePayload(payload) {
        if (!this.room?.localParticipant || !payload || typeof payload !== 'object') return;
        const encoder = new TextEncoder();
        await this.room.localParticipant.publishData(encoder.encode(JSON.stringify(payload)), { reliable: true });
    },

    async requestRoomAvatarState() {
        const meetingId = String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim();
        const participantId = String(this.state.session?.participantIdentity || '').trim();
        if (!meetingId || !participantId) return;
        await this.publishRealtimePayload({
            type: 'participant.avatar.request',
            meetingId,
            participantId
        });
    },

    startWorkspaceEvents() {
        this.stopWorkspaceEvents();
        if (this.isGuestSession()) return;
        this.lastWorkspaceEventId = '';
        const targetWorkspaceId = String(this.state.selectedWorkspaceId || '').trim();
        if (!targetWorkspaceId) return;
        let initialized = false;
        const poll = async () => {
            if (this.isGuestSession()) return;
            const workspaceId = String(this.state.selectedWorkspaceId || '').trim();
            if (!workspaceId || workspaceId !== targetWorkspaceId) return;
            try {
                const payload = await runTool('webmeet_workspace_events_list', {
                    workspaceId,
                    afterId: this.lastWorkspaceEventId
                });
                const events = Array.isArray(payload?.events) ? payload.events : [];
                if (!initialized) {
                    initialized = true;
                    if (events.length) {
                        this.lastWorkspaceEventId = String(events[events.length - 1]?.id || this.lastWorkspaceEventId).trim();
                    }
                    return;
                }
                for (const event of events) {
                    this.lastWorkspaceEventId = String(event?.id || this.lastWorkspaceEventId).trim();
                    this.emitWebMeetInternalEvent('authenticated-workspace', event);
                }
            } catch (_) {
                // Authenticated workspace events are best-effort; explicit refresh/actions remain authoritative.
            } finally {
                if (!this.isGuestSession()) {
                    this.workspaceEventsPollTimer = window.setTimeout(poll, AUTHENTICATED_WORKSPACE_EVENT_POLL_MS);
                }
            }
        };
        this.workspaceEventsPollTimer = window.setTimeout(poll, 0);
    },

    stopWorkspaceEvents() {
        if (this.workspaceEventsPollTimer) {
            window.clearTimeout(this.workspaceEventsPollTimer);
            this.workspaceEventsPollTimer = null;
        }
    },

    emitWebMeetInternalEvent(source, eventData = {}, meta = {}) {
        const detail = {
            source: String(source || 'unknown').trim() || 'unknown',
            event: eventData && typeof eventData === 'object' ? eventData : {},
            meta: meta && typeof meta === 'object' ? meta : {}
        };
        try {
            window.dispatchEvent(new CustomEvent('webmeet:event', { detail }));
        } catch (_) {
            // Local app event dispatch is best-effort; the dashboard still applies the event below.
        }
        return this.handleWebMeetInternalEvent(detail);
    },

    handleWebMeetInternalEvent(detail = {}) {
        const eventData = detail?.event && typeof detail.event === 'object' ? detail.event : {};
        const source = String(detail?.source || '').trim();
        const event = { data: JSON.stringify(eventData || {}) };
        const type = String(eventData?.type || '').trim();
        const payload = eventData?.payload || eventData;
        const meetingId = String(payload?.meetingId || eventData?.meetingId || '').trim();
        const selectedMeetingId = String(this.selectedMeeting?.id || this.state.selectedMeetingId || '').trim();
        if (meetingId && selectedMeetingId && meetingId !== selectedMeetingId && source !== 'authenticated-workspace') {
            return;
        }
        if (type === 'chat') {
            if (!meetingId || meetingId === selectedMeetingId) {
                if (!this.state.chat) this.state.chat = [];
                this.state.chat.push(eventData.message);
                this.renderFeedLists();
            }
            return;
        }
        if (type === 'meeting.renamed') {
            this.applyMeetingRename(
                payload?.meetingId,
                payload?.title,
                eventData?.createdAt || ''
            );
            if (source === 'authenticated-workspace') {
                this.scheduleWorkspaceMeetingsRefresh();
            }
            return;
        }
        if (source === 'livekit' && type === 'participant.avatar.request') {
            const requesterParticipantId = String(
                detail?.meta?.participantId
                || payload?.participantId
                || eventData?.participantId
                || ''
            ).trim();
            const localParticipantId = String(this.state.session?.participantIdentity || this.room?.localParticipant?.identity || '').trim();
            if (!requesterParticipantId || !localParticipantId || requesterParticipantId === localParticipantId) {
                return;
            }
            void this.republishCurrentParticipantAvatarState?.().catch(() => {});
            return;
        }
        if (['participant.joined', 'participant.left', 'participant.timed_out', 'participant.avatar.updated'].includes(type)) {
            if (source === 'livekit' && type === 'participant.avatar.updated') {
                void (async () => {
                    this.applyRealtimeParticipantAvatar?.(eventData);
                    this.renderParticipantLayout();
                    this.renderMeetingList();
                })().catch(() => {});
                return;
            }
            if (source === 'authenticated-workspace') {
                this.scheduleWorkspaceRosterRefresh();
                return;
            }
            void this.handleParticipantRosterEvent(event);
            return;
        }
        if (['agent.dispatched', 'agent.detached', 'transcript.updated', 'chat.message.created', 'artifact.created', 'recording.started', 'recording.stopped'].includes(type)) {
            if (source === 'authenticated-workspace' && ['agent.dispatched', 'agent.detached'].includes(type)) {
                this.scheduleWorkspaceRosterRefresh();
                return;
            }
            this.runBestEffortRealtimeRefresh(() => this.refreshMeetingDetailsFromRealtimeEvent());
            return;
        }
        if (type === 'profile.avatar.updated') {
            this.handleProfileAvatarWorkspaceEvent(event);
            return;
        }
        if (type === 'meeting.created') {
            this.scheduleWorkspaceMeetingsRefresh();
        }
    },

    async handleAvatarSettingsUpdated(event) {
        if (this.isGuestSession()) return;
        if (String(event?.detail?.type || '').trim() !== 'profile') return;
        const eventUserId = String(event?.detail?.userId || '').trim();
        const currentUserId = String(this.currentActor?.id || '').trim();
        const hasInlineAvatar = Object.prototype.hasOwnProperty.call(event?.detail || {}, 'enabled')
            || Object.prototype.hasOwnProperty.call(event?.detail || {}, 'config');
            if (eventUserId && currentUserId && eventUserId !== currentUserId) {
                if (!hasInlineAvatar) return;
                const profileAvatar = {
                    enabled: event.detail.enabled !== false,
                    config: normalizeAvatarConfig(event.detail.config, `profile:${eventUserId}`),
                fallbackLetter: '',
                updatedAt: new Date().toISOString()
            };
            this.applyRealtimeParticipantAvatar?.({
                meetingId: String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim(),
                    userId: eventUserId,
                    profileAvatar
                });
                this.renderParticipantLayout();
                this.renderMeetingList();
                return;
            }
        if (!this.state.session?.participantIdentity) return;
        try {
            const currentOverride = this.loadCurrentWebMeetAvatarOverride?.() || null;
            this.state.webMeetAvatarOverride = currentOverride;
            let effectiveSourceAvatar = null;
            if (hasInlineAvatar) {
                const participantId = String(this.state.session?.participantIdentity || '').trim();
                const userId = String(currentUserId || event?.detail?.config?.agentId?.replace(/^profile:/, '') || '').trim();
                const fallbackAvatarId = `profile:${userId || participantId}`;
                const profileSourceAvatar = {
                    enabled: event.detail.enabled !== false,
                    config: normalizeAvatarConfig(event.detail.config, fallbackAvatarId),
                    fallbackLetter: '',
                    user: userId ? { id: userId } : null,
                    updatedAt: new Date().toISOString()
                };
                effectiveSourceAvatar = buildWebMeetAvatarSource({
                    profileAvatar: profileSourceAvatar,
                    override: currentOverride,
                    userId,
                    participantId
                });
                const profileAvatar = this.buildParticipantAvatarProjection(effectiveSourceAvatar, participantId);
                if (this.state.session?.participant) {
                    this.state.session.participant.profileAvatar = profileAvatar;
                }
                this.applyRealtimeParticipantAvatar?.({
                    meetingId: String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim(),
                    participantId,
                    userId,
                    profileAvatar
                });
                this.renderParticipantLayout();
                this.renderMeetingList();
                await this.publishCurrentParticipantAvatarState?.(profileAvatar, effectiveSourceAvatar);
            }
            await this.publishCurrentParticipantAvatar(hasInlineAvatar
                ? {
                    force: true,
                    avatar: effectiveSourceAvatar,
                    skipRealtime: true
                }
                : { force: true });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error || 'Avatar update failed.');
            this.setError(`Profile avatar was saved, but WebMeet could not publish the room avatar: ${message}`);
        }
    },

    handleProfileAvatarWorkspaceEvent(event) {
        let eventData = {};
        try {
            eventData = JSON.parse(String(event?.data || '{}'));
        } catch (_) {
            return;
        }
        const payload = eventData?.payload || eventData;
        const userId = String(payload?.userId || '').trim();
        if (!userId) return;
        const currentUserId = String(this.currentActor?.id || '').trim();
        if (
            currentUserId
            && userId === currentUserId
            && this.state.session?.participantIdentity
            && !this.isGuestSession()
        ) {
            const currentOverride = this.loadCurrentWebMeetAvatarOverride?.() || null;
            this.state.webMeetAvatarOverride = currentOverride;
            if (!currentOverride) {
                this.participantLayoutController?.refreshAvatarForUser?.(userId);
            }
            void this.publishCurrentParticipantAvatar({ force: true }).catch((error) => {
                const message = error instanceof Error ? error.message : String(error || 'Avatar update failed.');
                this.setError(`Profile avatar changed, but WebMeet could not publish the room avatar: ${message}`);
            });
        }
    }
};
