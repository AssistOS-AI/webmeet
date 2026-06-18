import {
    assertAdminAuthInfo,
    canViewMeetingRecord
} from '../store/accessPolicy.mjs';
import {
    buildRoomView,
    mutateRoom
} from '../store/roomRecords.mjs';
import {
    closeLiveKitRoom
} from '../runtime/livekitRuntime.mjs';
import {
    WEBMEET_EVENT_TYPES
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';

function nowIso() {
    return new Date().toISOString();
}

export async function archiveRoom(context, meetingId, authInfo = null, deps = {}) {
    assertAdminAuthInfo(authInfo);
    const targetMeetingId = String(meetingId || '').trim();
    if (!targetMeetingId) {
        throw new Error('Room not found.');
    }
    let record = null;
    const removedParticipants = [];
    await mutateRoom(context, targetMeetingId, async (current, payload, stageEvent) => {
        if (!canViewMeetingRecord(current, authInfo)) {
            throw new Error('Room not found.');
        }
        if (current.roomName) {
            await closeLiveKitRoom(context, current.roomName, { strict: true });
        }
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
        stageEvent('meeting', WEBMEET_EVENT_TYPES.MEETING_ARCHIVED, {
            meetingId: targetMeetingId,
            roomId: targetMeetingId,
            archivedAt
        });
        stageEvent('workspace', WEBMEET_EVENT_TYPES.MEETING_ARCHIVED, {
            workspaceId: 'rooms',
            meetingId: targetMeetingId,
            roomId: targetMeetingId,
            archivedAt
        });
    });
    if (typeof deps.detachActiveAgentsWhenRoomHasNoHumans === 'function') {
        await deps.detachActiveAgentsWhenRoomHasNoHumans(context, targetMeetingId, 'room_archived').catch(() => []);
    }
    return {
        ok: true,
        meeting: buildRoomView(record),
        removedParticipants
    };
}
