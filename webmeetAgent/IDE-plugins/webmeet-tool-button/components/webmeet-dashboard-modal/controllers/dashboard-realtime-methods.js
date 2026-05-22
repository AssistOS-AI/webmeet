import { normalizeAvatarConfig } from '../services/webmeet-profile-avatar-runtime.js';
import { buildWebMeetAvatarSource } from '../services/webmeet-avatar-override.js';
import { runWebMeetTool } from '../services/webmeet-api-client.js';
import {
    WEBMEET_EVENT_TYPES,
    buildWebMeetEvent,
    parseWebMeetEvent
} from '../services/webmeet-events.js';

const runTool = runWebMeetTool;
const AUTHENTICATED_WORKSPACE_EVENT_POLL_MS = 5000;

export const dashboardRealtimeMethods = {
    async publishRealtimePayload(payload) {
        if (!this.room?.localParticipant || !payload || typeof payload !== 'object') return;
        const room = String(payload.meetingId || payload.workspaceId || this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim();
        const type = String(payload.type || '').trim();
        if (!room || !type) return;
        const event = buildWebMeetEvent(room, type, payload);
        const encoder = new TextEncoder();
        await this.room.localParticipant.publishData(encoder.encode(event), { reliable: true });
    },

    async requestRoomAvatarState() {
        const meetingId = String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim();
        const participantId = String(this.state.session?.participantIdentity || '').trim();
        if (!meetingId || !participantId) return;
        await this.publishRealtimePayload({
            type: WEBMEET_EVENT_TYPES.PARTICIPANT_AVATAR_REQUEST,
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
                        this.lastWorkspaceEventId = parseWebMeetEvent(events[events.length - 1]).id || this.lastWorkspaceEventId;
                    }
                    return;
                }
                for (const event of events) {
                    this.lastWorkspaceEventId = parseWebMeetEvent(event).id || this.lastWorkspaceEventId;
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

    emitWebMeetInternalEvent(source, eventData = '', meta = {}) {
        const parsed = parseWebMeetEvent(eventData);
        const detail = {
            source: String(source || 'unknown').trim() || 'unknown',
            event: parsed.encoded,
            parsed,
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
        const parsed = detail?.parsed || parseWebMeetEvent(detail?.event);
        const eventData = parsed.payload || {};
        const source = String(detail?.source || '').trim();
        const event = { data: parsed.encoded };
        const type = parsed.type;
        const payload = eventData;
        const meetingId = String(payload?.meetingId || parsed.room || '').trim();
        const selectedMeetingId = String(this.selectedMeeting?.id || this.state.selectedMeetingId || '').trim();
        if (meetingId && selectedMeetingId && meetingId !== selectedMeetingId && source !== 'authenticated-workspace') {
            return;
        }
        if (type === WEBMEET_EVENT_TYPES.CHAT_REALTIME) {
            if (!meetingId || meetingId === selectedMeetingId) {
                if (!this.state.chat) this.state.chat = [];
                this.state.chat.push(eventData.message);
                this.renderFeedLists();
            }
            return;
        }
        if (type === WEBMEET_EVENT_TYPES.MEETING_RENAMED) {
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
        if (source === 'livekit' && type === WEBMEET_EVENT_TYPES.PARTICIPANT_AVATAR_REQUEST) {
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
        if ([WEBMEET_EVENT_TYPES.PARTICIPANT_JOINED, WEBMEET_EVENT_TYPES.PARTICIPANT_LEFT, WEBMEET_EVENT_TYPES.PARTICIPANT_TIMED_OUT, WEBMEET_EVENT_TYPES.PARTICIPANT_AVATAR_UPDATED, WEBMEET_EVENT_TYPES.PARTICIPANT_AVATAR_PROJECTED].includes(type)) {
            if (source === 'livekit' && type === WEBMEET_EVENT_TYPES.PARTICIPANT_AVATAR_PROJECTED) {
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
        if ([WEBMEET_EVENT_TYPES.AGENT_DISPATCHED, WEBMEET_EVENT_TYPES.AGENT_DETACHED, WEBMEET_EVENT_TYPES.TRANSCRIPT_UPDATED, WEBMEET_EVENT_TYPES.CHAT_MESSAGE_CREATED, WEBMEET_EVENT_TYPES.ARTIFACT_CREATED, WEBMEET_EVENT_TYPES.RECORDING_STARTED, WEBMEET_EVENT_TYPES.RECORDING_STOPPED].includes(type)) {
            if (source === 'authenticated-workspace' && [WEBMEET_EVENT_TYPES.AGENT_DISPATCHED, WEBMEET_EVENT_TYPES.AGENT_DETACHED].includes(type)) {
                this.scheduleWorkspaceRosterRefresh();
                return;
            }
            this.runBestEffortRealtimeRefresh(() => this.refreshMeetingDetailsFromRealtimeEvent());
            return;
        }
        if (type === WEBMEET_EVENT_TYPES.PROFILE_AVATAR_UPDATED) {
            this.handleProfileAvatarWorkspaceEvent(event);
            return;
        }
        if (type === WEBMEET_EVENT_TYPES.MEETING_CREATED) {
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
        const payload = parseWebMeetEvent(event?.data).payload;
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
