const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

export class MeetingPresenceController {
    constructor(options = {}) {
        this.runTool = options.runTool;
        this.heartbeatIntervalMs = Number(options.heartbeatIntervalMs) || DEFAULT_HEARTBEAT_INTERVAL_MS;
        this.getContext = typeof options.getContext === 'function' ? options.getContext : (() => ({}));
        this.shouldPing = typeof options.shouldPing === 'function' ? options.shouldPing : (() => true);
        this.buildLeaveRequest = typeof options.buildLeaveRequest === 'function' ? options.buildLeaveRequest : null;

        this.heartbeatTimer = null;
        this.lastKeepaliveLeaveKey = '';
        this.windowHandlersRegistered = false;

        this.handlePageHide = () => {
            this.sendLeaveKeepaliveForCurrentSession();
        };
        this.handleBeforeUnload = () => {
            this.sendLeaveKeepaliveForCurrentSession();
        };
    }

    registerWindowHandlers() {
        if (this.windowHandlersRegistered) return;
        window.addEventListener('pagehide', this.handlePageHide);
        window.addEventListener('beforeunload', this.handleBeforeUnload);
        this.windowHandlersRegistered = true;
    }

    unregisterWindowHandlers() {
        if (!this.windowHandlersRegistered) return;
        window.removeEventListener('pagehide', this.handlePageHide);
        window.removeEventListener('beforeunload', this.handleBeforeUnload);
        this.windowHandlersRegistered = false;
    }

    getMeetingAndParticipant() {
        const context = this.getContext() || {};
        return {
            meetingId: String(context.meetingId || '').trim(),
            participantId: String(context.participantId || '').trim()
        };
    }

    async sendPresencePing() {
        const { meetingId, participantId } = this.getMeetingAndParticipant();
        if (!meetingId || !participantId || typeof this.runTool !== 'function') return;
        try {
            await this.runTool('webmeet_meeting_presence_ping', { meetingId, participantId });
        } catch (_) {
            // ignore transient ping failures
        }
    }

    startHeartbeat() {
        this.stopHeartbeat();
        void this.sendPresencePing();
        this.heartbeatTimer = window.setInterval(() => {
            if (!this.shouldPing()) return;
            void this.sendPresencePing();
        }, this.heartbeatIntervalMs);
    }

    stopHeartbeat() {
        if (!this.heartbeatTimer) return;
        window.clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }

    sendLeaveKeepaliveForCurrentSession() {
        const { meetingId, participantId } = this.getMeetingAndParticipant();
        this.sendLeaveKeepalive(meetingId, participantId);
    }

    sendLeaveKeepalive(meetingId, participantId) {
        const safeMeetingId = String(meetingId || '').trim();
        const safeParticipantId = String(participantId || '').trim();
        if (!safeMeetingId || !safeParticipantId) return;
        const key = `${safeMeetingId}:${safeParticipantId}`;
        if (this.lastKeepaliveLeaveKey === key) return;
        this.lastKeepaliveLeaveKey = key;

        const request = this.buildLeaveRequest?.({
            meetingId: safeMeetingId,
            participantId: safeParticipantId
        });
        const endpoint = String(request?.url || '').trim();
        if (!endpoint) return;
        const body = JSON.stringify(request?.body || { participantId: safeParticipantId });
        try {
            if (navigator?.sendBeacon) {
                const blob = new Blob([body], { type: 'application/json' });
                const sent = navigator.sendBeacon(endpoint, blob);
                if (sent) return;
            }
        } catch (_) {
            // ignore sendBeacon errors, fallback to keepalive fetch
        }
        try {
            void fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                credentials: 'include',
                keepalive: true
            });
        } catch (_) {
            // ignore keepalive failures
        }
    }

    teardown() {
        this.stopHeartbeat();
        this.unregisterWindowHandlers();
    }
}
