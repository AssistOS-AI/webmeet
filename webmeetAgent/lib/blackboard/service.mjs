import {
    assertAuthenticatedAuthInfo,
    canViewMeetingRecord,
    hasWebmeetRoomScope,
    isAdminAuthInfo,
    normalizeAuthInfo
} from '../store/accessPolicy.mjs';
import {
    decryptRoomPayload,
    loadRoomRecord,
    mutateRoom
} from '../store/roomRecords.mjs';
import { WEBMEET_EVENT_TYPES } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';
import { Blackboard, cloneJson } from './model.mjs';
import { buildBlackboardProtocolPayload } from './protocol.mjs';
import {
    ROBO_TEAM_BLACKBOARD_BOARD_ID,
    ROBO_TEAM_PARTICIPANT_ID,
    ensureRoboTeamAgentPayload,
    ensureRoboTeamBlackboardPayload,
    getRoboTeamAgentPayload
} from '../roboTeam/service.mjs';

export const DEFAULT_BLACKBOARD_BOARD_ID = ROBO_TEAM_BLACKBOARD_BOARD_ID;

function assertSupportedBoardId(boardId = '') {
    const normalized = String(boardId || '').trim();
    if (!normalized) {
        throw new Error('Missing required blackboard boardId.');
    }
    if (normalized !== DEFAULT_BLACKBOARD_BOARD_ID) {
        throw new Error(`Unsupported blackboard boardId "${normalized}". Participant-owned blackboards are not enabled yet.`);
    }
    return normalized;
}

function getParticipantId(authInfo = null, fallback = '') {
    const normalized = normalizeAuthInfo(authInfo);
    return String(fallback || normalized.id || normalized.principalId || '').trim();
}

function getAuthorizedParticipantId(payload, authInfo = null, participantId = '', roomId = '') {
    const targetParticipantId = String(participantId || '').trim();
    if (!targetParticipantId) {
        return getParticipantId(authInfo);
    }
    if (isAdminAuthInfo(authInfo)) {
        return targetParticipantId;
    }
    const auth = normalizeAuthInfo(authInfo);
    const members = Array.isArray(payload?.members) ? payload.members : [];
    const participant = members.find((entry) => String(entry?.id || '').trim() === targetParticipantId) || null;
    if (!auth.id) {
        if (hasWebmeetRoomScope(authInfo, roomId) && participant?.guest === true) {
            return targetParticipantId;
        }
        throw new Error('Access denied: participant authentication is required.');
    }
    const participantUserId = String(participant?.userId || participant?.attributes?.webmeetUserId || '').trim();
    if (!participant || participantUserId !== auth.id) {
        throw new Error('Access denied: cannot act as another participant.');
    }
    return targetParticipantId;
}

function buildViewerContext(authInfo = null, participantId = '') {
    const normalized = normalizeAuthInfo(authInfo);
    const isAdmin = isAdminAuthInfo(authInfo);
    return {
        participantId: getParticipantId(authInfo, participantId),
        userId: normalized.id,
        roles: normalized.roles,
        kind: normalized.principalId.startsWith('agent:') ? 'agent' : 'human',
        canViewAllParticipantData: isAdmin,
        canModerateBlackboard: isAdmin
    };
}

function loadBlackboardFromPayload(payload, roomId, boardId = '') {
    assertSupportedBoardId(boardId);
    const agent = getRoboTeamAgentPayload(payload) || ensureRoboTeamAgentPayload(payload, null, roomId);
    return Blackboard.from({
        ...ensureRoboTeamBlackboardPayload(agent, roomId),
        roomId
    });
}

function saveBlackboardToPayload(payload, roomId, blackboard, boardId = '') {
    assertSupportedBoardId(boardId);
    const agent = getRoboTeamAgentPayload(payload) || ensureRoboTeamAgentPayload(payload, null, roomId);
    agent.blackboard = blackboard.serializePrivileged();
    return agent.blackboard;
}

function assertCanAccessBlackboard(record, authInfo) {
    assertAuthenticatedAuthInfo(authInfo);
    if (!canViewMeetingRecord(record, authInfo)) {
        throw new Error('Access denied: cannot access this room blackboard.');
    }
}

function assertCanMutateBlackboard(record, authInfo) {
    assertCanAccessBlackboard(record, authInfo);
    if (String(record?.status || '').trim().toLowerCase() === 'archived') {
        throw new Error('Cannot modify archived room blackboard.');
    }
}

function normalizeChange(input = {}, authInfo = null) {
    const changeType = String(input.changeType || '').trim();
    if (!changeType) {
        throw new Error('Missing required blackboard change.changeType.');
    }
    return {
        changeType,
        targetType: String(input.targetType || 'widget').trim(),
        targetRef: String(input.targetRef || input.widgetId || '').trim(),
        reason: String(input.reason || '').trim(),
        widget: cloneJson(input.widget),
        object: cloneJson(input.object),
        patch: cloneJson(input.patch || {}),
        data: cloneJson(input.data),
        participantId: ''
    };
}

function buildPublicViewerContext() {
    return {
        participantId: '',
        userId: '',
        roles: [],
        kind: 'human',
        canViewAllParticipantData: false,
        canModerateBlackboard: false
    };
}

function buildBroadcastPayload(roomId, blackboard, object, objectKind) {
    const kind = objectKind === 'widget' ? 'widget' : 'blackboard';
    const publicContext = buildPublicViewerContext();
    let publicObject = null;
    if (kind === 'widget' && object?.id) {
        publicObject = blackboard.getWidget(object.id)?.serialize(publicContext) || null;
    } else {
        publicObject = blackboard.serialize(publicContext);
    }
    return buildBlackboardProtocolPayload({
        kind,
        roomId,
        ownerParticipantId: ROBO_TEAM_PARTICIPANT_ID,
        blackboardId: blackboard.id,
        boardId: blackboard.boardId,
        boardOwnerType: blackboard.boardOwnerType,
        boardOwnerId: blackboard.boardOwnerId,
        boardVisibility: blackboard.boardVisibility,
        version: blackboard.version,
        visibility: publicObject?.visibility || { mode: 'all' },
        object: publicObject
    });
}

function sanitizeChangeAuthority(change = {}, authInfo = null) {
    if (isAdminAuthInfo(authInfo)) {
        return change;
    }
    if (change.widget && typeof change.widget === 'object') {
        change.widget.visibility = { mode: 'all' };
    }
    if (change.object && typeof change.object === 'object') {
        change.object.visibility = { mode: 'all' };
    }
    if (change.patch && typeof change.patch === 'object' && !Array.isArray(change.patch)) {
        delete change.patch.visibility;
    }
    return change;
}

function buildBlackboardEventData(roomId, blackboard, change, object) {
    const objectKind = change.changeType === 'clear' || change.targetType === 'blackboard'
        ? 'blackboard'
        : 'widget';
    return {
        meetingId: roomId,
        boardId: blackboard.boardId,
        boardOwnerType: blackboard.boardOwnerType,
        boardOwnerId: blackboard.boardOwnerId,
        boardVisibility: blackboard.boardVisibility,
        blackboardVersion: blackboard.version,
        changeType: change.changeType,
        targetType: change.targetType,
        targetRef: change.targetRef || object?.id || '',
        reason: change.reason || '',
        objectKind
    };
}

function isExpiredPollWidget(widget) {
    if (widget?.type !== 'poll') return false;
    if (String(widget.properties?.status || '').trim() === 'closed') return true;
    const closesAt = String(widget.properties?.closesAt || '').trim();
    const closesAtTime = Date.parse(closesAt);
    return Boolean(closesAt && Number.isFinite(closesAtTime) && Date.now() >= closesAtTime);
}

export async function getRoomBlackboard(context, {
    roomId,
    boardId = '',
    participantId = '',
    authInfo = null
} = {}) {
    const targetRoomId = String(roomId || '').trim();
    const targetBoardId = assertSupportedBoardId(boardId);
    const record = await loadRoomRecord(context, targetRoomId);
    assertCanAccessBlackboard(record, authInfo);
    const payload = decryptRoomPayload(context, record);
    const blackboard = loadBlackboardFromPayload(payload, targetRoomId, targetBoardId);
    return {
        blackboard: blackboard.serialize(buildViewerContext(authInfo, participantId))
    };
}

export async function applyRoomBlackboardChange(context, {
    roomId,
    boardId = '',
    change,
    participantId = '',
    authInfo = null
} = {}) {
    const targetRoomId = String(roomId || '').trim();
    const targetBoardId = assertSupportedBoardId(boardId);
    let serializedBlackboard = null;
    let serializedObject = null;
    let broadcast = null;
    let normalizedChange = null;
    let deferredError = null;

    await mutateRoom(context, targetRoomId, (record, payload, stageEvent) => {
        assertCanMutateBlackboard(record, authInfo);
        normalizedChange = normalizeChange(change, authInfo);
        normalizedChange.participantId = getAuthorizedParticipantId(payload, authInfo, participantId, targetRoomId);
        sanitizeChangeAuthority(normalizedChange, authInfo);
        const blackboard = loadBlackboardFromPayload(payload, targetRoomId, targetBoardId);
        if (normalizedChange.changeType === 'submit') {
            const targetRef = String(normalizedChange.targetRef || '').trim();
            const targetWidget = blackboard.getWidget(targetRef);
            if (isExpiredPollWidget(targetWidget)) {
                const result = blackboard.closePoll(targetRef, {
                    participantId: normalizedChange.participantId,
                    canManagePoll: true,
                    record: false
                });
                serializedBlackboard = saveBlackboardToPayload(payload, targetRoomId, blackboard, targetBoardId);
                serializedObject = result.serializePrivileged();
                broadcast = buildBroadcastPayload(targetRoomId, blackboard, serializedObject, 'widget');
                stageEvent('meeting', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, buildBlackboardEventData(
                    targetRoomId,
                    blackboard,
                    { ...normalizedChange, changeType: 'close', reason: 'pollExpired' },
                    serializedObject
                ));
                deferredError = new Error('Poll is closed.');
                return;
            }
        }
        const result = blackboard.applyFinalChange(normalizedChange, {
            participantId: normalizedChange.participantId,
            canManagePoll: isAdminAuthInfo(authInfo),
            canModerateBlackboard: isAdminAuthInfo(authInfo)
        });
        serializedBlackboard = saveBlackboardToPayload(payload, targetRoomId, blackboard, targetBoardId);
        serializedObject = result?.serializePrivileged ? result.serializePrivileged() : blackboard.serializePrivileged();
        const objectKind = normalizedChange.changeType === 'clear' || normalizedChange.targetType === 'blackboard'
            ? 'blackboard'
            : 'widget';
        broadcast = buildBroadcastPayload(targetRoomId, blackboard, serializedObject, objectKind);
        stageEvent('meeting', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, buildBlackboardEventData(
            targetRoomId,
            blackboard,
            normalizedChange,
            serializedObject
        ));
    });

    if (deferredError) {
        throw deferredError;
    }

    const viewerContext = buildViewerContext(authInfo, normalizedChange?.participantId || participantId);
    return {
        blackboard: Blackboard.from(serializedBlackboard).serialize(viewerContext),
        object: normalizedChange?.targetType === 'blackboard'
            ? Blackboard.from(serializedBlackboard).serialize(viewerContext)
            : serializedObject?.id
            ? Blackboard.from(serializedBlackboard).getWidget(serializedObject.id)?.serialize(viewerContext)
            : Blackboard.from(serializedBlackboard).serialize(viewerContext),
        change: normalizedChange,
        broadcast
    };
}

export async function undoRoomBlackboard(context, {
    roomId,
    boardId = '',
    participantId = '',
    authInfo = null
} = {}) {
    return await applyHistoryMove(context, { roomId, boardId, participantId, authInfo, direction: 'undo' });
}

export async function redoRoomBlackboard(context, {
    roomId,
    boardId = '',
    participantId = '',
    authInfo = null
} = {}) {
    return await applyHistoryMove(context, { roomId, boardId, participantId, authInfo, direction: 'redo' });
}

async function applyHistoryMove(context, {
    roomId,
    boardId = '',
    participantId = '',
    authInfo = null,
    direction
} = {}) {
    const targetRoomId = String(roomId || '').trim();
    const targetBoardId = assertSupportedBoardId(boardId);
    let serializedBlackboard = null;
    let changed = false;
    let broadcast = null;
    let effectiveParticipantId = '';

    await mutateRoom(context, targetRoomId, (record, payload, stageEvent) => {
        assertCanMutateBlackboard(record, authInfo);
        effectiveParticipantId = getAuthorizedParticipantId(payload, authInfo, participantId, targetRoomId);
        const blackboard = loadBlackboardFromPayload(payload, targetRoomId, targetBoardId);
        const viewerContext = buildViewerContext(authInfo, effectiveParticipantId);
        const result = direction === 'redo' ? blackboard.redo(viewerContext) : blackboard.undo(viewerContext);
        changed = Boolean(result);
        serializedBlackboard = saveBlackboardToPayload(payload, targetRoomId, blackboard, targetBoardId);
        broadcast = changed ? buildBroadcastPayload(targetRoomId, blackboard, blackboard.serializePrivileged(), 'blackboard') : null;
        if (changed) {
            stageEvent('meeting', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, {
                meetingId: targetRoomId,
                boardId: blackboard.boardId,
                boardOwnerType: blackboard.boardOwnerType,
                boardOwnerId: blackboard.boardOwnerId,
                boardVisibility: blackboard.boardVisibility,
                blackboardVersion: blackboard.version,
                changeType: direction,
                targetType: 'blackboard',
                targetRef: '',
                reason: direction,
                objectKind: 'blackboard'
            });
        }
    });

    return {
        changed,
        blackboard: Blackboard.from(serializedBlackboard).serialize(buildViewerContext(authInfo, effectiveParticipantId || participantId)),
        broadcast
    };
}
