import crypto from 'node:crypto';

import { WEBMEET_EVENT_TYPES } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';
import { BlackboardWorkspace } from '../blackboard/workspace-model.mjs';
import {
    ROBO_TEAM_PARTICIPANT_ID,
    ensureRoboTeamAgentPayload,
    ensureRoboTeamBlackboardWorkspacePayload,
} from '../roboTeam/service.mjs';
import {
    canViewMeetingRecord,
    isGuestAuthInfo,
    normalizeAuthInfo,
} from '../store/accessPolicy.mjs';
import { authorizeRoomParticipantId } from '../store/participantAuthorization.mjs';
import { withQueuedRoomLock } from '../store/roomLocks.mjs';
import { decryptRoomPayload, listRoomRecords, loadRoomRecord, mutateRoom } from '../store/roomRecords.mjs';
import { callScriptaExplorer, scriptaExplorer } from './explorer-crdt-client.mjs';
import { scriptaOwnerHash } from './identity.mjs';
import {
    MEETING_SECRETARY_PRINCIPAL,
    resetMeetingNotesForRemovedDocument,
} from '../meetingNotes/service.mjs';

export const SCRIPTA_DOCUMENT_WIDGET_ID = 'robo_scripta_document';
export const SCRIPTA_DOCUMENT_WIDGET_TYPE = 'scripta-document';

const MAX_AUDIT_ENTRIES = 500;
const DOCUMENT_CHANGE_OPERATIONS = new Set([
    'document-create',
    'document-delete',
    'p-variant-add',
    'p-variant-vote',
    'p-variant-vote-withdraw',
    'p-variant-edit',
    'p-variant-delete',
    'p-variant-image-insert',
    'p-variant-image-replace',
    'p-variant-image-delete',
    'p-variant-image-layout',
    'chapter-add',
    'chapter-delete',
    'chapter-rename',
    'chapter-move',
    'paragraph-add',
    'paragraph-delete',
    'paragraph-move',
    'markdown-collaboration-merged',
    'undo',
]);

const EXPLORER_MUTATION_ARGUMENT_KEYS = Object.freeze({
    'p-variant-add': Object.freeze(['chapterId', 'paragraphId', 'text']),
    'p-variant-vote': Object.freeze(['chapterId', 'paragraphId', 'variantId', 'variantOrdinal', 'type']),
    'p-variant-vote-withdraw': Object.freeze(['chapterId', 'paragraphId', 'variantId', 'variantOrdinal']),
    'p-variant-edit': Object.freeze(['chapterId', 'paragraphId', 'variantId', 'variantOrdinal', 'text']),
    'p-variant-delete': Object.freeze(['chapterId', 'paragraphId', 'variantId', 'variantOrdinal']),
    'p-variant-image-insert': Object.freeze([
        'chapterId', 'paragraphId', 'variantId', 'variantOrdinal', 'assetId', 'alt', 'position', 'widthPercent',
        'aspectRatio', 'fit', 'alignment', 'showCaption', 'roomId', 'roomFolderPath',
    ]),
    'p-variant-image-replace': Object.freeze([
        'chapterId', 'paragraphId', 'variantId', 'variantOrdinal', 'imageId', 'imageOrdinal', 'assetId', 'alt', 'position', 'widthPercent',
        'aspectRatio', 'fit', 'alignment', 'showCaption', 'roomId', 'roomFolderPath',
    ]),
    'p-variant-image-delete': Object.freeze(['chapterId', 'paragraphId', 'variantId', 'variantOrdinal', 'imageId', 'imageOrdinal']),
    'p-variant-image-layout': Object.freeze([
        'chapterId', 'paragraphId', 'variantId', 'variantOrdinal', 'imageId', 'imageOrdinal',
        'widthPercent', 'aspectRatio', 'fit', 'alignment', 'showCaption',
    ]),
    'chapter-add': Object.freeze(['title']),
    'chapter-delete': Object.freeze(['chapterId']),
    'chapter-rename': Object.freeze(['chapterId', 'title']),
    'chapter-move': Object.freeze(['chapterId', 'targetIndex']),
    'paragraph-add': Object.freeze(['chapterId', 'text', 'assetId', 'alt', 'roomId', 'roomFolderPath']),
    'paragraph-delete': Object.freeze(['chapterId', 'paragraphId']),
    'paragraph-move': Object.freeze(['chapterId', 'paragraphId', 'targetChapterId', 'targetIndex']),
    undo: Object.freeze([]),
});

const OPTIONAL_ENUM_MUTATION_ARGUMENTS = new Set(['aspectRatio', 'fit', 'alignment']);

function projectExplorerMutationArguments(operation, args = {}) {
    const allowedKeys = EXPLORER_MUTATION_ARGUMENT_KEYS[operation];
    if (!allowedKeys) throw new Error(`Unsupported SCRIPTA operation "${operation}".`);
    const projected = {};
    for (const key of allowedKeys) {
        const value = args[key];
        if (value === undefined || value === null) continue;
        if (OPTIONAL_ENUM_MUTATION_ARGUMENTS.has(key) && String(value).trim() === '') continue;
        projected[key] = value;
    }
    return projected;
}

function resolveVariantSelector(args = {}, selectedVariantId = '') {
    const explicitVariantId = String(args.variantId || '').trim();
    if (explicitVariantId) return { variantId: explicitVariantId };
    if (args.variantOrdinal !== undefined && args.variantOrdinal !== null && args.variantOrdinal !== '') {
        return { variantOrdinal: args.variantOrdinal };
    }
    const fallbackVariantId = String(selectedVariantId || '').trim();
    return fallbackVariantId ? { variantId: fallbackVariantId } : {};
}

function documentAttachmentLockId(documentPath = '') {
    return stableId('scripta-document-lock', String(documentPath || '').trim().toLowerCase());
}

function withDocumentAttachmentLock(context, documentPath, operation) {
    return withQueuedRoomLock(context, documentAttachmentLockId(documentPath), operation);
}

function nowIso() {
    return new Date().toISOString();
}

function stableId(prefix, ...parts) {
    const digest = crypto.createHash('sha256').update(parts.map(String).join('\0')).digest('hex').slice(0, 20);
    return `${prefix}_${digest}`;
}

function slugify(value = '') {
    return String(value || 'room')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'room';
}

function participantIdentity(payload, authInfo = null, participantId = '', roomId = '') {
    const auth = normalizeAuthInfo(authInfo);
    const secretary = isMeetingSecretaryAuth(authInfo)
        && String(participantId || '').trim() === 'agent_meeting_secretary';
    const viewId = secretary
        ? 'agent_meeting_secretary'
        : authorizeRoomParticipantId(payload, authInfo, participantId, roomId);
    const source = String(secretary ? auth.principalId : (auth.id || auth.principalId || viewId)).trim();
    if (!source) throw new Error('SCRIPTA requires an admitted participant identity.');
    return {
        id: source,
        viewId,
        hash: scriptaOwnerHash(source),
        label: secretary
            ? 'Meeting Secretary'
            : String(auth.name || auth.username || auth.email || source).trim() || source,
    };
}

function isMeetingSecretaryAuth(authInfo = null) {
    const principal = String(authInfo?.agent?.principalId || '').trim().toLowerCase();
    return principal === MEETING_SECRETARY_PRINCIPAL.toLowerCase();
}

function roomFolderPath(record) {
    const roomId = String(record.meetingId || record.roomId || '').trim();
    const shortId = roomId.replace(/^room_/, '').slice(0, 8) || stableId('room', roomId).slice(-8);
    return `/WebMeet/${slugify(record.name || record.title || 'room')}-${shortId}`;
}

export function getScriptaRoomFolderPath(record, payload = {}) {
    return String(payload?.scripta?.folderPath || roomFolderPath(record)).trim();
}

function ensureScriptaPayload(record, payload) {
    payload.scripta = payload.scripta && typeof payload.scripta === 'object' ? payload.scripta : {};
    const scripta = payload.scripta;
    scripta.folderPath ||= getScriptaRoomFolderPath(record, payload);
    scripta.documents = scripta.documents && typeof scripta.documents === 'object' ? scripta.documents : {};
    scripta.activeResourceIdsByBoard = scripta.activeResourceIdsByBoard
        && typeof scripta.activeResourceIdsByBoard === 'object'
        && !Array.isArray(scripta.activeResourceIdsByBoard)
        ? scripta.activeResourceIdsByBoard
        : {};
    scripta.audit = Array.isArray(scripta.audit) ? scripta.audit : [];
    scripta.participants = scripta.participants && typeof scripta.participants === 'object' ? scripta.participants : {};
    const workspace = (payload.agents || []).find((agent) => String(agent?.agentType || '') === 'robo_team')
        ?.blackboardWorkspace;
    const projectedResourceIdsByBoard = new Map();
    for (const board of workspace?.boards || []) {
        const boardId = String(board.boardId || board.id || '');
        const resourceId = String((board?.widgets || []).find(
            (widget) => String(widget?.id || '') === SCRIPTA_DOCUMENT_WIDGET_ID
        )?.properties?.resourceId || '');
        if (resourceId && scripta.documents[resourceId]) {
            const entry = scripta.documents[resourceId];
            entry.boardId = boardId;
            entry.boardPurpose = String(board.metadata?.purpose || '');
            projectedResourceIdsByBoard.set(boardId, resourceId);
            scripta.activeResourceIdsByBoard[boardId] = resourceId;
        }
    }
    for (const [boardId, resourceId] of Object.entries(scripta.activeResourceIdsByBoard)) {
        const entry = scripta.documents[String(resourceId || '')];
        if (
            !entry
            || String(entry.boardId || '') !== String(boardId)
            || projectedResourceIdsByBoard.get(String(boardId)) !== String(resourceId)
        ) {
            delete scripta.activeResourceIdsByBoard[boardId];
        }
    }
    for (const entry of Object.values(scripta.documents)) {
        if (!entry.view || typeof entry.view !== 'object') {
            entry.view = viewFromProjection(entry.projection);
        }
    }
    payload.resources = Array.isArray(payload.resources) ? payload.resources : [];
    return scripta;
}

export function deactivateScriptaDocumentOnBoard(payload, { boardId = '', resourceId = '' } = {}) {
    const activeByBoard = payload?.scripta?.activeResourceIdsByBoard;
    if (!activeByBoard || typeof activeByBoard !== 'object' || Array.isArray(activeByBoard)) return false;
    const targetBoardId = String(boardId || '');
    const targetResourceId = String(resourceId || '');
    let changed = false;
    for (const [candidateBoardId, candidateResourceId] of Object.entries(activeByBoard)) {
        if (targetBoardId && candidateBoardId !== targetBoardId) continue;
        if (targetResourceId && String(candidateResourceId || '') !== targetResourceId) continue;
        delete activeByBoard[candidateBoardId];
        changed = true;
    }
    return changed;
}

function activeWorkspaceBoardId(payload) {
    return String((payload.agents || []).find(
        (agent) => String(agent?.agentType || '') === 'robo_team'
    )?.blackboardWorkspace?.activeBoardId || '');
}

function activeEntry(scripta, payload, resourceId = '') {
    const requestedResourceId = String(resourceId || '');
    if (requestedResourceId) {
        const requested = scripta.documents?.[requestedResourceId] || null;
        if (!requested) return null;
        const boardId = String(requested.boardId || '');
        const activeForBoard = String(scripta.activeResourceIdsByBoard?.[boardId] || '');
        return !boardId || activeForBoard === requestedResourceId ? requested : null;
    }
    const boardId = activeWorkspaceBoardId(payload);
    const boardResourceId = String(scripta.activeResourceIdsByBoard?.[boardId] || '');
    if (boardResourceId) return scripta.documents?.[boardResourceId] || null;
    const projectedResourceIds = [...new Set(
        Object.values(scripta.activeResourceIdsByBoard || {}).map((value) => String(value || '')).filter(Boolean)
    )];
    if (projectedResourceIds.length !== 1) return null;
    const projected = scripta.documents?.[projectedResourceIds[0]] || null;
    return projected?.boardPurpose === 'meeting-notes' ? null : projected;
}

function defaultScriptaView() {
    return { mode: 'document', chapterId: '', paragraphId: '' };
}

function viewFromProjection(projection = null, fallback = null) {
    const source = fallback && typeof fallback === 'object' ? fallback : defaultScriptaView();
    const paragraph = projection?.paragraph || null;
    return {
        mode: projection?.viewMode === 'paragraph' ? 'paragraph' : (source.mode === 'paragraph' ? 'paragraph' : 'document'),
        chapterId: String(projection?.focusedChapterId || source.chapterId || ''),
        paragraphId: String(projection?.focusedParagraphId || source.paragraphId || ''),
        selectedVariantId: String(paragraph?.selectedVariantId || source.selectedVariantId || ''),
        editingVariantId: String(paragraph?.editingVariantId || source.editingVariantId || ''),
        editorParticipantId: String(paragraph?.editorParticipantId || source.editorParticipantId || ''),
        focusTargetType: String(projection?.focusTargetType || source.focusTargetType || 'paragraph') === 'chapter'
            ? 'chapter'
            : 'paragraph',
        autoFocusRevision: Math.max(0, Number(projection?.autoFocusRevision || source.autoFocusRevision || 0)),
    };
}

function entryView(entry) {
    return entry?.view && typeof entry.view === 'object'
        ? entry.view
        : defaultScriptaView();
}

function setEntryView(entry, view) {
    const next = structuredClone(view || defaultScriptaView());
    if (entry) entry.view = next;
    return next;
}

function replaceActiveDocument(scripta, payload, entry = null, { removeResourceId = '' } = {}) {
    scripta.documents = scripta.documents && typeof scripta.documents === 'object' ? scripta.documents : {};
    if (entry) {
        const previousBoardResourceId = String(scripta.activeResourceIdsByBoard[entry.boardId] || '');
        if (previousBoardResourceId && previousBoardResourceId !== entry.resourceId) {
            delete scripta.documents[previousBoardResourceId];
            payload.resources = payload.resources.filter(
                (resource) => resource.resourceId !== previousBoardResourceId
            );
        }
        scripta.documents[entry.resourceId] = entry;
    }
    const removedId = String(removeResourceId || '');
    if (removedId) {
        const removed = scripta.documents[removedId];
        const removedBoardId = String(removed?.boardId || '');
        if (removed) {
            scripta.pendingRemovedProjection = {
                boardId: String(removed.boardId || ''), resourceId: removedId,
            };
            delete scripta.documents[removedId];
        }
        payload.resources = payload.resources.filter((resource) => resource.resourceId !== removedId);
        if (removedBoardId && scripta.activeResourceIdsByBoard[removedBoardId] === removedId) {
            const sameBoard = Object.values(scripta.documents)
                .find((item) => String(item.boardId || '') === removedBoardId);
            if (sameBoard) scripta.activeResourceIdsByBoard[removedBoardId] = sameBoard.resourceId;
            else delete scripta.activeResourceIdsByBoard[removedBoardId];
        }
    }
    if (entry?.boardId) scripta.activeResourceIdsByBoard[entry.boardId] = entry.resourceId;
    if (entry) {
        payload.resources = payload.resources.filter((resource) => resource.resourceId !== entry.resourceId);
        payload.resources.push({
            resourceId: entry.resourceId,
            kind: 'scripta-document',
            documentId: entry.documentId,
            title: entry.title,
            path: entry.path,
            roomId: entry.roomId,
            visibility: 'room',
            createdAt: entry.attachedAt,
            deletedAt: null,
        });
    }
}

function resolveScriptaDocumentBoard(workspace, entry = null, requestedBoardId = '') {
    const requested = workspace.getBoard(String(requestedBoardId || ''));
    if (requested) return requested;
    if (entry?.boardPurpose === 'meeting-notes') {
        const fixed = workspace.getBoard(String(entry.boardId || ''));
        if (fixed) return fixed;
    }
    const projected = [...workspace.boards.values()].find((board) => {
        const widget = board.getWidget(SCRIPTA_DOCUMENT_WIDGET_ID);
        return widget && String(widget.properties?.resourceId || '') === String(entry?.resourceId || '');
    });
    return projected || workspace.getBoard(String(entry?.boardId || '')) || workspace.activeBoard;
}

function prepareScriptaWorkspace(record, payload, scripta) {
    const agent = ensureRoboTeamAgentPayload(payload, null, record.meetingId);
    const workspace = BlackboardWorkspace.from(ensureRoboTeamBlackboardWorkspacePayload(agent, record.meetingId));
    for (const entry of Object.values(scripta.documents || {})) {
        if (entry.boardId) continue;
        const board = resolveScriptaDocumentBoard(workspace, entry);
        entry.boardId = board.boardId;
        entry.boardPurpose = String(board.metadata?.purpose || '');
    }
    return workspace;
}

function updateEntryFromCrdt(entry, result) {
    entry.documentId = result.documentId;
    entry.title = result.projection?.documentTitle || result.model?.metadata?.title || entry.title || 'SCRIPTA Document';
    entry.revision = Number(result.projection?.documentRevision || result.model?.metadata?.version || 0);
    entry.projection = result.projection;
    return entry;
}

function hasRenderableProjection(entry) {
    const projection = entry?.projection;
    return Boolean(
        projection
        && projection.resourceId
        && projection.documentTitle
        && Array.isArray(projection.chapters)
    );
}

function projectStoredView(entry, view) {
    const projection = entry.projection;
    entry.projection = {
        ...projection,
        viewMode: view.mode,
        focusedChapterId: view.chapterId,
        focusedParagraphId: view.paragraphId,
        paragraph: projection.paragraph
            ? {
                ...projection.paragraph,
                selectedVariantId: (projection.paragraph.variants || []).some(
                    (variant) => variant.id === view.selectedVariantId
                )
                    ? view.selectedVariantId
                    : projection.paragraph.activeVariantId,
                editingVariantId: (projection.paragraph.variants || []).some(
                    (variant) => variant.id === view.editingVariantId
                )
                    ? view.editingVariantId
                    : '',
                editorParticipantId: view.editingVariantId
                    ? String(view.editorParticipantId || '')
                    : '',
            }
            : null,
        focusTargetType: view.focusTargetType || projection.focusTargetType || 'paragraph',
        autoFocusRevision: Number(view.autoFocusRevision || projection.autoFocusRevision || 0),
    };
    return entry.projection;
}

function isMissingScriptaDocument(error) {
    const message = String(error?.message || '');
    return error?.code === 'ENOENT'
        || /\bENOENT\b/i.test(message)
        || /no such file or directory/i.test(message);
}

async function refreshEntry(context, entry, scripta, participant, view = entryView(entry)) {
    const result = await scriptaExplorer.open(context, {
        path: entry.path,
        resourceId: entry.resourceId,
        viewerHash: participant.hash,
        view,
        participantMap: scripta.participants,
    });
    return updateEntryFromCrdt(entry, result);
}

function updateBlackboardProjection(record, payload, { resourceId = '' } = {}) {
    const scripta = ensureScriptaPayload(record, payload);
    const entry = resourceId
        ? scripta.documents[String(resourceId || '')] || null
        : activeEntry(scripta, payload);
    const agent = ensureRoboTeamAgentPayload(payload, null, record.meetingId);
    const workspace = BlackboardWorkspace.from(ensureRoboTeamBlackboardWorkspacePayload(agent, record.meetingId));
    const pendingRemoval = scripta.pendingRemovedProjection;
    if (pendingRemoval?.boardId) {
        const removalBoard = workspace.getBoard(String(pendingRemoval.boardId));
        const removalWidget = removalBoard?.getWidget(SCRIPTA_DOCUMENT_WIDGET_ID);
        if (removalWidget && String(removalWidget.properties?.resourceId || '') === String(pendingRemoval.resourceId || '')) {
            removalBoard.removeWidget(SCRIPTA_DOCUMENT_WIDGET_ID, {
                participantId: ROBO_TEAM_PARTICIPANT_ID,
                canModerateBlackboard: true,
                record: false,
            });
            removalBoard.bumpRevision();
            workspace.bumpRevision();
        }
    }
    delete scripta.pendingRemovedProjection;
    const blackboard = entry
        ? resolveScriptaDocumentBoard(workspace, entry)
        : workspace.activeBoard;
    if (entry) {
        entry.boardId = blackboard.boardId;
        entry.boardPurpose ||= String(blackboard.metadata?.purpose || '');
        scripta.activeResourceIdsByBoard[blackboard.boardId] = entry.resourceId;
    }
    const initialRevision = blackboard.revision;
    if (!entry) {
        let changed = false;
        for (const board of workspace.boards.values()) {
            const widget = board.getWidget(SCRIPTA_DOCUMENT_WIDGET_ID);
            if (!widget) continue;
            const widgetResourceId = String(widget.properties?.resourceId || '');
            const activeResourceId = String(scripta.activeResourceIdsByBoard?.[board.boardId] || '');
            if (scripta.documents[widgetResourceId] && activeResourceId === widgetResourceId) continue;
            const boardRevision = board.revision;
            board.removeWidget(SCRIPTA_DOCUMENT_WIDGET_ID, {
                participantId: ROBO_TEAM_PARTICIPANT_ID,
                canModerateBlackboard: true,
                record: false,
            });
            board.revision = boardRevision;
            board.bumpRevision();
            changed = true;
        }
        if (changed) workspace.bumpRevision();
        agent.blackboardWorkspace = workspace.serializePrivileged();
        return blackboard;
    }
    const existing = blackboard.getWidget(SCRIPTA_DOCUMENT_WIDGET_ID);
    const geometry = existing?.properties?.geometry
        ? { ...existing.properties.geometry }
        : { x: 24, y: 24, width: 600, height: 400 };
    const properties = {
        ...entry.projection,
        geometry,
    };
    const widget = {
        id: SCRIPTA_DOCUMENT_WIDGET_ID,
        type: SCRIPTA_DOCUMENT_WIDGET_TYPE,
        properties,
        visibility: { mode: 'all' },
        createdBy: ROBO_TEAM_PARTICIPANT_ID,
    };
    if (existing) {
        existing.type = widget.type;
        existing.properties = widget.properties;
        existing.updatedAt = nowIso();
    } else {
        blackboard.applyFinalChange({ changeType: 'create', targetType: 'widget', widget }, {
            participantId: ROBO_TEAM_PARTICIPANT_ID,
            canModerateBlackboard: true,
            canManagePoll: true,
            record: false,
        });
    }
    blackboard.revision = initialRevision;
    blackboard.bumpRevision();
    workspace.bumpRevision();
    agent.blackboardWorkspace = workspace.serializePrivileged();
    return blackboard;
}

function stageEvents(stageEvent, record, entry, participant, operation, blackboard) {
    const base = {
        meetingId: record.meetingId,
        resourceId: entry?.resourceId || '',
        documentId: entry?.documentId || '',
        documentRevision: Number(entry?.revision || 0),
        participantId: participant.viewId,
    };
    if (DOCUMENT_CHANGE_OPERATIONS.has(operation)) {
        stageEvent('meeting', WEBMEET_EVENT_TYPES.SCRIPTA_DOCUMENT_CHANGED, base);
    }
    if (operation === 'p-variant-vote' || operation === 'p-variant-vote-withdraw') {
        stageEvent('meeting', WEBMEET_EVENT_TYPES.SCRIPTA_VOTE_CHANGED, base);
    }
    stageEvent('meeting', WEBMEET_EVENT_TYPES.SCRIPTA_CONTEXT_CHANGED, base);
    stageEvent('meeting', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, {
        ...base,
        boardId: blackboard.boardId,
        blackboardRevision: blackboard.revision,
        changeType: 'update',
    });
}

function serializeBlackboard(blackboard, participant, authInfo) {
    const auth = normalizeAuthInfo(authInfo);
    return blackboard.serialize({
        participantId: participant.viewId,
        userId: auth.id,
        roles: auth.roles,
        scriptaOwnerHash: participant.hash,
    });
}

async function assertDocumentAvailable(context, roomId, documentPath) {
    const pathValue = String(documentPath || '').trim();
    for (const record of await listRoomRecords(context)) {
        if (record.meetingId === roomId) continue;
        const payload = decryptRoomPayload(context, record);
        const attached = Object.values(payload.scripta?.documents || {})
            .some((entry) => String(entry?.path || '') === pathValue);
        if (attached) {
            throw new Error('This SCRIPTA document is already attached to another room.');
        }
    }
    return pathValue;
}

export async function ensureScriptaRoomFolder(context, { roomId, authInfo = null } = {}) {
    let folderPath = '';
    await mutateRoom(context, roomId, async (record, payload) => {
        if (authInfo && !canViewMeetingRecord(record, authInfo)) throw new Error('Room not found.');
        folderPath = ensureScriptaPayload(record, payload).folderPath;
    });
    return scriptaExplorer.ensureFolder(context, { folderPath });
}

export async function listScriptaWorkspaceEntries(context, { roomId, authInfo = null } = {}) {
    if (isGuestAuthInfo(authInfo)) throw new Error('Guests cannot browse the workspace tree.');
    const record = await loadRoomRecord(context, roomId);
    if (!canViewMeetingRecord(record, authInfo)) throw new Error('Room not found.');
    const payload = decryptRoomPayload(context, record);
    return scriptaExplorer.listWorkspace(context, {
        defaultFolder: ensureScriptaPayload(record, payload).folderPath,
    });
}

async function createScriptaDocumentImpl(context, {
    roomId,
    name = '',
    template = 'general',
    folderPath = '',
    initialization = {},
    boardId = '',
    participantId = '',
    authInfo = null,
} = {}) {
    const safeName = slugify(String(name || '').replace(/\.md$/i, ''));
    if (!safeName) throw new Error('SCRIPTA document name is required.');
    let output;
    let createdDocument = null;
    try {
        await mutateRoom(context, roomId, async (record, payload, stageEvent) => {
            if (!canViewMeetingRecord(record, authInfo)) throw new Error('Room not found.');
            const participant = participantIdentity(payload, authInfo, participantId, record.meetingId);
            const scripta = ensureScriptaPayload(record, payload);
            const workspace = boardId
                ? prepareScriptaWorkspace(record, payload, scripta)
                : BlackboardWorkspace.from(ensureRoboTeamBlackboardWorkspacePayload(
                    ensureRoboTeamAgentPayload(payload, null, record.meetingId), record.meetingId,
                ));
            const documentBoard = resolveScriptaDocumentBoard(workspace, null, boardId || workspace.activeBoardId);
            const selectedFolder = isGuestAuthInfo(authInfo) ? scripta.folderPath : String(folderPath || scripta.folderPath);
            const documentPath = `${selectedFolder.replace(/\/$/, '')}/${safeName}.md`;
            await assertDocumentAvailable(context, roomId, documentPath);
            const resourceId = stableId('resource', record.meetingId, documentPath);
            const view = { mode: 'document', chapterId: '', paragraphId: '' };
            const result = await scriptaExplorer.create(context, {
                path: documentPath,
                title: String(initialization.title || name).trim(),
                template: String(template || 'general').toLowerCase(),
                initialization,
                createdBy: participant.hash,
                resourceId,
                viewerHash: participant.hash,
                view,
            });
            createdDocument = {
                resourceId,
                name: `${safeName}.md`,
            };
            const firstChapter = result.projection?.chapters?.[0];
            view.chapterId = firstChapter?.chapterId || '';
            view.paragraphId = firstChapter?.paragraphs?.[0]?.paragraphId || '';
            const entry = updateEntryFromCrdt({
                resourceId,
                path: result.path || documentPath,
                roomId: record.meetingId,
                attachedAt: nowIso(),
                attachedBy: participant.id,
                boardId: documentBoard.boardId,
                boardPurpose: String(documentBoard.metadata?.purpose || ''),
            }, result);
            replaceActiveDocument(scripta, payload, entry);
            setEntryView(entry, view);
            projectStoredView(entry, view);
            const blackboard = updateBlackboardProjection(record, payload, { resourceId: entry.resourceId });
            stageEvents(stageEvent, record, entry, participant, 'document-create', blackboard);
            output = {
                ok: true,
                resourceId,
                focus: structuredClone(view),
                blackboard: serializeBlackboard(blackboard, participant, authInfo),
            };
        });
    } catch (error) {
        if (!createdDocument) throw error;
        const attachmentError = new Error(
            `Documentul ${createdDocument.name} a fost creat, dar nu a putut fi atașat camerei. Deschide documentul existent pentru a reîncerca atașarea.`,
            { cause: error }
        );
        attachmentError.code = 'scripta_attachment_failed';
        attachmentError.documentCreated = true;
        attachmentError.attached = false;
        attachmentError.resourceId = createdDocument.resourceId;
        attachmentError.documentName = createdDocument.name;
        throw attachmentError;
    }
    return output;
}

export async function createScriptaDocument(context, input = {}) {
    const record = await loadRoomRecord(context, input.roomId);
    if (!canViewMeetingRecord(record, input.authInfo)) throw new Error('Room not found.');
    const payload = decryptRoomPayload(context, record);
    const scripta = ensureScriptaPayload(record, payload);
    const safeName = slugify(String(input.name || '').replace(/\.md$/i, ''));
    if (!safeName) throw new Error('SCRIPTA document name is required.');
    const selectedFolder = isGuestAuthInfo(input.authInfo)
        ? scripta.folderPath
        : String(input.folderPath || scripta.folderPath);
    const documentPath = `${selectedFolder.replace(/\/$/, '')}/${safeName}.md`;
    return withDocumentAttachmentLock(
        context,
        documentPath,
        () => createScriptaDocumentImpl(context, input)
    );
}

function documentFileName(value = '') {
    return String(value || '').trim().replace(/\\/g, '/').split('/').pop() || '';
}

async function resolveGuestDocumentPath(context, scripta, requestedPath) {
    const requestedName = documentFileName(requestedPath);
    if (!requestedName) throw new Error('SCRIPTA document name is required.');
    const expectedName = `${slugify(requestedName.replace(/\.md$/i, ''))}.md`;
    const listing = await scriptaExplorer.listWorkspace(context, {
        defaultFolder: scripta.folderPath,
    });
    const matches = (Array.isArray(listing.defaultDocuments) ? listing.defaultDocuments : [])
        .filter((entry) => documentFileName(entry).toLowerCase() === expectedName);
    if (matches.length !== 1) {
        throw new Error('The requested SCRIPTA document was not found in this room.');
    }
    return matches[0];
}

async function openScriptaDocumentImpl(context, {
    roomId,
    path: documentPath,
    boardId = '',
    participantId = '',
    authInfo = null,
} = {}) {
    let output;
    await mutateRoom(context, roomId, async (record, payload, stageEvent) => {
        if (!canViewMeetingRecord(record, authInfo)) throw new Error('Room not found.');
        const participant = participantIdentity(payload, authInfo, participantId, record.meetingId);
        const scripta = ensureScriptaPayload(record, payload);
        const resolvedDocumentPath = isGuestAuthInfo(authInfo)
            ? await resolveGuestDocumentPath(context, scripta, documentPath)
            : String(documentPath || '').trim();
        await assertDocumentAvailable(context, roomId, resolvedDocumentPath);
        const resourceId = stableId('resource', record.meetingId, resolvedDocumentPath);
        const previousEntry = scripta.documents?.[resourceId] || null;
        const view = { mode: 'document', chapterId: '', paragraphId: '' };
        const result = await scriptaExplorer.open(context, {
            path: resolvedDocumentPath,
            resourceId,
            viewerHash: participant.hash,
            view,
        });
        const firstChapter = result.projection?.chapters?.[0];
        view.chapterId = firstChapter?.chapterId || '';
        view.paragraphId = firstChapter?.paragraphs?.[0]?.paragraphId || '';
        const entry = updateEntryFromCrdt({
            resourceId,
            path: result.path || resolvedDocumentPath,
            roomId: record.meetingId,
            attachedAt: nowIso(),
            attachedBy: participant.id,
            boardId: String(previousEntry?.boardId || ''),
            boardPurpose: String(previousEntry?.boardPurpose || ''),
        }, result);
        if (!entry.boardId) {
            const workspace = BlackboardWorkspace.from(ensureRoboTeamBlackboardWorkspacePayload(
                ensureRoboTeamAgentPayload(payload, null, record.meetingId), record.meetingId,
            ));
            const documentBoard = resolveScriptaDocumentBoard(
                workspace,
                previousEntry,
                boardId || workspace.activeBoardId,
            );
            entry.boardId = documentBoard.boardId;
            entry.boardPurpose = String(documentBoard.metadata?.purpose || '');
        }
        replaceActiveDocument(scripta, payload, entry);
        setEntryView(entry, view);
        projectStoredView(entry, view);
        const blackboard = updateBlackboardProjection(record, payload, { resourceId: entry.resourceId });
        stageEvents(stageEvent, record, entry, participant, 'document-open', blackboard);
        output = { ok: true, resourceId, blackboard: serializeBlackboard(blackboard, participant, authInfo) };
    });
    return output;
}

export async function openScriptaDocument(context, input = {}) {
    const record = await loadRoomRecord(context, input.roomId);
    if (!canViewMeetingRecord(record, input.authInfo)) throw new Error('Room not found.');
    const payload = decryptRoomPayload(context, record);
    const scripta = ensureScriptaPayload(record, payload);
    const rawRequestedPath = String(input.path || '').trim();
    const requestedPath = isGuestAuthInfo(input.authInfo)
        ? `${scripta.folderPath.replace(/\/$/, '')}/${slugify(documentFileName(input.path).replace(/\.md$/i, ''))}.md`
        : rawRequestedPath.includes('/')
            ? rawRequestedPath
            : `${scripta.folderPath.replace(/\/$/, '')}/${documentFileName(rawRequestedPath)}`;
    input = { ...input, path: requestedPath };
    return withDocumentAttachmentLock(
        context,
        requestedPath,
        () => openScriptaDocumentImpl(context, input)
    );
}

async function manageScriptaDocumentImpl(context, {
    roomId,
    operation,
    resourceId = '',
    confirmed = false,
    participantId = '',
    authInfo = null,
} = {}) {
    if (operation !== 'document-delete') throw new Error(`Unsupported SCRIPTA document operation "${operation}".`);
    if (confirmed !== true) throw new Error('Physical document deletion requires explicit confirmation.');
    const record = await loadRoomRecord(context, roomId);
    if (!canViewMeetingRecord(record, authInfo)) throw new Error('Room not found.');
    const currentPayload = decryptRoomPayload(context, record);
    const participant = participantIdentity(currentPayload, authInfo, participantId, record.meetingId);
    const currentScripta = ensureScriptaPayload(record, currentPayload);
    const currentEntry = activeEntry(currentScripta, currentPayload, resourceId);
    const id = String(currentEntry?.resourceId || '');
    if (!currentEntry) throw new Error('SCRIPTA document was not found in this room.');

    const originalEntry = structuredClone(currentEntry);
    const originalView = structuredClone(entryView(currentEntry));
    const prepared = await scriptaExplorer.delete(context, {
        phase: 'prepare',
        documentId: currentEntry.documentId,
        path: currentEntry.path,
    });

    let output;
    try {
        await mutateRoom(context, roomId, async (freshRecord, payload, stageEvent) => {
            if (!canViewMeetingRecord(freshRecord, authInfo)) throw new Error('Room not found.');
            const scripta = ensureScriptaPayload(freshRecord, payload);
            const entry = scripta.documents[id];
            if (!entry) throw new Error('SCRIPTA document was not found in this room.');
            replaceActiveDocument(scripta, payload, null, { removeResourceId: id });
            resetMeetingNotesForRemovedDocument(payload, { resourceId: id });
            const blackboard = updateBlackboardProjection(freshRecord, payload);
            stageEvents(stageEvent, freshRecord, originalEntry, participant, operation, blackboard);
            output = { ok: true, resourceId: id, blackboard: serializeBlackboard(blackboard, participant, authInfo) };
        });
    } catch (error) {
        await scriptaExplorer.delete(context, {
            phase: 'rollback',
            transactionId: prepared.transactionId,
        });
        throw error;
    }

    try {
        await scriptaExplorer.delete(context, {
            phase: 'commit',
            transactionId: prepared.transactionId,
        });
    } catch (error) {
        await scriptaExplorer.delete(context, {
            phase: 'rollback',
            transactionId: prepared.transactionId,
        });
        await mutateRoom(context, roomId, async (freshRecord, payload) => {
            const scripta = ensureScriptaPayload(freshRecord, payload);
            replaceActiveDocument(scripta, payload, originalEntry);
            setEntryView(originalEntry, originalView);
            updateBlackboardProjection(freshRecord, payload, { resourceId: originalEntry.resourceId });
        });
        throw error;
    }
    return output;
}

export async function manageScriptaDocument(context, input = {}) {
    const record = await loadRoomRecord(context, input.roomId);
    if (!canViewMeetingRecord(record, input.authInfo)) throw new Error('Room not found.');
    const payload = decryptRoomPayload(context, record);
    const scripta = ensureScriptaPayload(record, payload);
    const entry = activeEntry(scripta, payload, input.resourceId);
    if (!entry) throw new Error('SCRIPTA document was not found in this room.');
    return withDocumentAttachmentLock(
        context,
        entry.path,
        () => manageScriptaDocumentImpl(context, input)
    );
}

export async function ensureScriptaDocuments(context, input = {}) {
    const roomFolder = await ensureScriptaRoomFolder(context, input);
    const contextResult = await getScriptaContext(context, input);
    return {
        folderPath: roomFolder.folderPath,
        documents: contextResult.resources,
        activeResourceId: contextResult.activeResourceId,
    };
}

export async function getScriptaContext(context, {
    roomId,
    participantId = '',
    authInfo = null,
} = {}) {
    const record = await loadRoomRecord(context, roomId);
    if (!canViewMeetingRecord(record, authInfo)) throw new Error('Room not found.');
    const payload = decryptRoomPayload(context, record);
    const scripta = ensureScriptaPayload(record, payload);
    const participant = participantIdentity(payload, authInfo, participantId, record.meetingId);
    const entry = activeEntry(scripta, payload);
    if (entry) await refreshEntry(context, entry, scripta, participant);
    const projection = entry?.projection || null;
    const publicProjection = projection ? structuredClone(projection) : null;
    for (const variant of publicProjection?.paragraph?.variants || []) {
        delete variant._ownerHash;
    }
    return {
        activeResourceId: String(entry?.resourceId || ''),
        view: structuredClone(entryView(entry)),
        documentOutline: publicProjection?.chapters || [],
        paragraph: publicProjection?.paragraph || null,
        document: publicProjection,
        resources: Object.values(scripta.documents).map((item) => ({
            resourceId: item.resourceId,
            title: item.title,
        })),
    };
}

function collaborationSessionId(record, entry, participant, clientId = '') {
    return stableId(
        'scripta-session',
        record.meetingId,
        entry.resourceId,
        participant.id,
        String(clientId || 'default')
    );
}

function publicCollaborationResult(result, sessionId, resourceId) {
    const projection = result.projection ? structuredClone(result.projection) : null;
    for (const variant of projection?.paragraph?.variants || []) {
        delete variant._ownerHash;
    }
    return {
        ok: true,
        sessionId,
        resourceId,
        documentId: result.documentId,
        heads: Array.isArray(result.heads) ? result.heads : [],
        changesBase64: Array.isArray(result.changesBase64) ? result.changesBase64 : [],
        resetRequired: result.resetRequired === true,
        ...(typeof result.stateBase64 === 'string' ? { stateBase64: result.stateBase64 } : {}),
        ...(projection ? { projection } : {}),
    };
}

export async function openScriptaCollaboration(context, {
    roomId,
    resourceId = '',
    participantId = '',
    clientId = '',
    authInfo = null,
} = {}) {
    const record = await loadRoomRecord(context, roomId);
    if (!canViewMeetingRecord(record, authInfo)) throw new Error('Room not found.');
    const payload = decryptRoomPayload(context, record);
    const scripta = ensureScriptaPayload(record, payload);
    const participant = participantIdentity(payload, authInfo, participantId, record.meetingId);
    const entry = activeEntry(scripta, payload, resourceId);
    if (resourceId && !entry) throw new Error('SCRIPTA document is not active on its board.');
    if (!entry) throw new Error('No SCRIPTA document is active.');
    const view = entryView(entry);
    const sessionId = collaborationSessionId(record, entry, participant, clientId);
    const result = await scriptaExplorer.collaborationOpen(context, {
        path: entry.path,
        resourceId: entry.resourceId,
        viewerHash: participant.hash,
        view,
        participantMap: scripta.participants,
    });
    return publicCollaborationResult(result, sessionId, entry.resourceId);
}

export async function pullScriptaCollaboration(context, {
    roomId,
    resourceId = '',
    participantId = '',
    clientId = '',
    sessionId = '',
    knownHeads = [],
    authInfo = null,
} = {}) {
    const record = await loadRoomRecord(context, roomId);
    if (!canViewMeetingRecord(record, authInfo)) throw new Error('Room not found.');
    const payload = decryptRoomPayload(context, record);
    const scripta = ensureScriptaPayload(record, payload);
    const participant = participantIdentity(payload, authInfo, participantId, record.meetingId);
    const entry = activeEntry(scripta, payload, resourceId);
    if (resourceId && !entry) throw new Error('SCRIPTA document is not active on its board.');
    if (!entry) throw new Error('No SCRIPTA document is active.');
    const view = entryView(entry);
    const expectedSessionId = collaborationSessionId(record, entry, participant, clientId);
    if (sessionId !== expectedSessionId) throw new Error('SCRIPTA collaboration session is invalid.');
    const result = await scriptaExplorer.collaborationPull(context, {
        path: entry.path,
        resourceId: entry.resourceId,
        viewerHash: participant.hash,
        view,
        participantMap: scripta.participants,
        knownHeads,
    });
    return publicCollaborationResult(result, expectedSessionId, entry.resourceId);
}

export async function applyScriptaCollaboration(context, {
    roomId,
    resourceId = '',
    participantId = '',
    clientId = '',
    sessionId = '',
    operation,
    args = {},
    changesBase64 = [],
    baseHeads = [],
    authInfo = null,
} = {}) {
    let output;
    await mutateRoom(context, roomId, async (record, payload, stageEvent) => {
        if (!canViewMeetingRecord(record, authInfo)) throw new Error('Room not found.');
        const scripta = ensureScriptaPayload(record, payload);
        const participant = participantIdentity(payload, authInfo, participantId, record.meetingId);
        const entry = activeEntry(scripta, payload, resourceId);
        if (resourceId && !entry) throw new Error('SCRIPTA document is not active on its board.');
        if (!entry) throw new Error('No SCRIPTA document is active.');
        const view = entryView(entry);
        const expectedSessionId = collaborationSessionId(record, entry, participant, clientId);
        if (sessionId !== expectedSessionId) throw new Error('SCRIPTA collaboration session is invalid.');
        scripta.participants[participant.hash] = participant.viewId;
        if (operation === 'p-variant-edit') {
            view.editingVariantId = '';
            view.editorParticipantId = '';
            setEntryView(entry, view);
        }
        const result = await scriptaExplorer.collaborationApply(context, {
            path: entry.path,
            resourceId: entry.resourceId,
            operation,
            args,
            changesBase64,
            baseHeads,
            participant: {
                id: participant.id,
                hash: participant.hash,
                label: participant.label,
            },
            viewerHash: participant.hash,
            view,
            participantMap: scripta.participants,
        });
        updateEntryFromCrdt(entry, result);
        const blackboard = updateBlackboardProjection(record, payload, { resourceId: entry.resourceId });
        stageEvents(stageEvent, record, entry, participant, operation, blackboard);
        output = {
            ...publicCollaborationResult(result, expectedSessionId, entry.resourceId),
            blackboard: serializeBlackboard(blackboard, participant, authInfo),
        };
    });
    return output;
}

export async function closeScriptaCollaboration(context, input = {}) {
    const record = await loadRoomRecord(context, input.roomId);
    if (!canViewMeetingRecord(record, input.authInfo)) throw new Error('Room not found.');
    const payload = decryptRoomPayload(context, record);
    const scripta = ensureScriptaPayload(record, payload);
    const participant = participantIdentity(payload, input.authInfo, input.participantId, record.meetingId);
    const entry = activeEntry(scripta, payload, input.resourceId);
    if (input.resourceId && !entry) throw new Error('SCRIPTA document is not active on its board.');
    if (!entry) throw new Error('No SCRIPTA document is active.');
    const expectedSessionId = collaborationSessionId(record, entry, participant, input.clientId);
    if (input.sessionId && input.sessionId !== expectedSessionId) {
        throw new Error('SCRIPTA collaboration session is invalid.');
    }
    return { ok: true, sessionId: expectedSessionId, closed: true };
}

export async function repairScriptaBlackboardProjection(context, {
    roomId,
    participantId = '',
    authInfo = null,
} = {}) {
    let repaired = false;
    await mutateRoom(context, roomId, async (record, payload) => {
        if (!canViewMeetingRecord(record, authInfo)) throw new Error('Room not found.');
        const scripta = ensureScriptaPayload(record, payload);
        const entry = activeEntry(scripta, payload);
        if (!entry || hasRenderableProjection(entry)) return;
        const participant = participantIdentity(payload, authInfo, participantId, record.meetingId);
        scripta.participants[participant.hash] = participant.viewId;
        try {
            await refreshEntry(context, entry, scripta, participant);
        } catch (error) {
            if (!isMissingScriptaDocument(error)) throw error;
            // A file removed outside WebMeet cannot remain attached as a
            // non-functional widget.  Drop only the stale room reference; the
            // missing workspace file is not recreated implicitly.
            replaceActiveDocument(scripta, payload, null, { removeResourceId: entry.resourceId });
        }
        updateBlackboardProjection(record, payload);
        repaired = true;
    });
    return repaired;
}

export async function focusScripta(context, {
    roomId,
    resourceId = '',
    chapterId = '',
    paragraphId = '',
    variantId = '',
    editing,
    direction = '',
    mode = 'paragraph',
    participantId = '',
    authInfo = null,
} = {}) {
    let output;
    await mutateRoom(context, roomId, async (record, payload, stageEvent) => {
        if (!canViewMeetingRecord(record, authInfo)) throw new Error('Room not found.');
        const participant = participantIdentity(payload, authInfo, participantId, record.meetingId);
        const scripta = ensureScriptaPayload(record, payload);
        const entry = activeEntry(scripta, payload, resourceId);
        if (resourceId && !entry) throw new Error('SCRIPTA document is not active on its board.');
        if (!entry) throw new Error('No SCRIPTA document is active.');
        const view = entryView(entry);
        let projection = hasRenderableProjection(entry) ? entry.projection : null;
        if (!projection && (direction === 'next' || direction === 'previous')) {
            projection = (await refreshEntry(context, entry, scripta, participant)).projection;
        }
        let requestedChapterId = String(chapterId || view.chapterId);
        let requestedParagraphId = String(paragraphId || view.paragraphId);
        if (direction === 'next' || direction === 'previous') {
            const paragraphs = (projection?.chapters || []).flatMap((item) => (
                item.paragraphs.map((paragraphItem) => ({
                    chapterId: item.chapterId,
                    paragraphId: paragraphItem.paragraphId,
                }))
            ));
            const currentIndex = paragraphs.findIndex((item) => item.paragraphId === view.paragraphId);
            const targetIndex = Math.max(
                0,
                Math.min(paragraphs.length - 1, currentIndex + (direction === 'previous' ? -1 : 1)),
            );
            const target = paragraphs[targetIndex];
            if (!target) throw new Error('No SCRIPTA paragraph is available.');
            requestedChapterId = target.chapterId;
            requestedParagraphId = target.paragraphId;
        }
        let chapter = projection?.chapters.find((item) => item.chapterId === requestedChapterId);
        let paragraph = chapter?.paragraphs.find((item) => item.paragraphId === requestedParagraphId);
        if (!chapter || !paragraph) {
            projection = (await refreshEntry(context, entry, scripta, participant)).projection;
            chapter = projection.chapters.find((item) => item.chapterId === requestedChapterId);
            paragraph = chapter?.paragraphs.find((item) => item.paragraphId === requestedParagraphId);
        }
        if (!chapter || !paragraph) throw new Error('SCRIPTA paragraph was not found.');
        const projectedParagraph = entry.projection?.paragraph?.paragraphId === paragraph.paragraphId
            ? entry.projection.paragraph
            : null;
        const requestedVariantId = String(variantId || (
            view.paragraphId === paragraph.paragraphId
                ? view.selectedVariantId
                : ''
        ) || projectedParagraph?.activeVariantId || '');
        if (
            requestedVariantId
            && projectedParagraph
            && !(projectedParagraph.variants || []).some((item) => item.id === requestedVariantId)
        ) {
            throw new Error('SCRIPTA variant was not found.');
        }
        const requestedVariant = projectedParagraph?.variants?.find(
            (item) => item.id === requestedVariantId
        ) || null;
        if (editing === true) {
            if (!requestedVariantId || !requestedVariant) {
                throw new Error('SCRIPTA variant was not found.');
            }
            if (String(requestedVariant._ownerHash || '') !== participant.hash) {
                const error = new Error('Only the participant who added this variant may edit it.');
                error.code = 'scripta_variant_forbidden';
                throw error;
            }
        }
        const keepExistingEditor = (
            editing === undefined
            && view.paragraphId === paragraph.paragraphId
            && view.selectedVariantId === requestedVariantId
            && view.editingVariantId === requestedVariantId
        );
        const paragraphView = {
            mode: mode === 'document' ? 'document' : 'paragraph',
            chapterId: chapter.chapterId,
            paragraphId: paragraph.paragraphId,
            selectedVariantId: requestedVariantId,
            editingVariantId: editing === true
                ? requestedVariantId
                : keepExistingEditor
                    ? view.editingVariantId
                    : '',
            editorParticipantId: editing === true
                ? participant.viewId
                : keepExistingEditor
                    ? view.editorParticipantId
                    : '',
            focusTargetType: view.focusTargetType || 'paragraph',
            autoFocusRevision: Number(view.autoFocusRevision || 0),
        };
        setEntryView(entry, paragraphView);
        scripta.participants[participant.hash] = participant.viewId;
        const projectedParagraphId = String(entry.projection?.paragraph?.paragraphId || '');
        if (paragraphView.mode === 'paragraph' && projectedParagraphId !== paragraphView.paragraphId) {
            await refreshEntry(context, entry, scripta, participant, paragraphView);
        } else {
            // Document mode only changes presentation state. Opening the
            // paragraph already carried by the stored projection is equally
            // local; neither case needs another Explorer/CRDT read.
            projectStoredView(entry, paragraphView);
        }
        const blackboard = updateBlackboardProjection(record, payload, { resourceId: entry.resourceId });
        stageEvents(stageEvent, record, entry, participant, 'focus', blackboard);
        output = {
            ok: true,
            focus: structuredClone(paragraphView),
            blackboard: serializeBlackboard(blackboard, participant, authInfo),
        };
    });
    return output;
}

export async function navigateScripta(context, {
    roomId,
    direction = 'next',
    participantId = '',
    authInfo = null,
} = {}) {
    return focusScripta(context, {
        roomId,
        direction,
        mode: 'paragraph',
        participantId,
        authInfo,
    });
}

export async function mutateScripta(context, {
    roomId,
    operation,
    resourceId = '',
    chapterId = '',
    paragraphId = '',
    participantId = '',
    command = '',
    authInfo = null,
    ...args
} = {}) {
    let output;
    await mutateRoom(context, roomId, async (record, payload, stageEvent) => {
        if (!canViewMeetingRecord(record, authInfo)) throw new Error('Room not found.');
        const participant = participantIdentity(payload, authInfo, participantId, record.meetingId);
        const scripta = ensureScriptaPayload(record, payload);
        scripta.participants[participant.hash] = participant.viewId;
        const entry = activeEntry(scripta, payload, resourceId);
        if (resourceId && !entry) throw new Error('SCRIPTA document is not active on its board.');
        if (!entry) throw new Error('No SCRIPTA document is active.');
        let view = entryView(entry);
        const explorerMutationArgs = projectExplorerMutationArguments(operation, {
            ...args,
            chapterId: chapterId || view.chapterId,
            paragraphId: paragraphId || view.paragraphId,
            ...(
                ['p-variant-image-insert', 'p-variant-image-replace'].includes(operation)
                || (operation === 'paragraph-add' && args.assetId)
                    ? { roomId, roomFolderPath: scripta.folderPath }
                    : {}
            ),
            ...(['p-variant-image-insert', 'p-variant-image-replace', 'p-variant-image-delete', 'p-variant-image-layout'].includes(operation)
                ? resolveVariantSelector(args, view.selectedVariantId)
                : {}),
        });
        const result = await scriptaExplorer.mutate(context, {
            path: entry.path,
            resourceId: entry.resourceId,
            operation,
            args: explorerMutationArgs,
            participant: {
                id: participant.id,
                hash: participant.hash,
                label: participant.label,
            },
            viewerHash: participant.hash,
            view,
            participantMap: scripta.participants,
        });
        updateEntryFromCrdt(entry, result);
        if (result.focusTarget) {
            view = {
                mode: 'document',
                chapterId: result.focusTarget.chapterId,
                paragraphId: result.focusTarget.paragraphId,
                focusTargetType: result.focusTarget.type,
                autoFocusRevision: entry.revision,
            };
            setEntryView(entry, view);
            // Explorer projects structural mutations directly onto the newly
            // created element. Reopening the same CRDT document here would
            // duplicate the persistence round-trip.
        }
        scripta.audit.push({
            participantId: participant.id,
            command: String(command || '').slice(0, 500),
            operation,
            resourceId: entry.resourceId,
            timestamp: nowIso(),
        });
        scripta.audit = scripta.audit.slice(-MAX_AUDIT_ENTRIES);
        const blackboard = updateBlackboardProjection(record, payload, { resourceId: entry.resourceId });
        stageEvents(stageEvent, record, entry, participant, operation, blackboard);
        output = {
            ok: true,
            operation,
            focus: structuredClone(view),
            blackboard: serializeBlackboard(blackboard, participant, authInfo),
        };
    });
    return output;
}

export async function getScriptaDocumentSnapshot(context, {
    roomId,
    resourceId,
    participantId = '',
    authInfo = null,
} = {}) {
    const record = await loadRoomRecord(context, roomId);
    if (!canViewMeetingRecord(record, authInfo)) throw new Error('Room not found.');
    const payload = decryptRoomPayload(context, record);
    const participant = participantIdentity(payload, authInfo, participantId, record.meetingId);
    const scripta = ensureScriptaPayload(record, payload);
    const entry = scripta.documents?.[String(resourceId || '')];
    if (!entry) throw new Error('SCRIPTA document was not found.');
    const result = await scriptaExplorer.collaborationOpen(context, {
        path: entry.path,
        resourceId: entry.resourceId,
        viewerHash: participant.hash,
        view: entryView(entry),
        participantMap: scripta.participants,
    });
    return {
        resourceId: entry.resourceId,
        documentId: result.documentId,
        heads: Array.isArray(result.heads) ? result.heads : [],
        stateBase64: String(result.stateBase64 || ''),
        markdown: String(result.markdown || ''),
    };
}

export async function mergeScriptaDocumentMarkdown(context, {
    roomId,
    resourceId,
    markdown,
    baseStateBase64 = '',
    participantId = '',
    command = '',
    authInfo = null,
} = {}) {
    const source = String(markdown || '');
    if (!source.trim()) throw new Error('SCRIPTA Markdown merge cannot be empty.');
    let output;
    await mutateRoom(context, roomId, async (record, payload, stageEvent) => {
        if (!canViewMeetingRecord(record, authInfo)) throw new Error('Room not found.');
        const participant = participantIdentity(payload, authInfo, participantId, record.meetingId);
        const scripta = ensureScriptaPayload(record, payload);
        scripta.participants[participant.hash] = participant.viewId;
        const entry = scripta.documents?.[String(resourceId || '')];
        if (!entry) throw new Error('SCRIPTA document was not found.');

        const result = await scriptaExplorer.collaborationMergeMarkdown(context, {
            path: entry.path,
            resourceId: entry.resourceId,
            markdown: source,
            ...(baseStateBase64 ? { baseStateBase64 } : {}),
            participant,
            viewerHash: participant.hash,
            view: entryView(entry),
            participantMap: scripta.participants,
        });
        updateEntryFromCrdt(entry, result);
        scripta.audit.push({
            participantId: participant.id,
            command: String(command || '').slice(0, 500),
            operation: 'markdown-collaboration-merged',
            resourceId: entry.resourceId,
            timestamp: nowIso(),
        });
        scripta.audit = scripta.audit.slice(-MAX_AUDIT_ENTRIES);
        const blackboard = updateBlackboardProjection(record, payload, { resourceId: entry.resourceId });
        stageEvents(stageEvent, record, entry, participant, 'markdown-collaboration-merged', blackboard);
        output = {
            ok: true,
            resourceId: entry.resourceId,
            markdown: String(result.markdown || source),
            documentSnapshot: {
                documentId: String(result.documentId || entry.documentId || ''),
                heads: Array.isArray(result.heads) ? result.heads : [],
                stateBase64: String(result.stateBase64 || ''),
                markdown: String(result.markdown || source),
            },
            blackboard: serializeBlackboard(blackboard, participant, authInfo),
        };
    });
    return output;
}
