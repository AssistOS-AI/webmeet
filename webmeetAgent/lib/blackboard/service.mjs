import {
    assertAuthenticatedAuthInfo,
    canViewMeetingRecord,
    isAdminAuthInfo,
    normalizeAuthInfo
} from '../store/accessPolicy.mjs';
import { authorizeRoomParticipantId } from '../store/participantAuthorization.mjs';
import {
    decryptRoomPayload,
    loadRoomRecord,
    mutateRoom
} from '../store/roomRecords.mjs';
import { WEBMEET_EVENT_TYPES } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';
import { Blackboard, BlackboardWidget, cloneJson, normalizeFreeLineProperties } from './model.mjs';
import { BlackboardWorkspace } from './workspace-model.mjs';
import { assertCanonicalWidgetPatch, newEventId } from './event-contract.mjs';
import { buildBlackboardProtocolPayload } from './protocol.mjs';
import {
    ROBO_TEAM_PARTICIPANT_ID,
    ensureRoboTeamAgentPayload,
    ensureRoboTeamBlackboardWorkspacePayload,
    getRoboTeamAgentPayload
} from '../roboTeam/service.mjs';
import { scriptaOwnerHash } from '../scripta/identity.mjs';
import { scriptaExplorer } from '../scripta/explorer-crdt-client.mjs';
import { calculateContentBounds } from './semantic-context.mjs';

function attachmentGeometry(blackboard, asset, position = null) {
    const bounds = calculateContentBounds([...blackboard.widgets.values()].map((widget) => widget.serializePrivileged()));
    let width = 320;
    let height = 160;
    if (asset.kind === 'image') {
        const naturalWidth = Math.max(1, Number(asset.width || 1));
        const naturalHeight = Math.max(1, Number(asset.height || 1));
        const naturalMax = Math.max(naturalWidth, naturalHeight);
        const scale = naturalMax > 360 ? 360 / naturalMax : naturalMax < 180 ? 180 / naturalMax : 1;
        width = Math.max(1, Math.round(naturalWidth * scale));
        height = Math.max(1, Math.round(naturalHeight * scale));
    }
    const requestedX = Number(position?.x);
    const requestedY = Number(position?.y);
    const centerX = Number.isFinite(requestedX) ? requestedX : bounds.centerX;
    const centerY = Number.isFinite(requestedY) ? requestedY : bounds.centerY;
    return {
        x: Math.max(0, Math.round(centerX - width / 2)),
        y: Math.max(0, Math.round(centerY - height / 2)),
        width,
        height,
        rotation: 0
    };
}

function publicMediaAsset(asset = {}) {
    const kind = asset.kind === 'image' ? 'image' : 'file';
    const view = {
        assetId: String(asset.assetId || ''),
        kind,
        filename: String(asset.filename || (kind === 'image' ? 'Image' : 'File')),
        mimeType: String(asset.mimeType || ''),
        extension: String(asset.extension || ''),
        size: Number(asset.size || 0),
        workspaceUrl: String(asset.workspaceUrl || '')
    };
    if (kind === 'image') {
        view.width = Number(asset.width || 0);
        view.height = Number(asset.height || 0);
    }
    return view;
}

export async function publishRoomAttachment(context, {
    roomId,
    boardId = '',
    participantId = '',
    blobRef = null,
    position = null,
    authInfo = null
} = {}) {
    const targetRoomId = String(roomId || '').trim();
    const targetBoardId = assertBoardId(boardId);
    const roomRecord = await loadRoomRecord(context, targetRoomId);
    assertCanMutateBlackboard(roomRecord, authInfo);
    const roomPayload = decryptRoomPayload(context, roomRecord);
    const authorizedParticipantId = authorizeRoomParticipantId(roomPayload, authInfo, participantId, targetRoomId);
    const assetResult = await scriptaExplorer.commitMedia(context, {
        roomId: targetRoomId,
        blobRef,
        createdBy: authorizedParticipantId
    });
    const asset = publicMediaAsset(assetResult?.asset || assetResult);
    if (!asset.assetId || !asset.workspaceUrl) throw new Error('Explorer did not return a valid media asset.');
    let result = null;
    await mutateRoom(context, targetRoomId, (record, payload, stageEvent) => {
        assertCanMutateBlackboard(record, authInfo);
        const effectiveParticipantId = authorizeRoomParticipantId(payload, authInfo, participantId, targetRoomId);
        const member = (Array.isArray(payload.members) ? payload.members : [])
            .find((entry) => String(entry?.id || '') === effectiveParticipantId);
        const authorName = String(member?.displayName || member?.name || 'User');
        const workspace = loadWorkspaceFromPayload(payload, targetRoomId);
        let blackboard = workspace.requireBoard(targetBoardId);
        const before = workspace.snapshot();
        const widgetId = newEventId('widget');
        const routeUrl = `/workspace-files/${asset.workspaceUrl.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`;
        const source = {
            kind: 'explorer-media', assetId: asset.assetId, url: routeUrl,
            name: asset.filename, mimeType: asset.mimeType, extension: asset.extension, size: asset.size
        };
        const properties = asset.kind === 'image'
            ? {
                source,
                alt: asset.filename,
                naturalSize: { width: asset.width, height: asset.height },
                geometry: attachmentGeometry(blackboard, asset, position)
            }
            : {
                source,
                geometry: attachmentGeometry(blackboard, asset, position)
            };
        const widget = blackboard.applyFinalChange({
            changeType: 'create',
            targetType: 'widget',
            reason: 'attachmentUpload',
            widget: {
                id: widgetId,
                type: asset.kind,
                properties
            }
        }, { participantId: effectiveParticipantId, ownerParticipantId: effectiveParticipantId, record: false });
        blackboard.updateInteractionContext([widgetId], { participantId: effectiveParticipantId });
        workspace.activeBoardId = blackboard.boardId;
        workspace.bumpRevision();
        workspace.record('attachment-publish', before);
        saveWorkspaceToPayload(payload, targetRoomId, workspace);
        const serializedBlackboard = blackboard.serializePrivileged();
        payload.resources = Array.isArray(payload.resources) ? payload.resources : [];
        if (!payload.resources.some((entry) => entry?.assetId === asset.assetId)) {
            payload.resources.push({ ...asset, resourceId: asset.assetId, roomId: targetRoomId, createdAt: new Date().toISOString() });
        }
        const chatMessage = {
            id: newEventId('chat'), meetingId: targetRoomId,
            authorId: effectiveParticipantId, authorName,
            message: asset.filename, kind: 'user', createdAt: new Date().toISOString(),
            metadata: {
                attachments: [{ ...asset }],
                blackboardWidgetId: widgetId,
                boardId: blackboard.boardId,
                boardTitle: String(blackboard.metadata?.title || '')
            }
        };
        payload.chatMessages = Array.isArray(payload.chatMessages) ? payload.chatMessages : [];
        payload.chatMessages.push(chatMessage);
        stageEvent('meeting', WEBMEET_EVENT_TYPES.CHAT_MESSAGE_CREATED, { meetingId: targetRoomId, chatMessageId: chatMessage.id });
        stageEvent('meeting', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, {
            meetingId: targetRoomId, boardId: blackboard.boardId,
            blackboardRevision: blackboard.revision, changeType: 'create',
            targetType: 'widget', targetRef: widgetId, objectKind: 'blackboard'
        });
        result = {
            ok: true, asset, message: chatMessage,
            widget: widget.serialize(buildViewerContext(authInfo, effectiveParticipantId)),
            blackboard: Blackboard.from(serializedBlackboard).serialize(buildViewerContext(authInfo, effectiveParticipantId)),
            workspace: workspace.serialize(buildViewerContext(authInfo, effectiveParticipantId)),
            broadcast: buildBroadcastPayload(targetRoomId, blackboard, serializedBlackboard, 'blackboard')
        };
    });
    return result;
}

function assertBoardId(boardId = '') {
    const normalized = String(boardId || '').trim();
    if (!normalized) {
        throw new Error('Missing required blackboard boardId.');
    }
    return normalized;
}

function getParticipantId(authInfo = null, fallback = '') {
    const normalized = normalizeAuthInfo(authInfo);
    return String(fallback || normalized.id || normalized.principalId || '').trim();
}

function authorizeOwnParticipantId(payload, authInfo = null, participantId = '', roomId = '') {
    const effectiveParticipantId = authorizeRoomParticipantId(payload, authInfo, participantId, roomId);
    if (!isAdminAuthInfo(authInfo)) return effectiveParticipantId;
    const auth = normalizeAuthInfo(authInfo);
    const member = (Array.isArray(payload?.members) ? payload.members : [])
        .find((entry) => String(entry?.id || '').trim() === effectiveParticipantId) || null;
    const memberUserId = String(member?.userId || member?.attributes?.webmeetUserId || '').trim();
    const authenticatedIds = new Set([auth.id, auth.principalId, auth.username, auth.email]
        .map((value) => String(value || '').trim()).filter(Boolean));
    if (authenticatedIds.has(effectiveParticipantId) || authenticatedIds.has(memberUserId)) return effectiveParticipantId;
    throw new Error('Access denied: cannot read another participant private blackboard context.');
}

function buildViewerContext(authInfo = null, participantId = '') {
    const normalized = normalizeAuthInfo(authInfo);
    const isAdmin = isAdminAuthInfo(authInfo);
    const viewerParticipantId = getParticipantId(authInfo, participantId);
    return {
        participantId: viewerParticipantId,
        userId: normalized.id,
        roles: normalized.roles,
        kind: normalized.principalId.startsWith('agent:') ? 'agent' : 'human',
        canViewAllParticipantData: isAdmin,
        canModerateBlackboard: isAdmin,
        scriptaOwnerHash: scriptaOwnerHash(normalized.id || normalized.principalId || viewerParticipantId),
    };
}

function loadWorkspaceFromPayload(payload, roomId) {
    const agent = getRoboTeamAgentPayload(payload) || ensureRoboTeamAgentPayload(payload, null, roomId);
    return BlackboardWorkspace.from(ensureRoboTeamBlackboardWorkspacePayload(agent, roomId));
}

function saveWorkspaceToPayload(payload, roomId, workspace) {
    const agent = getRoboTeamAgentPayload(payload) || ensureRoboTeamAgentPayload(payload, null, roomId);
    agent.blackboardWorkspace = BlackboardWorkspace.from(workspace).serializePrivileged();
    return agent.blackboardWorkspace;
}

function loadBlackboardFromPayload(payload, roomId, boardId = '') {
    const workspace = loadWorkspaceFromPayload(payload, roomId);
    return workspace.requireBoard(boardId || workspace.activeBoardId);
}

function saveBlackboardToPayload(payload, roomId, blackboard) {
    const workspace = loadWorkspaceFromPayload(payload, roomId);
    workspace.boards.set(blackboard.boardId, Blackboard.from(blackboard));
    saveWorkspaceToPayload(payload, roomId, workspace);
    return blackboard.serializePrivileged();
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
        widgetIds: Array.isArray(input.widgetIds)
            ? input.widgetIds.map((id) => String(id || '').trim()).filter(Boolean)
            : undefined,
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
        revision: blackboard.revision,
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
        blackboardRevision: blackboard.revision,
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

async function readRoomBlackboard(context, {
    roomId,
    boardId = '',
    participantId = '',
    authInfo = null,
} = {}) {
    const targetRoomId = String(roomId || '').trim();
    const targetBoardId = String(boardId || '').trim();
    const record = await loadRoomRecord(context, targetRoomId);
    assertCanAccessBlackboard(record, authInfo);
    const payload = decryptRoomPayload(context, record);
    const workspace = loadWorkspaceFromPayload(payload, targetRoomId);
    const blackboard = workspace.requireBoard(targetBoardId || workspace.activeBoardId);
    if (blackboard.interactionContext.focusedWidgetId && !blackboard.getWidget(blackboard.interactionContext.focusedWidgetId)) {
        blackboard.interactionContext.focusedWidgetId = '';
    }
    const effectiveParticipantId = authorizeOwnParticipantId(payload, authInfo, participantId, targetRoomId);
    return {
        workspace: workspace.serialize(buildViewerContext(authInfo, effectiveParticipantId)),
        blackboard: blackboard.serialize(buildViewerContext(authInfo, effectiveParticipantId)),
    };
}

export async function getRoomBlackboard(context, input = {}) {
    return readRoomBlackboard(context, input);
}

export async function getRoomBlackboardForCommand(context, input = {}) {
    return readRoomBlackboard(context, input);
}

export async function applyRoomBlackboardWorkspaceAction(context, {
    roomId,
    action = '',
    boardId = '',
    targetBoardId = '',
    title = '',
    targetIndex = 0,
    widgetIds = [],
    placement = null,
    participantId = '',
    authInfo = null,
} = {}) {
    const targetRoomId = String(roomId || '').trim();
    const normalizedAction = String(action || '').trim();
    let result = null;
    await mutateRoom(context, targetRoomId, (record, payload, stageEvent) => {
        assertCanMutateBlackboard(record, authInfo);
        const effectiveParticipantId = authorizeRoomParticipantId(payload, authInfo, participantId, targetRoomId);
        const workspace = loadWorkspaceFromPayload(payload, targetRoomId);
        let affectedBoardIds = [];
        if (normalizedAction === 'board-create') {
            const board = workspace.createBoard({ title });
            affectedBoardIds = [board.boardId];
        } else if (normalizedAction === 'board-rename') {
            workspace.renameBoard(assertBoardId(boardId), title);
            affectedBoardIds = [boardId];
        } else if (normalizedAction === 'board-reorder') {
            workspace.reorderBoard(assertBoardId(boardId), targetIndex);
            affectedBoardIds = [boardId];
        } else if (normalizedAction === 'board-delete') {
            workspace.deleteBoard(assertBoardId(boardId));
            affectedBoardIds = [boardId, workspace.activeBoardId];
        } else if (normalizedAction === 'board-activate') {
            workspace.activateBoard(assertBoardId(boardId));
            affectedBoardIds = [boardId];
        } else if (normalizedAction === 'board-transfer') {
            const transfer = workspace.transferWidgets({
                sourceBoardId: assertBoardId(boardId),
                targetBoardId: assertBoardId(targetBoardId),
                widgetIds,
                placement,
            }, { participantId: effectiveParticipantId });
            affectedBoardIds = [...new Set([transfer.source.boardId, transfer.target.boardId])];
        } else if (normalizedAction === 'board-copy') {
            const copied = workspace.copyWidgets({
                sourceBoardId: assertBoardId(boardId),
                targetBoardId: assertBoardId(targetBoardId),
                widgetIds,
                placement,
            }, {participantId: effectiveParticipantId});
            affectedBoardIds = [copied.target.boardId];
        } else if (normalizedAction === 'undo' || normalizedAction === 'redo') {
            const changed = normalizedAction === 'undo' ? workspace.undo() : workspace.redo();
            if (!changed) {
                result = { ok: true, changed: false };
                return;
            }
            affectedBoardIds = [...workspace.boardOrder];
        } else {
            throw new Error(`Unsupported Blackboard workspace action "${normalizedAction}".`);
        }
        saveWorkspaceToPayload(payload, targetRoomId, workspace);
        const viewerContext = buildViewerContext(authInfo, effectiveParticipantId);
        const activeBoard = workspace.activeBoard;
        stageEvent('meeting', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, {
            meetingId: targetRoomId,
            workspaceRevision: workspace.revision,
            boardId: activeBoard.boardId,
            affectedBoardIds,
            activeBoardId: workspace.activeBoardId,
            blackboardRevision: activeBoard.revision,
            changeType: normalizedAction,
            targetType: 'workspace',
            targetRef: workspace.activeBoardId,
            objectKind: 'workspace',
        });
        result = {
            ok: true,
            changed: true,
            workspace: workspace.serialize(viewerContext),
            blackboard: activeBoard.serialize(viewerContext),
            affectedBoardIds,
            broadcast: buildBroadcastPayload(targetRoomId, activeBoard, activeBoard.serializePrivileged(), 'blackboard'),
        };
    });
    return result;
}

function resolveEndpoint(endpoint = {}, refs = new Map()) {
    if (!endpoint.ref) return endpoint;
    const widgetId = refs.get(String(endpoint.ref));
    if (!widgetId) throw new Error(`Unknown or forward local widget ref "${endpoint.ref}".`);
    return { widgetId, anchor: endpoint.anchor };
}

function resolveEvent(event, refs) {
    const resolved = cloneJson(event);
    if (resolved.target?.ref) {
        const widgetId = refs.get(String(resolved.target.ref));
        if (!widgetId) throw new Error(`Unknown or forward local widget ref "${resolved.target.ref}".`);
        resolved.target = { type: 'widget', widgetId };
    }
    const properties = resolved.action === 'create'
        ? resolved.payload?.widget?.properties
        : resolved.payload?.patch?.properties;
    if (properties?.connection) {
        properties.connection.from = resolveEndpoint(properties.connection.from, refs);
        properties.connection.to = resolveEndpoint(properties.connection.to, refs);
    }
    return resolved;
}

function changeForEvent(event) {
    if (event.action === 'create') {
        return { changeType: 'create', targetType: 'blackboard', widget: event.payload.widget };
    }
    if (event.action === 'group') {
        return { changeType: 'group', targetType: 'blackboard', widgetIds: event.payload.widgetIds };
    }
    return {
        changeType: event.action,
        targetType: event.target.type,
        targetRef: event.target.widgetId || event.target.groupId || '',
        patch: event.payload.patch,
        data: event.payload.data,
        reason: event.payload.reason || 'event',
    };
}

function eventAffectedIds(event, result) {
    if (event.action === 'clear') return [];
    if (event.action === 'group') return event.payload.widgetIds;
    if (Array.isArray(result)) return result.map((widget) => widget?.id).filter(Boolean);
    if (event.action === 'ungroup') return result?.id ? [result.id] : [];
    if (result instanceof BlackboardWidget) return [result.id];
    return event.target?.widgetId ? [event.target.widgetId] : [];
}

function normalizeCreatedWidget(widget = {}) {
    const normalized = cloneJson(widget);
    if (normalized.type === 'line') normalized.properties = normalizeFreeLineProperties(normalized.properties || {});
    return normalized;
}

async function canonicalizeImageAssetEvents(context, roomId, events) {
    const canonical = cloneJson(events);
    for (const event of canonical) {
        if (event.action !== 'create' || event.payload?.widget?.type !== 'image') continue;
        const properties = event.payload.widget.properties || {};
        if (!properties.source) continue;
        const assetId = String(properties.source.assetId || '').trim();
        const assetResult = await scriptaExplorer.getMedia(context, { roomId, assetId });
        const asset = publicMediaAsset(assetResult?.asset || assetResult);
        if (!asset.assetId || !asset.workspaceUrl) throw new Error('Explorer did not return a valid image asset.');
        const routeUrl = `/workspace-files/${asset.workspaceUrl.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`;
        properties.source = {
            kind: 'explorer-media', assetId: asset.assetId, url: routeUrl,
            name: asset.filename, mimeType: asset.mimeType
        };
        properties.naturalSize = { width: asset.width, height: asset.height };
    }
    return canonical;
}

function requiresImageAssetResolution(events) {
    return events.some((event) => (
        event?.action === 'create'
        && event?.payload?.widget?.type === 'image'
        && Boolean(event?.payload?.widget?.properties?.source)
    ));
}

export async function applyRoomBlackboardEvents(context, {
    roomId,
    boardId = '',
    events = [],
    participantId = '',
    authInfo = null,
    source = 'ui',
} = {}) {
    const targetRoomId = String(roomId || '').trim();
    const targetBoardId = assertBoardId(boardId);
    if (!Array.isArray(events) || !events.length) throw new Error('At least one blackboard event is required.');
    if (events.some((event) => ['show', 'hide'].includes(event.action))) {
        throw new Error('show and hide cannot be combined with persistent blackboard events.');
    }
    if (requiresImageAssetResolution(events)) {
        const authorizationRecord = await loadRoomRecord(context, targetRoomId);
        assertCanMutateBlackboard(authorizationRecord, authInfo);
        const authorizationPayload = decryptRoomPayload(context, authorizationRecord);
        authorizeRoomParticipantId(authorizationPayload, authInfo, participantId, targetRoomId);
    }
    const canonicalEvents = await canonicalizeImageAssetEvents(context, targetRoomId, events);
    let serializedBlackboard;
    let serializedWorkspace;
    let broadcast;
    let effectiveParticipantId = '';
    let changed = true;
    const appliedEvents = [];

    await mutateRoom(context, targetRoomId, (record, payload, stageEvent) => {
        assertCanMutateBlackboard(record, authInfo);
        effectiveParticipantId = authorizeRoomParticipantId(payload, authInfo, participantId, targetRoomId);
        const workspace = loadWorkspaceFromPayload(payload, targetRoomId);
        let blackboard = workspace.requireBoard(targetBoardId);
        const before = workspace.snapshot();
        const initialRevision = blackboard.revision;
        const refs = new Map();
        const affectedIds = [];
        const provenance = source === 'robo'
            ? { executor: ROBO_TEAM_PARTICIPANT_ID, requestedBy: effectiveParticipantId, source: 'robo' }
            : { executor: effectiveParticipantId, requestedBy: effectiveParticipantId, source: 'ui' };
        const actorId = source === 'robo' ? ROBO_TEAM_PARTICIPANT_ID : effectiveParticipantId;

        for (const rawEvent of canonicalEvents) {
            const event = resolveEvent(rawEvent, refs);
            if (event.action === 'undo' || event.action === 'redo') {
                if (canonicalEvents.length !== 1) throw new Error(`${event.action} cannot be combined with other events.`);
                const result = event.action === 'undo' ? workspace.undo() : workspace.redo();
                appliedEvents.push(event);
                if (!result) {
                    changed = false;
                    break;
                }
                blackboard = workspace.requireBoard(workspace.activeBoardId);
                continue;
            }
            if (['show', 'hide'].includes(event.action)) {
                appliedEvents.push(event);
                continue;
            }
            let change = changeForEvent(event);
            if (event.action === 'submit') change.participantId = effectiveParticipantId;
            if (event.action === 'create') {
                const id = newEventId('widget');
                change.widget = { ...normalizeCreatedWidget(change.widget), id };
                if (rawEvent.ref) {
                    if (refs.has(rawEvent.ref)) throw new Error(`Duplicate local widget ref "${rawEvent.ref}".`);
                    refs.set(rawEvent.ref, id);
                }
            }
            if (event.action === 'update' && event.target.type === 'widget') {
                const targetWidget = blackboard.getWidget(event.target.widgetId);
                if (!targetWidget) {
                    const error = new Error(`Blackboard widget "${event.target.widgetId}" was not found.`);
                    error.code = 'widget_not_found';
                    throw error;
                }
                assertCanonicalWidgetPatch(targetWidget, change.patch);
            }
            const result = blackboard.applyFinalChange(change, {
                participantId: actorId,
                permissionParticipantId: effectiveParticipantId,
                ownerParticipantId: effectiveParticipantId,
                provenance,
                record: false,
                moveGroup: change.reason === 'drag',
                canManagePoll: isAdminAuthInfo(authInfo),
                canModerateBlackboard: isAdminAuthInfo(authInfo),
            });
            affectedIds.push(...eventAffectedIds(event, result));
            appliedEvents.push({ ...event, ...(rawEvent.ref ? { ref: rawEvent.ref } : {}) });
        }
        const isHistoryMove = ['undo', 'redo'].includes(canonicalEvents[0].action);
        if (!isHistoryMove) blackboard.revision = initialRevision;
        if (!changed) {
            serializedWorkspace = saveWorkspaceToPayload(payload, targetRoomId, workspace);
            serializedBlackboard = blackboard.serializePrivileged();
            broadcast = null;
            return;
        }
        blackboard.bumpRevision();
        if (!isHistoryMove) {
            if (canonicalEvents.at(-1).action === 'clear' && !affectedIds.length) {
                blackboard.interactionContext = { focusedWidgetId: '', lastAffectedWidgetIds: [], updatedBy: '', updatedAt: '' };
            } else {
                blackboard.updateInteractionContext(affectedIds, { participantId: actorId });
            }
            if (!events.every((event) => event.action === 'focus')) {
                workspace.bumpRevision();
                workspace.record('command', before);
            }
        }
        serializedWorkspace = saveWorkspaceToPayload(payload, targetRoomId, workspace);
        serializedBlackboard = blackboard.serializePrivileged();
        broadcast = buildBroadcastPayload(targetRoomId, blackboard, blackboard.serializePrivileged(), 'blackboard');
        stageEvent('meeting', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, {
            meetingId: targetRoomId,
            boardId: blackboard.boardId,
            blackboardRevision: blackboard.revision,
            changeType: canonicalEvents.length > 1 ? 'command' : canonicalEvents[0].action,
            targetType: 'blackboard',
            targetRef: blackboard.interactionContext.focusedWidgetId,
            objectKind: 'blackboard',
        });
    });

    return {
        ok: true,
        changed,
        events: appliedEvents,
        blackboard: Blackboard.from(serializedBlackboard).serialize(buildViewerContext(authInfo, effectiveParticipantId)),
        workspace: BlackboardWorkspace.from(serializedWorkspace).serialize(buildViewerContext(authInfo, effectiveParticipantId)),
        broadcast,
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
    const targetBoardId = assertBoardId(boardId);
    let serializedBlackboard = null;
    let serializedObject = null;
    let broadcast = null;
    let normalizedChange = null;
    let deferredError = null;

    await mutateRoom(context, targetRoomId, (record, payload, stageEvent) => {
        assertCanMutateBlackboard(record, authInfo);
        normalizedChange = normalizeChange(change, authInfo);
        normalizedChange.participantId = authorizeRoomParticipantId(payload, authInfo, participantId, targetRoomId);
        sanitizeChangeAuthority(normalizedChange, authInfo);
        const workspace = loadWorkspaceFromPayload(payload, targetRoomId);
        const blackboard = workspace.requireBoard(targetBoardId);
        const before = workspace.snapshot();
        if (normalizedChange.changeType === 'submit') {
            const targetRef = String(normalizedChange.targetRef || '').trim();
            const targetWidget = blackboard.getWidget(targetRef);
            if (isExpiredPollWidget(targetWidget)) {
                const result = blackboard.closePoll(targetRef, {
                    participantId: normalizedChange.participantId,
                    canManagePoll: true,
                    record: false
                });
                workspace.bumpRevision();
                workspace.record('poll-close', before);
                saveWorkspaceToPayload(payload, targetRoomId, workspace);
                serializedBlackboard = blackboard.serializePrivileged();
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
            canModerateBlackboard: isAdminAuthInfo(authInfo),
            record: false,
        });
        workspace.bumpRevision();
        workspace.record('command', before);
        saveWorkspaceToPayload(payload, targetRoomId, workspace);
        serializedBlackboard = blackboard.serializePrivileged();
        const returnsBoardProjection = normalizedChange.changeType === 'clear'
            || normalizedChange.targetType === 'blackboard'
            || normalizedChange.targetType === 'group';
        serializedObject = returnsBoardProjection
            ? blackboard.serializePrivileged()
            : result?.serializePrivileged
                ? result.serializePrivileged()
                : blackboard.serializePrivileged();
        const objectKind = returnsBoardProjection ? 'blackboard' : 'widget';
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
    const returnsBoardProjection = normalizedChange?.changeType === 'clear'
        || normalizedChange?.targetType === 'blackboard'
        || normalizedChange?.targetType === 'group';
    return {
        blackboard: Blackboard.from(serializedBlackboard).serialize(viewerContext),
        object: returnsBoardProjection
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
    assertBoardId(boardId);
    let serializedBlackboard = null;
    let changed = false;
    let broadcast = null;
    let effectiveParticipantId = '';

    await mutateRoom(context, targetRoomId, (record, payload, stageEvent) => {
        assertCanMutateBlackboard(record, authInfo);
        effectiveParticipantId = authorizeRoomParticipantId(payload, authInfo, participantId, targetRoomId);
        const workspace = loadWorkspaceFromPayload(payload, targetRoomId);
        const result = direction === 'redo' ? workspace.redo() : workspace.undo();
        const blackboard = workspace.activeBoard;
        const viewerContext = buildViewerContext(authInfo, effectiveParticipantId);
        changed = Boolean(result);
        saveWorkspaceToPayload(payload, targetRoomId, workspace);
        serializedBlackboard = blackboard.serializePrivileged();
        broadcast = changed ? buildBroadcastPayload(targetRoomId, blackboard, blackboard.serializePrivileged(), 'blackboard') : null;
        if (changed) {
            stageEvent('meeting', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, {
                meetingId: targetRoomId,
                boardId: blackboard.boardId,
                boardOwnerType: blackboard.boardOwnerType,
                boardOwnerId: blackboard.boardOwnerId,
                boardVisibility: blackboard.boardVisibility,
                blackboardRevision: blackboard.revision,
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
