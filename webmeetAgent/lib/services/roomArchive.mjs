import {
    assertAdminAuthInfo,
    canViewMeetingRecord,
    getAuthDisplayName,
    normalizeAuthInfo
} from '../store/accessPolicy.mjs';
import {
    buildRoomView,
    mutateRoom
} from '../store/roomRecords.mjs';
import {
    closeLiveKitRoom,
    getLiveKitParticipantIdentity,
    listLiveKitRoomParticipants,
    removeLiveKitRoomParticipant
} from '../runtime/livekitRuntime.mjs';
import {
    WEBMEET_EVENT_TYPES
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';

function nowIso() {
    return new Date().toISOString();
}

function randomArchiveEventId() {
    if (globalThis.crypto?.randomUUID) {
        return `event_${globalThis.crypto.randomUUID()}`;
    }
    return `event_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function resolveArchiveActor(authInfo = null) {
    const normalized = normalizeAuthInfo(authInfo);
    const archivedById = String(normalized.id || normalized.principalId || normalized.username || normalized.email || '').trim();
    const archivedByName = String(getAuthDisplayName(authInfo) || normalized.username || normalized.email || archivedById || '').trim();
    return { archivedById, archivedByName };
}

async function closeArchivedLiveKitRoom(context, roomName) {
    const targetRoomName = String(roomName || '').trim();
    if (!targetRoomName) return;
    let participants = [];
    try {
        participants = await listLiveKitRoomParticipants(context, targetRoomName);
    } catch (_) {
        return;
    }
    for (const participant of participants) {
        const identity = getLiveKitParticipantIdentity(participant);
        if (!identity) continue;
        await removeLiveKitRoomParticipant(context, targetRoomName, identity, { strict: false });
    }
    try {
        participants = await listLiveKitRoomParticipants(context, targetRoomName);
    } catch (_) {
        participants = [];
    }
    if (!participants.length) {
        await closeLiveKitRoom(context, targetRoomName, { strict: false });
    }
}

export async function archiveRoom(context, meetingId, authInfo = null, deps = {}) {
    assertAdminAuthInfo(authInfo);
    const targetMeetingId = String(meetingId || '').trim();
    if (!targetMeetingId) {
        throw new Error('Room not found.');
    }
    const archiveActor = resolveArchiveActor(authInfo);
    const archiveEventId = randomArchiveEventId();
    let record = null;
    let archiveEvent = null;
    let liveKitRoomName = '';
    const removedParticipants = [];
    await mutateRoom(context, targetMeetingId, async (current, payload, stageEvent) => {
        if (!canViewMeetingRecord(current, authInfo)) {
            throw new Error('Room not found.');
        }
        liveKitRoomName = String(current.roomName || '').trim();
        const archivedAt = nowIso();
        const members = Array.isArray(payload.members) ? payload.members : [];
        for (const member of members) {
            const participantId = String(member?.id || '').trim();
            if (!participantId) continue;
            removedParticipants.push({ ...member });
            stageEvent('meeting', WEBMEET_EVENT_TYPES.PARTICIPANT_LEFT, {
                meetingId: targetMeetingId,
                participantId,
                reason: 'room_archived'
            });
            stageEvent('workspace', WEBMEET_EVENT_TYPES.PARTICIPANT_LEFT, {
                workspaceId: 'rooms',
                meetingId: targetMeetingId,
                participantId,
                reason: 'room_archived'
            });
        }
        payload.members = [];
        current.status = 'archived';
        current.archivedAt = archivedAt;
        record = current;
        archiveEvent = {
            id: archiveEventId,
            createdAt: archivedAt,
            meetingId: targetMeetingId,
            roomId: targetMeetingId,
            archivedAt,
            archivedById: archiveActor.archivedById,
            archivedByName: archiveActor.archivedByName
        };
        stageEvent('meeting', WEBMEET_EVENT_TYPES.MEETING_ARCHIVED, archiveEvent);
        stageEvent('workspace', WEBMEET_EVENT_TYPES.MEETING_ARCHIVED, {
            ...archiveEvent,
            workspaceId: 'rooms',
        });
    });
    if (typeof deps.detachActiveAgentsWhenRoomHasNoHumans === 'function') {
        await deps.detachActiveAgentsWhenRoomHasNoHumans(context, targetMeetingId, 'room_archived').catch(() => []);
    }
    await closeArchivedLiveKitRoom(context, liveKitRoomName);
    return {
        ok: true,
        meeting: buildRoomView(record),
        removedParticipants,
        archiveEvent
    };
}
