import { WEBMEET_EVENT_TYPES, buildWebMeetEvent, parseWebMeetEvent } from '../webmeet-events.js';

export const ROOM_EVENT_TYPES = Object.freeze({
    JOINED: 'room:joined',
    LEFT: 'room:left',
    ARCHIVED: 'room:archived',
    PARTICIPANT_JOINED: 'room:participant-joined',
    PARTICIPANT_LEFT: 'room:participant-left',
    CHAT: 'room:chat',
    AVATAR_PROJECTED: 'room:avatar-projected',
    AGENT_ATTACHED: 'room:agent-attached'
});

const ROOM_EVENT_BY_WEBMEET_TYPE = Object.freeze({
    [WEBMEET_EVENT_TYPES.PARTICIPANT_JOINED]: ROOM_EVENT_TYPES.PARTICIPANT_JOINED,
    [WEBMEET_EVENT_TYPES.PARTICIPANT_LEFT]: ROOM_EVENT_TYPES.PARTICIPANT_LEFT,
    [WEBMEET_EVENT_TYPES.PARTICIPANT_TIMED_OUT]: ROOM_EVENT_TYPES.PARTICIPANT_LEFT,
    [WEBMEET_EVENT_TYPES.MEETING_ARCHIVED]: ROOM_EVENT_TYPES.ARCHIVED,
    [WEBMEET_EVENT_TYPES.CHAT_REALTIME]: ROOM_EVENT_TYPES.CHAT,
    [WEBMEET_EVENT_TYPES.PARTICIPANT_AVATAR_PROJECTED]: ROOM_EVENT_TYPES.AVATAR_PROJECTED,
    [WEBMEET_EVENT_TYPES.AGENT_DISPATCHED]: ROOM_EVENT_TYPES.AGENT_ATTACHED
});

export class WebMeetRoomEvents {
    build(roomId, type, payload = {}) {
        return buildWebMeetEvent(roomId, type, payload);
    }

    parse(encodedEvent) {
        return parseWebMeetEvent(encodedEvent);
    }

    resolveRoomEventType(webMeetEventType) {
        return ROOM_EVENT_BY_WEBMEET_TYPE[String(webMeetEventType || '').trim()] || '';
    }
}
