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
        return this.runTool('webmeet_room_join', {
            ...payload,
            roomId: requireString(payload.roomId || payload.meetingId, 'roomId')
        });
    }

    async refreshJoinMaterial(payload = {}) {
        return this.joinMeeting(payload);
    }

    async leaveMeeting({ meetingId = '', roomId = '', participantId = '' } = {}) {
        return this.runTool('webmeet_room_leave', {
            roomId: requireString(roomId || meetingId, 'roomId'),
            participantId: requireString(participantId, 'participantId')
        });
    }

    async publishAvatar({ meetingId = '', roomId = '', participantId = '', avatar = null } = {}) {
        return this.runTool('webmeet_participant_avatar_update', {
            roomId: requireString(roomId || meetingId, 'roomId'),
            participantId: requireString(participantId, 'participantId'),
            avatar: requireObject(avatar, 'avatar')
        });
    }

    async sendChat({ meetingId = '', roomId = '', message = '' } = {}) {
        return this.runTool('webmeet_chat_send', {
            roomId: requireString(roomId || meetingId, 'roomId'),
            message: requireString(message, 'message')
        });
    }

}

export class GuestWebMeetRoomApi {
    constructor(options = {}) {
        this.runTool = assertFunction(options.runTool, 'runTool');
    }

    async joinMeeting(payload = {}) {
        return this.runTool('webmeet_room_join_guest', {
            ...payload,
            roomId: requireString(payload.roomId || payload.meetingId, 'roomId'),
            displayName: requireString(payload.displayName, 'displayName')
        });
    }

    async refreshJoinMaterial(payload = {}) {
        return this.joinMeeting(payload);
    }

    async leaveMeeting({ meetingId = '', roomId = '', participantId = '' } = {}) {
        return this.runTool('webmeet_room_leave', {
            roomId: requireString(roomId || meetingId, 'roomId'),
            participantId: requireString(participantId, 'participantId')
        });
    }

    async publishAvatar({ meetingId = '', roomId = '', participantId = '', avatar = null } = {}) {
        return this.runTool('webmeet_participant_avatar_update', {
            roomId: requireString(roomId || meetingId, 'roomId'),
            participantId: requireString(participantId, 'participantId'),
            avatar: requireObject(avatar, 'avatar')
        });
    }

    async sendChat({ meetingId = '', roomId = '', message = '' } = {}) {
        return this.runTool('webmeet_chat_send', {
            roomId: requireString(roomId || meetingId, 'roomId'),
            message: requireString(message, 'message')
        });
    }

    async loadRoomState({ meetingId = '', roomId = '' } = {}) {
        return this.runTool('webmeet_room_get', {
            roomId: requireString(roomId || meetingId, 'roomId'),
            includeParticipants: true
        });
    }
}

export function createWebMeetRoomApi(options = {}) {
    return options.guest
        ? new GuestWebMeetRoomApi(options)
        : new AuthenticatedWebMeetRoomApi(options);
}
