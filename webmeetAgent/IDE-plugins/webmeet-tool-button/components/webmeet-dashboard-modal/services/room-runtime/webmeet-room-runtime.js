import { createWebMeetRoomApi } from './webmeet-room-api.js';
import { runWebMeetTool } from '../webmeet-api-client.js';

export class WebMeetRoomRuntime {
    constructor(options = {}) {
        this.getSession = typeof options.getSession === 'function' ? options.getSession : (() => null);
        this.isGuestSession = typeof options.isGuestSession === 'function' ? options.isGuestSession : (() => false);
        this.callPublicGuestApi = typeof options.callPublicGuestApi === 'function'
            ? options.callPublicGuestApi
            : (() => Promise.resolve({}));
        this.connectRoom = typeof options.connectRoom === 'function' ? options.connectRoom : (() => Promise.resolve());
        this.disconnectRoom = typeof options.disconnectRoom === 'function' ? options.disconnectRoom : (() => Promise.resolve());
        this.runTool = typeof options.runTool === 'function' ? options.runTool : runWebMeetTool;
    }

    getApi() {
        return createWebMeetRoomApi({
            guest: this.isGuestSession(),
            callPublicGuestApi: this.callPublicGuestApi,
            runTool: this.runTool
        });
    }

    async joinAuthenticated(payload = {}) {
        return this.getApi().joinMeeting(payload);
    }

    async connect() {
        return this.connectRoom();
    }

    async disconnect(options = {}) {
        return this.disconnectRoom(options);
    }

    async leaveCurrentSession() {
        const session = this.getSession() || {};
        const meetingId = String(session?.meeting?.id || '').trim();
        const participantId = String(session?.participantIdentity || '').trim();
        return this.getApi().leaveMeeting({ meetingId, participantId });
    }

    async publishAvatar(avatar = null) {
        const session = this.getSession() || {};
        const meetingId = String(session?.meeting?.id || '').trim();
        const participantId = String(session?.participantIdentity || '').trim();
        return this.getApi().publishAvatar({ meetingId, participantId, avatar });
    }

    async sendChat(meetingId = '', message = '') {
        return this.getApi().sendChat({ meetingId, message });
    }

    async presencePing() {
        const session = this.getSession() || {};
        const meetingId = String(session?.meeting?.id || '').trim();
        const participantId = String(session?.participantIdentity || '').trim();
        return this.getApi().presencePing({ meetingId, participantId });
    }

    async loadGuestRoomState(meetingId = '') {
        return this.getApi().loadRoomState?.({ meetingId }) || {};
    }
}
