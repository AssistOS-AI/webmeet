import {
    sanitizeParticipantAvatarPayload
} from '../policies/avatarPolicy.mjs';
import {
    buildRtcConfig
} from '../store/rtcConfig.mjs';
import {
    createLiveKitToken,
    getLiveKitParticipantIdentity,
    getParticipantAttributes,
    isLiveKitAgentParticipant,
    listLiveKitRoomParticipants,
    parseLiveKitProfileAvatar
} from '../runtime/livekitRuntime.mjs';
import {
    assertAdminAuthInfo,
    assertAuthenticatedAuthInfo,
    canViewMeetingRecord,
    getAuthDisplayName,
    hasWebmeetRoomScope,
    isAdminAuthInfo,
    isMeetingRecordOpen,
    normalizeAuthInfo
} from '../store/accessPolicy.mjs';
import {
    buildRoomView,
    decryptRoomPayload,
    getPresenceTtlMs,
    loadRoomRecord,
    mutateRoom
} from '../store/roomRecords.mjs';
import {
    WEBMEET_EVENT_TYPES
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/webmeet-events.js';

function nowIso() {
    return new Date().toISOString();
}

function toTimestamp(value) {
    const parsed = Date.parse(String(value || '').trim());
    return Number.isFinite(parsed) ? parsed : null;
}

function getParticipantDeps(deps = {}) {
    return {
        randomId: typeof deps.randomId === 'function'
            ? deps.randomId
            : ((prefix) => `${prefix}_${crypto.randomUUID()}`),
        detachActiveAgentsWhenRoomHasNoHumans: typeof deps.detachActiveAgentsWhenRoomHasNoHumans === 'function'
            ? deps.detachActiveAgentsWhenRoomHasNoHumans
            : (async () => [])
    };
}

function hasHumanRoomMembers(payload) {
    return Array.isArray(payload?.members) && payload.members.length > 0;
}

function scheduleEmptyRoomAgentDetach(context, meetingId, deps, reason = 'no_human_participants') {
    const targetMeetingId = String(meetingId || '').trim();
    const detachActiveAgents = getParticipantDeps(deps).detachActiveAgentsWhenRoomHasNoHumans;
    if (!targetMeetingId) return;
    setTimeout(() => {
        detachActiveAgents(context, targetMeetingId, reason).catch(() => {});
    }, 0);
}

function cleanupStaleMembers(context, meetingId, payload, stageEvent = null, deps = {}) {
    const now = Date.now();
    const ttlMs = getPresenceTtlMs(context.workspaceRoot);
    const members = Array.isArray(payload.members) ? payload.members : [];
    const kept = [];
    const removed = [];
    for (const member of members) {
        const lastSeenAt = toTimestamp(member?.lastSeenAt) ?? toTimestamp(member?.joinedAt);
        if (!lastSeenAt || (now - lastSeenAt) > ttlMs) {
            removed.push(member);
            continue;
        }
        kept.push(member);
    }
    if (removed.length > 0) {
        payload.members = kept;
        for (const member of removed) {
            const participantId = String(member?.id || '').trim();
            if (!participantId || !stageEvent) continue;
            stageEvent('meeting', WEBMEET_EVENT_TYPES.PARTICIPANT_TIMED_OUT, { meetingId, participantId });
        }
        if (kept.length === 0) {
            scheduleEmptyRoomAgentDetach(context, meetingId, deps, 'no_human_participants');
        }
    }
    return removed;
}

export async function cleanupRoomPresence(context, meetingId, deps = {}) {
    let removedCount = 0;
    await mutateRoom(context, meetingId, (_record, payload, stageEvent) => {
        removedCount = cleanupStaleMembers(context, meetingId, payload, stageEvent, deps).length;
        if (!hasHumanRoomMembers(payload)) {
            scheduleEmptyRoomAgentDetach(context, meetingId, deps, 'no_human_participants');
        }
    });
    return removedCount;
}

function projectLiveKitRoomParticipants(payload, liveParticipants) {
    const now = nowIso();
    const cachedMembers = Array.isArray(payload?.members) ? payload.members : [];
    const cachedById = new Map(cachedMembers.map((member) => [String(member?.id || '').trim(), member]).filter(([id]) => id));
    const projected = [];
    for (const liveParticipant of Array.isArray(liveParticipants) ? liveParticipants : []) {
        if (isLiveKitAgentParticipant(liveParticipant)) continue;
        const participantId = getLiveKitParticipantIdentity(liveParticipant);
        if (!participantId) continue;
        const cached = cachedById.get(participantId) || {};
        const liveAttributes = getParticipantAttributes(liveParticipant);
        projected.push({
            ...cached,
            id: participantId,
            displayName: String(liveParticipant?.name || cached.displayName || participantId).trim() || participantId,
            joinedAt: cached.joinedAt || now,
            lastSeenAt: now,
            pendingLiveKit: false,
            profileAvatar: parseLiveKitProfileAvatar(liveAttributes),
            attributes: {
                ...(cached.attributes && typeof cached.attributes === 'object' ? cached.attributes : {}),
                ...liveAttributes
            }
        });
    }
    return projected;
}

function shouldPreserveStoredMemberDuringReconcile(context, member) {
    if (member?.pendingLiveKit !== true) {
        return false;
    }
    const lastSeenAt = toTimestamp(member?.lastSeenAt) ?? toTimestamp(member?.joinedAt);
    if (!lastSeenAt) {
        return false;
    }
    return (Date.now() - lastSeenAt) <= getPresenceTtlMs(context.workspaceRoot);
}

function syncPayloadMembersToLiveKitParticipants(context, record, payload, participants, stageEvent) {
    const currentMembers = Array.isArray(payload.members) ? payload.members : [];
    const preservedMembers = currentMembers.filter((member) => {
        const participantId = String(member?.id || '').trim();
        if (!participantId) return false;
        if (participants.some((entry) => String(entry?.id || '').trim() === participantId)) return false;
        return shouldPreserveStoredMemberDuringReconcile(context, member);
    });
    const nextParticipants = [...participants, ...preservedMembers];
    const currentIds = new Set(currentMembers.map((member) => String(member?.id || '').trim()).filter(Boolean));
    const nextIds = new Set(nextParticipants.map((member) => String(member?.id || '').trim()).filter(Boolean));
    const membershipChanged = currentIds.size !== nextIds.size
        || [...currentIds].some((participantId) => !nextIds.has(participantId));

    payload.members = nextParticipants.map((member) => {
        const attributes = member?.attributes && typeof member.attributes === 'object'
            ? member.attributes
            : {};
        const {
            webmeetProfileAvatar: _webmeetProfileAvatar,
            ...durableAttributes
        } = attributes;
        const { profileAvatar: _profileAvatar, ...durableMember } = member || {};
        return {
            ...durableMember,
            ...(Object.keys(durableAttributes).length ? { attributes: durableAttributes } : {})
        };
    });
    if (membershipChanged) {
        for (const member of currentMembers) {
            const participantId = String(member?.id || '').trim();
            if (!participantId || nextIds.has(participantId)) continue;
            stageEvent('meeting', WEBMEET_EVENT_TYPES.PARTICIPANT_LEFT, {
                meetingId: record.meetingId,
                participantId,
                reason: 'livekit_reconcile'
            });
        }
        for (const member of participants) {
            const participantId = String(member?.id || '').trim();
            if (!participantId || currentIds.has(participantId)) continue;
            stageEvent('meeting', WEBMEET_EVENT_TYPES.PARTICIPANT_JOINED, {
                meetingId: record.meetingId,
                participantId,
                source: 'livekit_reconcile'
            });
        }
    }
    return nextParticipants;
}

export function projectStoredRoomParticipants(payload) {
    const members = Array.isArray(payload?.members) ? payload.members : [];
    return members
        .map((member) => ({
            ...member,
            id: String(member?.id || '').trim(),
            displayName: String(member?.displayName || member?.id || 'Participant').trim() || 'Participant'
        }))
        .filter((member) => member.id);
}

export async function getRealtimeRoomParticipants(context, record, payload, options = {}, deps = {}) {
    const liveParticipants = await listLiveKitRoomParticipants(context, record.roomName);
    if (options.preserveStoredMembersOnEmpty === true && liveParticipants.length === 0) {
        return projectStoredRoomParticipants(payload);
    }
    let reconciledParticipants = [];
    await mutateRoom(context, record.meetingId, (lockedRecord, lockedPayload, stageEvent) => {
        const participants = projectLiveKitRoomParticipants(lockedPayload, liveParticipants);
        reconciledParticipants = syncPayloadMembersToLiveKitParticipants(
            context,
            lockedRecord,
            lockedPayload,
            participants,
            stageEvent
        );
    });
    if (reconciledParticipants.length === 0) {
        scheduleEmptyRoomAgentDetach(context, record.meetingId, deps, 'no_human_participants');
    }
    return reconciledParticipants;
}

export async function getRoomDetails(context, meetingId, authInfo = null, options = {}, deps = {}) {
    const record = await loadRoomRecord(context, meetingId);
    if (!canViewMeetingRecord(record, authInfo)) {
        throw new Error('Meeting not found.');
    }
    const payload = decryptRoomPayload(context, record);
    const participants = options.includeParticipants === false
        ? projectStoredRoomParticipants(payload)
        : await getRealtimeRoomParticipants(context, record, payload, {}, deps);
    return {
        meeting: buildRoomView(record),
        participants,
        agents: payload.agents
    };
}

export function assertGuestRoomAccess(record) {
    if (record.roomType !== 'guest') {
        throw new Error('Meeting does not support guest access.');
    }
    if (!isMeetingRecordOpen(record)) {
        throw new Error('Meeting not found.');
    }
}

export function assertGuestParticipant(payload, participantId) {
    const targetParticipantId = String(participantId || '').trim();
    if (!targetParticipantId) {
        throw new Error('Missing participantId.');
    }
    const participant = (Array.isArray(payload.members) ? payload.members : []).find((entry) => (
        String(entry?.id || '').trim() === targetParticipantId
        && (
            entry?.guest === true
            || !String(entry?.userId || '').trim()
        )
    )) || null;
    if (!participant) {
        throw new Error('Guest participant is not joined.');
    }
    return participant;
}

export async function joinGuestRoom(context, { meetingId, displayName, participantId }, deps = {}) {
    const { randomId } = getParticipantDeps(deps);
    const record = await loadRoomRecord(context, meetingId);
    assertGuestRoomAccess(record);
    const participantIdentity = String(participantId || randomId('participant')).trim();
    const effectiveDisplayName = String(displayName || 'Guest').trim() || 'Guest';
    const joinedAt = nowIso();

    let participant = null;
    await mutateRoom(context, meetingId, (_record, payload, stageEvent) => {
        const members = Array.isArray(payload.members) ? payload.members : [];
        payload.members = members;
        participant = members.find((p) => p.id === participantIdentity);
        if (!participant) {
            participant = {
                id: participantIdentity,
                displayName: effectiveDisplayName,
                joinedAt,
                lastSeenAt: joinedAt,
                guest: true,
                pendingLiveKit: true
            };
            members.push(participant);
        } else {
            participant.displayName = effectiveDisplayName;
            participant.lastSeenAt = joinedAt;
            participant.guest = true;
            participant.pendingLiveKit = true;
        }
        stageEvent('meeting', WEBMEET_EVENT_TYPES.PARTICIPANT_JOINED, { meetingId, participantId: participantIdentity, guest: true });
    });
    const rtcConfig = buildRtcConfig(context);

    return {
        meeting: buildRoomView(record),
        ...(rtcConfig ? { rtcConfig } : {}),
        participant,
        livekitUrl: context.livekitPublicUrl,
        roomName: record.roomName,
        participantToken: createLiveKitToken(context, { roomName: record.roomName, identity: participant.id, name: effectiveDisplayName }),
        participantIdentity: participant.id
    };
}

export async function getGuestRoomDetails(context, { meetingId, participantId }, deps = {}) {
    const record = await loadRoomRecord(context, meetingId);
    assertGuestRoomAccess(record);
    const payload = decryptRoomPayload(context, record);
    assertGuestParticipant(payload, participantId);
    let participants;
    try {
        participants = await getRealtimeRoomParticipants(context, record, payload, {
            preserveStoredMembersOnEmpty: true
        }, deps);
    } catch {
        participants = projectStoredRoomParticipants(payload);
    }
    return {
        meeting: buildRoomView(record),
        participants,
        chat: payload.chatMessages,
    };
}

export async function leaveGuestRoom(context, { meetingId, participantId }, deps = {}) {
    const record = await loadRoomRecord(context, meetingId);
    assertGuestRoomAccess(record);
    const payload = decryptRoomPayload(context, record);
    assertGuestParticipant(payload, participantId);
    return leaveRoom(context, { meetingId, participantId, skipAccessCheck: true }, deps);
}

export async function updateGuestRoomParticipantAvatar(context, {
    meetingId,
    participantId,
    avatar = null
} = {}) {
    const targetMeetingId = String(meetingId || '').trim();
    const targetParticipantId = String(participantId || '').trim();
    if (!targetMeetingId) {
        throw new Error('Missing meeting id.');
    }
    if (!targetParticipantId) {
        throw new Error('Missing participant id.');
    }
    const record = await loadRoomRecord(context, targetMeetingId);
    assertGuestRoomAccess(record);
    let profileAvatar = null;
    await mutateRoom(context, targetMeetingId, async (_record, payload) => {
        assertGuestParticipant(payload, targetParticipantId);
        profileAvatar = sanitizeParticipantAvatarPayload(avatar, `profile:${targetParticipantId}`);
    });
    return {
        ok: true,
        meetingId: targetMeetingId,
        participantId: targetParticipantId,
        profileAvatar
    };
}

export async function joinRoom(context, { meetingId, displayName, participantId, authInfo = null }, deps = {}) {
    const { randomId } = getParticipantDeps(deps);
    assertAuthenticatedAuthInfo(authInfo);
    const existingRecord = await loadRoomRecord(context, meetingId);
    if (!canViewMeetingRecord(existingRecord, authInfo)) {
        throw new Error('Room not found.');
    }
    const participantIdentity = String(participantId || randomId('participant')).trim();
    const effectiveDisplayName = String(displayName || getAuthDisplayName(authInfo) || 'Participant').trim() || 'Participant';
    const auth = normalizeAuthInfo(authInfo);
    const userId = String(auth.id || '').trim();
    const participantAttributes = userId
        ? {
            webmeetUserId: userId,
            userId,
            workspaceUserId: userId,
            ploinkyUserId: userId
        }
        : {};
    const joinedAt = nowIso();
    let participant = null;
    const { record } = await mutateRoom(context, meetingId, (_record, payload, stageEvent) => {
        cleanupStaleMembers(context, meetingId, payload, stageEvent, deps);
        participant = payload.members.find((entry) => entry.id === participantIdentity) || null;
        if (!participant) {
            participant = {
                id: participantIdentity,
                displayName: effectiveDisplayName,
                joinedAt,
                lastSeenAt: joinedAt,
                pendingLiveKit: true
            };
            payload.members.push(participant);
            stageEvent('meeting', WEBMEET_EVENT_TYPES.PARTICIPANT_JOINED, { meetingId, participantId: participant.id });
        } else {
            participant.displayName = effectiveDisplayName;
            if (!participant.joinedAt) {
                participant.joinedAt = joinedAt;
            }
            participant.lastSeenAt = joinedAt;
            participant.pendingLiveKit = true;
        }
        if (userId) {
            participant.userId = userId;
            participant.attributes = {
                ...(participant.attributes && typeof participant.attributes === 'object' ? participant.attributes : {}),
                ...participantAttributes
            };
        }
    });
    const rtcConfig = buildRtcConfig(context);
    return {
        meeting: buildRoomView(record),
        participant,
        livekitUrl: context.livekitPublicUrl,
        roomName: record.roomName,
        participantToken: createLiveKitToken(context, {
            roomName: record.roomName,
            identity: participant.id,
            name: effectiveDisplayName,
            attributes: participantAttributes,
            metadata: userId ? JSON.stringify({ webmeetUserId: userId }) : ''
        }),
        participantIdentity: participant.id,
        ...(rtcConfig ? { rtcConfig } : {})
    };
}

export async function updateRoomParticipantAvatar(context, {
    meetingId,
    participantId,
    avatar = null,
    authInfo = null
} = {}) {
    const targetMeetingId = String(meetingId || '').trim();
    const targetParticipantId = String(participantId || '').trim();
    if (!targetMeetingId) {
        throw new Error('Missing meeting id.');
    }
    if (!targetParticipantId) {
        throw new Error('Missing participant id.');
    }
    const auth = normalizeAuthInfo(authInfo);
    const userId = String(auth.id || '').trim();
    if (!userId) {
        throw new Error('Authentication is required to publish a participant avatar.');
    }
    let participant = null;
    let profileAvatar = null;
    await mutateRoom(context, targetMeetingId, async (_record, payload) => {
        participant = (Array.isArray(payload.members) ? payload.members : [])
            .find((entry) => String(entry?.id || '').trim() === targetParticipantId) || null;
        if (!participant) {
            throw new Error('Participant is not joined.');
        }
        const participantUserId = String(participant.userId || participant.attributes?.webmeetUserId || '').trim();
        if (participantUserId && participantUserId !== userId && !isAdminAuthInfo(authInfo)) {
            throw new Error('Access denied: cannot publish another participant avatar.');
        }
        if (!participantUserId) {
            participant.userId = userId;
            participant.attributes = {
                ...(participant.attributes && typeof participant.attributes === 'object' ? participant.attributes : {}),
                webmeetUserId: userId,
                userId,
                workspaceUserId: userId,
                ploinkyUserId: userId
            };
        }
        profileAvatar = sanitizeParticipantAvatarPayload(avatar, `profile:${userId}`);
    });
    return {
        ok: true,
        meetingId: targetMeetingId,
        participantId: targetParticipantId,
        profileAvatar
    };
}

function assertParticipantAccess(payload, participantId, authInfo = null, roomId = '') {
    if (isAdminAuthInfo(authInfo)) {
        return;
    }
    const auth = normalizeAuthInfo(authInfo);
    if (!auth.id) {
        if (hasWebmeetRoomScope(authInfo, roomId)) {
            const guestParticipant = (Array.isArray(payload?.members) ? payload.members : []).find((entry) => (
                String(entry?.id || '').trim() === String(participantId || '').trim()
                    && entry?.guest === true
            )) || null;
            if (guestParticipant) {
                return;
            }
        }
        throw new Error('Access denied: participant authentication is required.');
    }
    const participant = (Array.isArray(payload?.members) ? payload.members : []).find((entry) => (
        String(entry?.id || '').trim() === String(participantId || '').trim()
    )) || null;
    const participantUserId = String(participant?.userId || participant?.attributes?.webmeetUserId || '').trim();
    if (!participant || participantUserId !== auth.id) {
        throw new Error('Access denied: cannot act as another participant.');
    }
}

export async function leaveRoom(context, { meetingId, participantId, authInfo = null, skipAccessCheck = false }, deps = {}) {
    const targetParticipantId = String(participantId || '').trim();
    if (!targetParticipantId) {
        throw new Error('Missing participantId.');
    }
    let removedParticipant = null;
    let noHumanParticipantsRemain = false;
    await mutateRoom(context, meetingId, (_record, payload, stageEvent) => {
        if (!skipAccessCheck) {
            assertParticipantAccess(payload, targetParticipantId, authInfo, meetingId);
        }
        const existingMembers = Array.isArray(payload.members) ? payload.members : [];
        const nextMembers = existingMembers.filter((entry) => {
            const sameParticipant = String(entry?.id || '').trim() === targetParticipantId;
            if (sameParticipant && !removedParticipant) {
                removedParticipant = entry;
            }
            return !sameParticipant;
        });
        payload.members = nextMembers;
        if (removedParticipant) {
            stageEvent('meeting', WEBMEET_EVENT_TYPES.PARTICIPANT_LEFT, {
                meetingId,
                participantId: targetParticipantId
            });
        }
        noHumanParticipantsRemain = nextMembers.length === 0;
    });
    const detachedAgents = noHumanParticipantsRemain
        ? await getParticipantDeps(deps).detachActiveAgentsWhenRoomHasNoHumans(context, meetingId, 'no_human_participants')
        : [];
    return {
        ok: true,
        removed: Boolean(removedParticipant),
        participantId: targetParticipantId,
        detachedAgents
    };
}

export async function heartbeatRoomPresence(context, { meetingId, participantId, authInfo = null }, deps = {}) {
    const targetParticipantId = String(participantId || '').trim();
    if (!targetParticipantId) {
        throw new Error('Missing participantId.');
    }
    let participant = null;
    await mutateRoom(context, meetingId, (record, payload, stageEvent) => {
        if (!isMeetingRecordOpen(record)) {
            throw new Error('Room not found.');
        }
        assertParticipantAccess(payload, targetParticipantId, authInfo, meetingId);
        participant = (Array.isArray(payload.members) ? payload.members : [])
            .find((entry) => String(entry?.id || '').trim() === targetParticipantId) || null;
        if (!participant) {
            throw new Error('Participant is not joined.');
        }
        participant.lastSeenAt = nowIso();
        cleanupStaleMembers(context, meetingId, payload, stageEvent, deps);
    });
    return { ok: true, participant };
}

export async function listRoomParticipants(context, meetingId, authInfo = null, deps = {}) {
    const details = await getRoomDetails(context, meetingId, authInfo, { includeParticipants: true }, deps);
    return { participants: Array.isArray(details?.participants) ? details.participants : [] };
}

export async function updateRoomParticipantRole(context, { meetingId, participantId, role, authInfo = null }) {
    assertAdminAuthInfo(authInfo);
    const targetParticipantId = String(participantId || '').trim();
    const nextRole = String(role || '').trim();
    if (!targetParticipantId || !nextRole) {
        throw new Error('Missing participant role update fields.');
    }
    let participant = null;
    await mutateRoom(context, meetingId, (_record, payload, stageEvent) => {
        participant = (Array.isArray(payload.members) ? payload.members : [])
            .find((entry) => String(entry?.id || '').trim() === targetParticipantId) || null;
        if (!participant) {
            throw new Error('Participant is not joined.');
        }
        participant.role = nextRole;
        participant.updatedAt = nowIso();
        stageEvent('meeting', WEBMEET_EVENT_TYPES.PARTICIPANT_JOINED, {
            meetingId,
            participantId: targetParticipantId,
            role: nextRole,
            reason: 'role_updated'
        });
    });
    return { ok: true, participant };
}

export async function removeRoomParticipant(context, { meetingId, participantId, authInfo = null }) {
    assertAdminAuthInfo(authInfo);
    const targetParticipantId = String(participantId || '').trim();
    if (!targetParticipantId) {
        throw new Error('Missing participantId.');
    }
    let removedParticipant = null;
    await mutateRoom(context, meetingId, (_record, payload, stageEvent) => {
        const existingMembers = Array.isArray(payload.members) ? payload.members : [];
        payload.members = existingMembers.filter((entry) => {
            const sameParticipant = String(entry?.id || '').trim() === targetParticipantId;
            if (sameParticipant && !removedParticipant) {
                removedParticipant = entry;
            }
            return !sameParticipant;
        });
        if (removedParticipant) {
            stageEvent('meeting', WEBMEET_EVENT_TYPES.PARTICIPANT_LEFT, {
                meetingId,
                participantId: targetParticipantId,
                reason: 'admin_removed'
            });
        }
    });
    return { ok: Boolean(removedParticipant), participantId: targetParticipantId };
}
import crypto from 'node:crypto';
