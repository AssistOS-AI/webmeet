import {
    hasWebmeetRoomScope,
    isAdminAuthInfo,
    normalizeAuthInfo,
} from './accessPolicy.mjs';

export function authorizeRoomParticipantId(payload, authInfo = null, participantId = '', roomId = '') {
    const auth = normalizeAuthInfo(authInfo);
    const requestedId = String(participantId || '').trim();
    const fallbackId = String(auth.id || auth.principalId || '').trim();
    const targetId = requestedId || fallbackId;
    if (!targetId) {
        throw new Error('Access denied: participant authentication is required.');
    }
    if (isAdminAuthInfo(authInfo)) return targetId;

    const participant = (Array.isArray(payload?.members) ? payload.members : [])
        .find((entry) => String(entry?.id || '').trim() === targetId) || null;
    if (!auth.id) {
        if (hasWebmeetRoomScope(authInfo, roomId) && participant?.guest === true) return targetId;
        throw new Error('Access denied: participant authentication is required.');
    }
    const participantUserId = String(
        participant?.userId || participant?.attributes?.webmeetUserId || '',
    ).trim();
    if (!participant || participantUserId !== auth.id) {
        throw new Error('Access denied: cannot act as another participant.');
    }
    return targetId;
}
