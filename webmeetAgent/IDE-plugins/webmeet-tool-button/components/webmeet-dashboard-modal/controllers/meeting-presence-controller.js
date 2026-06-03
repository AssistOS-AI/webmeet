export class MeetingPresenceController {
    constructor(options = {}) {
        this.getContext = typeof options.getContext === 'function' ? options.getContext : (() => ({}));
        this.cleanupLocalMedia = typeof options.cleanupLocalMedia === 'function' ? options.cleanupLocalMedia : null;
        this.disconnectLiveKit = typeof options.disconnectLiveKit === 'function' ? options.disconnectLiveKit : null;
        this.leaveCurrentSession = typeof options.leaveCurrentSession === 'function' ? options.leaveCurrentSession : null;

        this.lastKeepaliveLeaveKey = '';
        this.windowHandlersRegistered = false;

        this.handlePageHide = () => {
            this.leaveCurrentSessionOnWindowExit();
        };
        this.handleBeforeUnload = () => {
            this.leaveCurrentSessionOnWindowExit();
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

    leaveCurrentSessionOnWindowExit() {
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

        try {
            this.cleanupLocalMedia?.();
        } catch (_) {
            // Browser teardown must continue even when media cleanup fails.
        }
        try {
            void Promise.resolve(this.disconnectLiveKit?.()).catch(() => {});
        } catch (_) {
            // LiveKit also disconnects on page teardown; this is best effort.
        }
        try {
            void Promise.resolve(this.leaveCurrentSession?.({
                meetingId: safeMeetingId,
                participantId: safeParticipantId
            })).catch(() => {});
        } catch (_) {
            // Leave persistence is best effort during browser teardown.
        }
    }

    teardown() {
        this.unregisterWindowHandlers();
    }
}
