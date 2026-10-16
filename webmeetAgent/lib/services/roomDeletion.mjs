import {
    assertAdminAuthInfo,
    canViewMeetingRecord
} from '../store/accessPolicy.mjs';
import { closeLiveKitRoom } from '../runtime/livekitRuntime.mjs';

export async function deleteRoom(context, {
    meetingId,
    confirmed = false,
    authInfo = null
} = {}, deps = {}) {
    assertAdminAuthInfo(authInfo);
    if (confirmed !== true) {
        throw new Error('Permanent room deletion requires explicit confirmation.');
    }

    const deleteRoomRecord = deps.deleteRoomRecord;
    if (typeof deleteRoomRecord !== 'function') {
        throw new Error('Permanent room deletion is unavailable.');
    }
    const targetMeetingId = String(meetingId || '').trim();
    await deleteRoomRecord(context, targetMeetingId, async (record) => {
        if (!canViewMeetingRecord(record, authInfo)) {
            throw new Error('Room not found.');
        }
        const roomName = String(record?.roomName || '').trim();
        if (!roomName) {
            throw new Error('Room has no LiveKit runtime identity.');
        }
        await closeLiveKitRoom(context, roomName, { strict: true });
    });
    return {
        ok: true,
        deleted: true,
        roomId: targetMeetingId
    };
}
