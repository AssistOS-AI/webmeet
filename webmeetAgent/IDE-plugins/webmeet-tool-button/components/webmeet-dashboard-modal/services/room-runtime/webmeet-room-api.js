import { runWebMeetTool } from '../webmeet-api-client.js';

export class AuthenticatedWebMeetRoomApi {
    constructor(options = {}) {
        this.runTool = typeof options.runTool === 'function' ? options.runTool : runWebMeetTool;
    }

    async joinMeeting(payload = {}) {
        return this.runTool('webmeet_meeting_join', payload);
    }

    async leaveMeeting({ meetingId = '', participantId = '' } = {}) {
        if (!meetingId || !participantId) return {};
        return this.runTool('webmeet_meeting_leave', { meetingId, participantId });
    }

    async publishAvatar({ meetingId = '', participantId = '', avatar = null } = {}) {
        if (!meetingId || !participantId || !avatar) return null;
        return this.runTool('webmeet_participant_avatar_update', { meetingId, participantId, avatar });
    }

    async sendChat({ meetingId = '', message = '' } = {}) {
        if (!meetingId || !message) return {};
        return this.runTool('webmeet_chat_send', { meetingId, message });
    }

    async presencePing({ meetingId = '', participantId = '' } = {}) {
        if (!meetingId || !participantId) return {};
        return this.runTool('webmeet_meeting_presence_ping', { meetingId, participantId });
    }
}

export class GuestWebMeetRoomApi {
    constructor(options = {}) {
        this.callPublicGuestApi = typeof options.callPublicGuestApi === 'function'
            ? options.callPublicGuestApi
            : (() => Promise.resolve({}));
    }

    async joinMeeting() {
        throw new Error('Guest room sessions are created by the public invite join endpoint.');
    }

    async leaveMeeting({ meetingId = '' } = {}) {
        if (!meetingId) return {};
        return this.callPublicGuestApi(meetingId, 'guest-leave', {});
    }

    async publishAvatar({ meetingId = '', avatar = null } = {}) {
        if (!meetingId || !avatar) return null;
        return this.callPublicGuestApi(meetingId, 'guest-avatar', { avatar });
    }

    async sendChat({ meetingId = '', message = '' } = {}) {
        if (!meetingId || !message) return {};
        return this.callPublicGuestApi(meetingId, 'guest-chat', { message });
    }

    async presencePing({ meetingId = '' } = {}) {
        if (!meetingId) return {};
        return this.callPublicGuestApi(meetingId, 'guest-presence', {});
    }

    async loadRoomState({ meetingId = '' } = {}) {
        if (!meetingId) return {};
        return this.callPublicGuestApi(meetingId, 'guest-state', {});
    }
}

export function createWebMeetRoomApi(options = {}) {
    return options.guest
        ? new GuestWebMeetRoomApi(options)
        : new AuthenticatedWebMeetRoomApi(options);
}
