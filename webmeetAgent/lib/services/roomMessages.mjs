import crypto from 'node:crypto';

import {
    canViewMeetingRecord
} from '../store/accessPolicy.mjs';
import {
    decryptRoomPayload,
    loadRoomRecord,
    mutateRoom
} from '../store/roomRecords.mjs';
import {
    assertGuestParticipant,
    assertGuestRoomAccess
} from './roomParticipants.mjs';
import {
    WEBMEET_EVENT_TYPES
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/webmeet-events.js';

function nowIso() {
    return new Date().toISOString();
}

function getDeps(deps = {}) {
    return {
        randomId: typeof deps.randomId === 'function'
            ? deps.randomId
            : ((prefix) => `${prefix}_${crypto.randomUUID()}`),
        cleanupRoomPresence: typeof deps.cleanupRoomPresence === 'function'
            ? deps.cleanupRoomPresence
            : (async () => {})
    };
}

export async function listRoomChat(context, meetingId, authInfo = null, deps = {}) {
    const record = await loadRoomRecord(context, meetingId);
    if (!canViewMeetingRecord(record, authInfo)) {
        throw new Error('Meeting not found.');
    }
    await getDeps(deps).cleanupRoomPresence(context, meetingId);
    return decryptRoomPayload(context, await loadRoomRecord(context, meetingId)).chatMessages;
}

export async function appendRoomChat(context, {
    meetingId,
    authorId,
    authorName,
    message,
    kind = 'user',
    metadata = null,
    authInfo = null,
    skipAccessCheck = false
}, deps = {}) {
    const { randomId, cleanupRoomPresence } = getDeps(deps);
    if (!skipAccessCheck) {
        await deps.getRoomDetails(context, meetingId, authInfo, { includeParticipants: false });
    }
    await cleanupRoomPresence(context, meetingId);
    let chatMessage = null;
    await mutateRoom(context, meetingId, (_record, payload, stageEvent) => {
        chatMessage = {
            id: randomId('chat'),
            meetingId,
            authorId,
            authorName,
            message,
            kind: String(kind || 'user').trim() || 'user',
            createdAt: nowIso()
        };
        if (metadata && typeof metadata === 'object') {
            chatMessage.metadata = metadata;
        }
        payload.chatMessages.push(chatMessage);
        stageEvent('meeting', WEBMEET_EVENT_TYPES.CHAT_MESSAGE_CREATED, { meetingId, chatMessageId: chatMessage.id });
    });
    return { message: chatMessage };
}

export async function appendGuestRoomChat(context, { meetingId, participantId, message }, deps = {}) {
    await getDeps(deps).cleanupRoomPresence(context, meetingId);
    const record = await loadRoomRecord(context, meetingId);
    assertGuestRoomAccess(record);
    const payload = decryptRoomPayload(context, record);
    const participant = assertGuestParticipant(payload, participantId);
    return appendRoomChat(context, {
        meetingId,
        authorId: participant.id,
        authorName: participant.displayName || 'Guest',
        message,
        skipAccessCheck: true
    }, deps);
}
