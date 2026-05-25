function assertFunction(value, name) {
    if (typeof value !== 'function') {
        throw new Error(`Missing WebMeet room dependency: ${name}`);
    }
    return value;
}

function requireString(value, name) {
    const normalized = String(value || '').trim();
    if (!normalized) {
        throw new Error(`Missing WebMeet room field: ${name}`);
    }
    return normalized;
}

function requireObject(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Missing WebMeet room field: ${name}`);
    }
    return value;
}

export class AuthenticatedWebMeetRoomApi {
    constructor(options = {}) {
        this.runTool = assertFunction(options.runTool, 'runTool');
    }

    async joinMeeting(payload = {}) {
        return this.runTool('webmeet_meeting_join', payload);
    }

    async leaveMeeting({ meetingId = '', participantId = '' } = {}) {
        return this.runTool('webmeet_meeting_leave', {
            meetingId: requireString(meetingId, 'meetingId'),
            participantId: requireString(participantId, 'participantId')
        });
    }

    async publishAvatar({ meetingId = '', participantId = '', avatar = null } = {}) {
        return this.runTool('webmeet_participant_avatar_update', {
            meetingId: requireString(meetingId, 'meetingId'),
            participantId: requireString(participantId, 'participantId'),
            avatar: requireObject(avatar, 'avatar')
        });
    }

    async sendChat({ meetingId = '', message = '' } = {}) {
        return this.runTool('webmeet_chat_send', {
            meetingId: requireString(meetingId, 'meetingId'),
            message: requireString(message, 'message')
        });
    }

    async presencePing({ meetingId = '', participantId = '' } = {}) {
        return this.runTool('webmeet_meeting_presence_ping', {
            meetingId: requireString(meetingId, 'meetingId'),
            participantId: requireString(participantId, 'participantId')
        });
    }
}

export class GuestWebMeetRoomApi {
    constructor(options = {}) {
        this.callPublicGuestApi = assertFunction(options.callPublicGuestApi, 'callPublicGuestApi');
    }

    async joinMeeting() {
        throw new Error('Guest room sessions are created by the public invite join endpoint.');
    }

    async leaveMeeting({ meetingId = '' } = {}) {
        return this.callPublicGuestApi(requireString(meetingId, 'meetingId'), 'guest-leave', {});
    }

    async publishAvatar({ meetingId = '', avatar = null } = {}) {
        return this.callPublicGuestApi(
            requireString(meetingId, 'meetingId'),
            'guest-avatar',
            { avatar: requireObject(avatar, 'avatar') }
        );
    }

    async sendChat({ meetingId = '', message = '' } = {}) {
        return this.callPublicGuestApi(
            requireString(meetingId, 'meetingId'),
            'guest-chat',
            { message: requireString(message, 'message') }
        );
    }

    async presencePing({ meetingId = '' } = {}) {
        return this.callPublicGuestApi(requireString(meetingId, 'meetingId'), 'guest-presence', {});
    }

    async loadRoomState({ meetingId = '' } = {}) {
        return this.callPublicGuestApi(requireString(meetingId, 'meetingId'), 'guest-state', {});
    }
}

export function createWebMeetRoomApi(options = {}) {
    return options.guest
        ? new GuestWebMeetRoomApi(options)
        : new AuthenticatedWebMeetRoomApi(options);
}
