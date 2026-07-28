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
    assertGuestRoomAccess,
    assertVerifiedGuestParticipantIdentity
} from './roomParticipants.mjs';
import {
    WEBMEET_EVENT_TYPES
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';

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
    return decryptRoomPayload(context, record).chatMessages;
}

export async function appendRoomChat(context, {
    meetingId,
    authorId,
    authorName,
    message,
    kind = 'user',
    metadata = null,
    dedupeCommandId = '',
    authInfo = null,
    skipAccessCheck = false
}, deps = {}) {
    const { randomId, cleanupRoomPresence } = getDeps(deps);
    if (!skipAccessCheck) {
        await deps.getRoomDetails(context, meetingId, authInfo, { includeParticipants: false });
    }
    await cleanupRoomPresence(context, meetingId);
    let chatMessage = null;
    let deduplicated = false;
    await mutateRoom(context, meetingId, (_record, payload, stageEvent) => {
        const commandId = String(dedupeCommandId || '').trim();
        if (commandId) {
            const existing = payload.chatMessages.find((entry) => entry.kind === 'event' && entry.metadata?.commandId === commandId);
            if (existing) {
                chatMessage = existing;
                deduplicated = true;
                return;
            }
        }
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
    return { message: chatMessage, deduplicated };
}

export async function updateRoomChat(context, {
    meetingId,
    messageId,
    message,
    metadata,
    authInfo = null,
    skipAccessCheck = false
}, deps = {}) {
    if (!skipAccessCheck) {
        await deps.getRoomDetails(context, meetingId, authInfo, { includeParticipants: false });
    }
    let chatMessage = null;
    await mutateRoom(context, meetingId, (_record, payload, stageEvent) => {
        const index = payload.chatMessages.findIndex((entry) => entry.id === messageId);
        if (index < 0) throw new Error('Event audit message was not found.');
        chatMessage = {
            ...payload.chatMessages[index],
            message: String(message ?? payload.chatMessages[index].message ?? ''),
            metadata: metadata && typeof metadata === 'object'
                ? metadata
                : payload.chatMessages[index].metadata,
            updatedAt: nowIso()
        };
        payload.chatMessages[index] = chatMessage;
        stageEvent('meeting', WEBMEET_EVENT_TYPES.CHAT_MESSAGE_UPDATED, {
            meetingId,
            chatMessageId: chatMessage.id
        });
    });
    return { message: chatMessage };
}

export async function appendGuestRoomChat(context, { meetingId, participantId, message }, deps = {}) {
    await getDeps(deps).cleanupRoomPresence(context, meetingId);
    const record = await loadRoomRecord(context, meetingId);
    assertGuestRoomAccess(record);
    const payload = decryptRoomPayload(context, record);
    const participant = assertVerifiedGuestParticipantIdentity(context, meetingId, payload, participantId);
    return appendRoomChat(context, {
        meetingId,
        authorId: participant.id,
        authorName: participant.displayName || 'Guest',
        message,
        skipAccessCheck: true
    }, deps);
}
