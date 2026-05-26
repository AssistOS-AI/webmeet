export class MeetingPresenceController {
    constructor(options = {}) {
        this.getContext = typeof options.getContext === 'function' ? options.getContext : (() => ({}));
        this.buildLeaveRequest = typeof options.buildLeaveRequest === 'function' ? options.buildLeaveRequest : null;

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
        this.unregisterWindowHandlers();
    }
}
