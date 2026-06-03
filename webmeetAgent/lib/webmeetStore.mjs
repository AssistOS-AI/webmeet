import crypto from 'node:crypto';

import { getWorkspacePaths } from './workspacePaths.mjs';
import {
    buildRtcConfig,
    buildStunUrls,
    dedupeStrings,
    isLoopbackUrl,
    splitCsvEnv
} from './store/rtcConfig.mjs';
import {
    callLiveKitAgentDispatchApi,
    getLiveKitAgentDispatch,
    getLiveKitAgentParticipant,
    isDeletedLiveKitDispatch,
    waitForLiveKitAgentDispatch
} from './runtime/livekitRuntime.mjs';
import {
    assertAdminAuthInfo,
    assertAuthenticatedAuthInfo,
    canViewMeetingRecord,
    isAdminAuthInfo,
    normalizeAuthInfo
} from './store/accessPolicy.mjs';
import {
    authorizeResourceDownload as authorizeResourceDownloadImpl,
    authorizeResourceUpload as authorizeResourceUploadImpl,
    commitResourceUpload as commitResourceUploadImpl,
    listRoomResources as listRoomResourcesImpl,
    removeRoomResource as removeRoomResourceImpl
} from './store/roomResources.mjs';
import {
    buildRoomView as buildMeetingView,
    createRoomRecord as createMeetingRecord,
    decryptRoomPayload as decryptMeetingPayload,
    ensureStoreDirs as ensureDirs,
    listRoomRecords,
    loadRoomRecord as loadMeetingRecord,
    mutateRoom as mutateMeeting,
    purgeExpiredRooms as purgeExpiredMeetings,
    recordWorkspaceEvent
} from './store/roomRecords.mjs';
import {
    listRoomEvents as listMeetingEventsImpl,
    listWorkspaceEvents as listWorkspaceEventsImpl
} from './store/eventLogs.mjs';
import {
    cleanupRoomPresence as cleanupMeetingPresenceImpl,
    getRoomDetails as getMeetingImpl,
    getGuestRoomDetails as getGuestMeetingDetailsImpl,
    heartbeatRoomPresence as heartbeatMeetingPresenceImpl,
    joinGuestRoom as joinGuestMeetingImpl,
    joinRoom as joinMeetingImpl,
    leaveGuestRoom as leaveGuestMeetingImpl,
    leaveRoom as leaveMeetingImpl,
    listRoomParticipants as listMeetingParticipantsImpl,
    removeRoomParticipant as removeMeetingParticipantImpl,
    updateGuestRoomParticipantAvatar as updateGuestMeetingParticipantAvatarImpl,
    updateRoomParticipantAvatar as updateMeetingParticipantAvatarImpl,
    updateRoomParticipantRole as updateMeetingParticipantRoleImpl
} from './services/roomParticipants.mjs';
import {
    appendGuestRoomChat as appendGuestMeetingChatImpl,
    appendRoomChat as appendMeetingChatImpl,
    listRoomChat as listMeetingChatImpl
} from './services/roomMessages.mjs';
import {
    archiveRoom as archiveMeetingImpl
} from './services/roomArchive.mjs';
import {
    WEBMEET_EVENT_TYPES,
} from '../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/webmeet-events.js';

const DEFAULT_ROOM_TITLE = 'General';

function nowIso() {
    return new Date().toISOString();
}

function randomId(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
}

const roomResourceDeps = {
    loadMeetingRecord,
    decryptMeetingPayload,
    mutateMeeting,
    canViewMeetingRecord
};

function isActiveMeetingAgent(agent) {
    const status = String(agent?.status || '').trim().toLowerCase();
    return Boolean(agent)
        && !agent.deletedAt
        && status !== 'detached'
        && status !== 'stopped';
}

function hasHumanMeetingMembers(payload) {
    return Array.isArray(payload?.members) && payload.members.length > 0;
}

async function markActiveAgentsDetached(context, meetingId, reason) {
    const detachedAgents = [];
    await mutateMeeting(context, meetingId, (_record, payload, stageEvent) => {
        if (hasHumanMeetingMembers(payload)) return;
        const activeAgents = Array.isArray(payload.agents)
            ? payload.agents.filter(isActiveMeetingAgent)
            : [];
        for (const agent of activeAgents) {
            const detachedAt = nowIso();
            Object.assign(agent, {
                status: 'detached',
                deletedAt: detachedAt,
                updatedAt: detachedAt,
                detachReason: reason
            });
            detachedAgents.push({ ...agent });
            stageEvent('meeting', WEBMEET_EVENT_TYPES.AGENT_DETACHED, {
                meetingId,
                agentId: agent.id || '',
                agentType: agent.agentType || '',
                mode: agent.mode || '',
                reason
            });
        }
    });
    return detachedAgents;
}

async function deleteLiveKitAgentDispatch(context, record, agent) {
    const dispatchId = String(agent?.dispatchId || '').trim();
    if (!dispatchId) return;
    try {
        await callLiveKitAgentDispatchApi(context, 'DeleteDispatch', record.roomName, {
            room: record.roomName,
            dispatchId
        });
    } catch {
        // Persisted metadata is still detached when LiveKit already removed the dispatch.
    }
}

async function detachActiveAgentsWhenRoomHasNoHumans(context, meetingId, reason = 'no_human_participants') {
    const record = await loadMeetingRecord(context, meetingId);
    const payload = decryptMeetingPayload(context, record);
    if (hasHumanMeetingMembers(payload)) {
        return [];
    }
    if (!Array.isArray(payload.agents) || !payload.agents.some(isActiveMeetingAgent)) {
        return [];
    }
    const detachedAgents = await markActiveAgentsDetached(context, meetingId, reason);
    for (const agent of detachedAgents) {
        await deleteLiveKitAgentDispatch(context, record, agent);
    }
    return detachedAgents;
}

const participantServiceDeps = {
    randomId,
    detachActiveAgentsWhenRoomHasNoHumans
};

async function cleanupMeetingPresence(context, meetingId) {
    return await cleanupMeetingPresenceImpl(context, meetingId, participantServiceDeps);
}

const messageServiceDeps = {
    randomId,
    cleanupRoomPresence: cleanupMeetingPresence,
    getRoomDetails: getMeeting
};

const archiveServiceDeps = {
    detachActiveAgentsWhenRoomHasNoHumans
};

export async function getMeeting(context, meetingId, authInfo = null, options = {}) {
    return await getMeetingImpl(context, meetingId, authInfo, options, participantServiceDeps);
}

export async function listMeetingEvents(context, meetingId, { afterId = '' } = {}) {
    return await listMeetingEventsImpl(context, meetingId, { afterId });
}

export async function listWorkspaceEvents(context, workspaceId, { afterId = '' } = {}) {
    return await listWorkspaceEventsImpl(context, workspaceId, { afterId });
}

export async function recordProfileAvatarUpdated(context, {
    workspaceId,
    userId,
    authInfo = null
} = {}) {
    const targetWorkspaceId = String(workspaceId || '').trim();
    if (!targetWorkspaceId) {
        throw new Error('Missing workspace id.');
    }
    await listMeetings(context, targetWorkspaceId, authInfo);
    const normalizedAuth = normalizeAuthInfo(authInfo);
    const targetUserId = String(userId || normalizedAuth.id || '').trim();
    if (!targetUserId) {
        throw new Error('Missing profile avatar user id.');
    }
    if (!isAdminAuthInfo(authInfo) && normalizedAuth.id && normalizedAuth.id !== targetUserId) {
        throw new Error('Access denied: cannot publish another user profile avatar update.');
    }
    return recordWorkspaceEvent(context, targetWorkspaceId, WEBMEET_EVENT_TYPES.PROFILE_AVATAR_UPDATED, {
        workspaceId: targetWorkspaceId,
        userId: targetUserId
    });
}

export async function createStoreContext(startDir = '') {
    const paths = getWorkspacePaths(startDir);
    await ensureDirs(paths);
    await purgeExpiredMeetings(paths);
    return {
        ...paths,
        roomPrefix: String(process.env.WEBMEET_ROOM_PREFIX || 'webmeet').trim() || 'webmeet',
        agentName: String(process.env.WEBMEET_AGENT_NAME || 'WebMeetAgent').trim() || 'WebMeetAgent',
        livekitPublicUrl: String(process.env.WEBMEET_PUBLIC_LIVEKIT_URL || process.env.WEBMEET_LIVEKIT_URL || '').trim(),
        livekitApiUrl: String(process.env.WEBMEET_LIVEKIT_URL || '').trim(),
        livekitApiKey: String(process.env.WEBMEET_LIVEKIT_API_KEY || '').trim(),
        livekitApiSecret: String(process.env.WEBMEET_LIVEKIT_API_SECRET || '').trim(),
        livekitAgentName: String(process.env.WEBMEET_LIVEKIT_AGENT_NAME || 'webmeet-agent').trim() || 'webmeet-agent',
        stunExplicitUrls: process.env.WEBMEET_STUN_URLS !== undefined
            ? String(process.env.WEBMEET_STUN_URLS || '').trim()
            : undefined,
        turn: {
            host: String(process.env.WEBMEET_TURN_EXTERNAL_IP || process.env.WEBMEET_TURN_HOST || '').trim(),
            port: String(process.env.WEBMEET_TURN_PORT || '').trim(),
            explicitUrls: String(process.env.WEBMEET_TURN_URLS || '').trim(),
            username: String(process.env.WEBMEET_TURN_USER || '').trim(),
            credential: String(process.env.WEBMEET_TURN_PASSWORD || '').trim(),
            iceTransportPolicy: String(process.env.WEBMEET_ICE_TRANSPORT_POLICY || '').trim()
        }
    };
}

export async function listMeetings(context, _workspaceId = '', authInfo = null) {
    assertAuthenticatedAuthInfo(authInfo);
    const records = await listRoomRecords(context);
    return records.filter((entry) => entry && canViewMeetingRecord(entry, authInfo)).map(buildMeetingView);
}

export async function updateMeetingTitle(context, { meetingId, title, authInfo = null }) {
    assertAdminAuthInfo(authInfo);
    const nextTitle = String(title || '').trim();
    if (!nextTitle) {
        throw new Error('Missing room title.');
    }
    let meeting = null;
    await mutateMeeting(context, meetingId, (record, _payload, stageEvent) => {
        record.name = nextTitle;
        record.title = nextTitle;
        stageEvent('meeting', WEBMEET_EVENT_TYPES.MEETING_RENAMED, {
            meetingId,
            title: nextTitle
        });
        stageEvent('workspace', WEBMEET_EVENT_TYPES.MEETING_RENAMED, {
            workspaceId: 'rooms',
            meetingId,
            title: nextTitle
        });
    });
    meeting = buildMeetingView(await loadMeetingRecord(context, meetingId));
    return meeting;
}

export async function createMeeting(context, { title = '', name = '', roomType = 'team', authInfo = null }) {
    assertAdminAuthInfo(authInfo);
    const roomName = String(name || title || DEFAULT_ROOM_TITLE).trim() || DEFAULT_ROOM_TITLE;
    const validRoomType = roomType === 'guest' ? 'guest' : 'team';
    const record = await createMeetingRecord(context, roomName, validRoomType);
    const meeting = {
        id: record.roomId || record.meetingId,
        roomId: record.roomId || record.meetingId,
        name: record.name || record.title,
        title: record.name || record.title,
        roomType: record.roomType,
        roomName: record.roomName,
        status: record.status,
        createdAt: record.createdAt,
        archivedAt: record.archivedAt || null
    };
    return meeting;
}

export async function joinGuestMeeting(context, { meetingId, displayName, participantId }) {
    return await joinGuestMeetingImpl(context, { meetingId, displayName, participantId }, participantServiceDeps);
}

export async function getGuestMeetingDetails(context, { meetingId, participantId }) {
    return await getGuestMeetingDetailsImpl(context, { meetingId, participantId }, participantServiceDeps);
}

export async function leaveGuestMeeting(context, { meetingId, participantId }) {
    return await leaveGuestMeetingImpl(context, { meetingId, participantId }, participantServiceDeps);
}

export async function updateGuestMeetingParticipantAvatar(context, {
    meetingId,
    participantId,
    avatar = null
} = {}) {
    return await updateGuestMeetingParticipantAvatarImpl(context, { meetingId, participantId, avatar });
}

export async function joinMeeting(context, { meetingId, displayName, participantId, avatar = null, authInfo = null }) {
    return await joinMeetingImpl(context, { meetingId, displayName, participantId, avatar, authInfo }, participantServiceDeps);
}

export async function updateMeetingParticipantAvatar(context, {
    meetingId,
    participantId,
    avatar = null,
    authInfo = null
} = {}) {
    return await updateMeetingParticipantAvatarImpl(context, { meetingId, participantId, avatar, authInfo });
}

export async function leaveMeeting(context, { meetingId, participantId, authInfo = null, skipAccessCheck = false }) {
    return await leaveMeetingImpl(context, { meetingId, participantId, authInfo, skipAccessCheck }, participantServiceDeps);
}

export async function heartbeatMeetingPresence(context, { meetingId, participantId, authInfo = null }) {
    return await heartbeatMeetingPresenceImpl(context, { meetingId, participantId, authInfo }, participantServiceDeps);
}

export async function listMeetingParticipants(context, meetingId, authInfo = null) {
    return await listMeetingParticipantsImpl(context, meetingId, authInfo, participantServiceDeps);
}

export async function updateMeetingParticipantRole(context, { meetingId, participantId, role, authInfo = null }) {
    return await updateMeetingParticipantRoleImpl(context, { meetingId, participantId, role, authInfo });
}

export async function removeMeetingParticipant(context, { meetingId, participantId, authInfo = null }) {
    return await removeMeetingParticipantImpl(context, { meetingId, participantId, authInfo });
}

export async function listMeetingChat(context, meetingId, authInfo = null) {
    return await listMeetingChatImpl(context, meetingId, authInfo, messageServiceDeps);
}

export async function appendMeetingChat(context, { meetingId, authorId, authorName, message, kind = 'user', metadata = null, authInfo = null, skipAccessCheck = false }) {
    return await appendMeetingChatImpl(context, { meetingId, authorId, authorName, message, kind, metadata, authInfo, skipAccessCheck }, messageServiceDeps);
}

export async function appendGuestMeetingChat(context, { meetingId, participantId, message }) {
    return await appendGuestMeetingChatImpl(context, { meetingId, participantId, message }, messageServiceDeps);
}

export async function attachMeetingAgent(context, { meetingId, agentType, mode, authInfo = null }) {
    await cleanupMeetingPresence(context, meetingId);
    assertAdminAuthInfo(authInfo);
    const record = await loadMeetingRecord(context, meetingId);
    const currentPayload = decryptMeetingPayload(context, record);
    if (!hasHumanMeetingMembers(currentPayload)) {
        throw new Error('Cannot attach AI agents to an empty room.');
    }
    const currentAgent = currentPayload.agents.find((entry) => (
        entry.agentType === agentType && entry.mode === mode && !entry.deletedAt
    ));
    const metadata = {
        roomId: record.roomId || record.meetingId,
        roomType: record.roomType || 'team',
        agentType,
        mode
    };
    if (currentAgent) {
        const currentDispatch = await getLiveKitAgentDispatch(context, record.roomName, currentAgent.dispatchId);
        const currentParticipant = currentDispatch && !isDeletedLiveKitDispatch(currentDispatch)
            ? await getLiveKitAgentParticipant(context, record.roomName, metadata)
            : null;
        if (currentParticipant) {
            return {
                ...currentAgent,
                dispatch: currentDispatch,
                participant: currentParticipant,
                status: 'dispatched'
            };
        }
    }
    const dispatch = await callLiveKitAgentDispatchApi(context, 'CreateDispatch', record.roomName, {
        agentName: context.livekitAgentName,
        room: record.roomName,
        metadata: JSON.stringify(metadata)
    });
    const dispatchId = getAgentDispatchId(dispatch);
    const confirmation = await waitForLiveKitAgentDispatch(context, record.roomName, dispatchId, metadata);
    let agent = null;
    await mutateMeeting(context, meetingId, (_record, payload, stageEvent) => {
        const targetAgent = currentAgent
            ? payload.agents.find((entry) => entry.id === currentAgent.id)
            : null;
        agent = targetAgent || {
            id: randomId('agent'),
            meetingId,
            agentType,
            mode,
            createdAt: nowIso()
        };
        Object.assign(agent, {
            agentName: context.livekitAgentName,
            dispatchId,
            participantIdentity: confirmation.participant.identity || '',
            participantSid: confirmation.participant.sid || '',
            dispatch: confirmation.dispatch,
            participant: confirmation.participant,
            status: 'dispatched',
            updatedAt: nowIso()
        });
        if (!targetAgent) {
            payload.agents.push(agent);
        }
        stageEvent('meeting', WEBMEET_EVENT_TYPES.AGENT_DISPATCHED, {
            meetingId,
            agentId: agent.id,
            agentType,
            mode,
            dispatchId: agent.dispatchId
        });
    });
    return agent;
}

export async function listMeetingAgents(context, meetingId) {
    await cleanupMeetingPresence(context, meetingId);
    return decryptMeetingPayload(context, await loadMeetingRecord(context, meetingId)).agents;
}

export async function detachMeetingAgent(context, { meetingId, agentId, authInfo = null }) {
    await cleanupMeetingPresence(context, meetingId);
    assertAdminAuthInfo(authInfo);
    const targetAgentId = String(agentId || '').trim();
    if (!targetAgentId) {
        throw new Error('Missing agentId.');
    }
    const record = await loadMeetingRecord(context, meetingId);
    const currentPayload = decryptMeetingPayload(context, record);
    const currentAgent = currentPayload.agents.find((entry) => (
        String(entry?.id || '') === targetAgentId && !entry.deletedAt
    ));
    if (!currentAgent) {
        throw new Error('Meeting agent not found.');
    }
    if (currentAgent.dispatchId) {
        try {
            await callLiveKitAgentDispatchApi(context, 'DeleteDispatch', record.roomName, {
                room: record.roomName,
                dispatchId: currentAgent.dispatchId
            });
        } catch {
            // Persist the detach even if LiveKit already removed the dispatch.
        }
    }
    let detachedAgent = null;
    await mutateMeeting(context, meetingId, (_record, payload, stageEvent) => {
        const targetAgent = payload.agents.find((entry) => String(entry?.id || '') === targetAgentId);
        if (!targetAgent) return;
        Object.assign(targetAgent, {
            status: 'detached',
            deletedAt: nowIso(),
            updatedAt: nowIso()
        });
        detachedAgent = { ...targetAgent };
        stageEvent('meeting', WEBMEET_EVENT_TYPES.AGENT_DETACHED, {
            meetingId,
            agentId: targetAgentId,
            agentType: targetAgent.agentType || '',
            mode: targetAgent.mode || ''
        });
    });
    return detachedAgent || { id: targetAgentId, status: 'detached' };
}

export async function archiveMeeting(context, meetingId, authInfo = null) {
    return await archiveMeetingImpl(context, meetingId, authInfo, archiveServiceDeps);
}

export async function authorizeResourceUpload(context, { roomId, filename, mimeType = '', size = 0, authInfo = null }) {
    return await authorizeResourceUploadImpl(context, { roomId, filename, mimeType, size, authInfo }, roomResourceDeps);
}

export async function commitResourceUpload(context, {
    roomId,
    resourceId,
    filename,
    mimeType = '',
    size = 0,
    storagePath = '',
    visibility = 'room',
    authInfo = null
}) {
    const auth = normalizeAuthInfo(authInfo);
    return await commitResourceUploadImpl(context, {
        roomId,
        resourceId,
        filename,
        mimeType,
        size,
        storagePath,
        visibility,
        ownerUserId: auth.id || '',
        authInfo
    }, roomResourceDeps);
}

export async function authorizeResourceDownload(context, { roomId, resourceId, authInfo = null }) {
    return await authorizeResourceDownloadImpl(context, { roomId, resourceId, authInfo }, roomResourceDeps);
}

export async function listRoomResources(context, roomId, authInfo = null) {
    return await listRoomResourcesImpl(context, roomId, authInfo, roomResourceDeps);
}

export async function removeRoomResource(context, { roomId, resourceId, authInfo = null }) {
    assertAdminAuthInfo(authInfo);
    return await removeRoomResourceImpl(context, { roomId, resourceId, authInfo }, roomResourceDeps);
}

export {
    isAdminAuthInfo,
    buildRtcConfig as _buildRtcConfig,
    buildStunUrls as _buildStunUrls,
    isLoopbackUrl as _isLoopbackUrl,
    dedupeStrings as _dedupeStrings,
    splitCsvEnv as _splitCsvEnv,
};
