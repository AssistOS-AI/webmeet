import crypto from 'node:crypto';

import { WEBMEET_EVENT_TYPES } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';
import { Blackboard } from '../blackboard/model.mjs';
import {
    ROBO_TEAM_BLACKBOARD_BOARD_ID,
    ROBO_TEAM_PARTICIPANT_ID,
    ensureRoboTeamAgentPayload,
    ensureRoboTeamBlackboardPayload,
} from '../roboTeam/service.mjs';
import {
    canViewMeetingRecord,
    isGuestAuthInfo,
    normalizeAuthInfo,
} from '../store/accessPolicy.mjs';
import { authorizeRoomParticipantId } from '../store/participantAuthorization.mjs';
import { withQueuedRoomLock } from '../store/roomLocks.mjs';
import { decryptRoomPayload, listRoomRecords, loadRoomRecord, mutateRoom } from '../store/roomRecords.mjs';
import { scriptaExplorer } from './explorer-crdt-client.mjs';
import { scriptaOwnerHash } from './identity.mjs';

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
    'chapter-add',
    'chapter-delete',
    'chapter-rename',
    'chapter-move',
    'paragraph-add',
    'paragraph-delete',
    'paragraph-move',
    'undo',
]);

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
    const viewId = authorizeRoomParticipantId(payload, authInfo, participantId, roomId);
    const source = String(auth.id || auth.principalId || viewId).trim();
    if (!source) throw new Error('SCRIPTA requires an admitted participant identity.');
    return {
        id: source,
        viewId,
        hash: scriptaOwnerHash(source),
        label: String(auth.name || auth.username || auth.email || source).trim() || source,
    };
}

function roomFolderPath(record) {
    const roomId = String(record.meetingId || record.roomId || '').trim();
    const shortId = roomId.replace(/^room_/, '').slice(0, 8) || stableId('room', roomId).slice(-8);
    return `/WebMeet/${slugify(record.name || record.title || 'room')}-${shortId}`;
}

function ensureScriptaPayload(record, payload) {
    payload.scripta = payload.scripta && typeof payload.scripta === 'object' ? payload.scripta : {};
    const scripta = payload.scripta;
    scripta.folderPath ||= roomFolderPath(record);
    scripta.documents = scripta.documents && typeof scripta.documents === 'object' ? scripta.documents : {};
    scripta.activeResourceId = String(scripta.activeResourceId || '');
    scripta.view = scripta.view && typeof scripta.view === 'object'
        ? scripta.view
        : { mode: 'document', chapterId: '', paragraphId: '' };
    scripta.view.mode = scripta.view.mode === 'paragraph' ? 'paragraph' : 'document';
    scripta.view.selectedVariantId = String(scripta.view.selectedVariantId || '');
    scripta.view.editingVariantId = String(scripta.view.editingVariantId || '');
    scripta.view.editorParticipantId = String(scripta.view.editorParticipantId || '');
    scripta.view.focusTargetType = scripta.view.focusTargetType === 'chapter' ? 'chapter' : 'paragraph';
    scripta.view.autoFocusRevision = Math.max(0, Number(scripta.view.autoFocusRevision || 0));
    scripta.audit = Array.isArray(scripta.audit) ? scripta.audit : [];
    scripta.participants = scripta.participants && typeof scripta.participants === 'object' ? scripta.participants : {};
    delete scripta.undo;
    payload.resources = Array.isArray(payload.resources) ? payload.resources : [];
    return scripta;
}

function activeEntry(scripta) {
    return scripta.documents?.[scripta.activeResourceId] || null;
}

function replaceActiveDocument(scripta, payload, entry = null) {
    scripta.documents = entry ? { [entry.resourceId]: entry } : {};
    scripta.activeResourceId = entry?.resourceId || '';
    payload.resources = payload.resources.filter((resource) => resource.kind !== 'scripta-document');
    if (entry) {
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

async function refreshEntry(context, entry, scripta, participant, view = scripta.view) {
    const result = await scriptaExplorer.open(context, {
        path: entry.path,
        resourceId: entry.resourceId,
        viewerHash: participant.hash,
        view,
        participantMap: scripta.participants,
    });
    return updateEntryFromCrdt(entry, result);
}

function updateBlackboardProjection(record, payload) {
    const scripta = ensureScriptaPayload(record, payload);
    const entry = activeEntry(scripta);
    const agent = ensureRoboTeamAgentPayload(payload, null, record.meetingId);
    const blackboard = Blackboard.from({ ...ensureRoboTeamBlackboardPayload(agent, record.meetingId), roomId: record.meetingId });
    if (!entry) {
        blackboard.removeWidget(SCRIPTA_DOCUMENT_WIDGET_ID, {
            participantId: ROBO_TEAM_PARTICIPANT_ID,
            canModerateBlackboard: true,
            record: false,
        });
        agent.blackboard = blackboard.serializePrivileged();
        return blackboard;
    }
    const existing = blackboard.getWidget(SCRIPTA_DOCUMENT_WIDGET_ID);
    const geometry = existing?.properties?.geometry
        ? { ...existing.properties.geometry }
        : { x: 24, y: 24, width: 600, height: 400 };
    const properties = {
        documents: Object.values(scripta.documents).map((item) => ({
            resourceId: item.resourceId,
            title: item.title,
            active: item.resourceId === scripta.activeResourceId,
        })),
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
        existing.version += 1;
    } else {
        blackboard.applyFinalChange({ changeType: 'create', targetType: 'widget', widget }, {
            participantId: ROBO_TEAM_PARTICIPANT_ID,
            canModerateBlackboard: true,
            canManagePoll: true,
        });
    }
    blackboard.version += 1;
    agent.blackboard = blackboard.serializePrivileged();
    return blackboard;
}

function assertProjectionVersion(payload, roomId, expectedBoardVersion) {
    if (expectedBoardVersion === null || expectedBoardVersion === undefined || expectedBoardVersion === '') return;
    const blackboard = Blackboard.from(ensureRoboTeamBlackboardPayload(
        ensureRoboTeamAgentPayload(payload, null, roomId),
        roomId,
    ));
    const expected = Number(expectedBoardVersion);
    if (!Number.isInteger(expected) || expected < 0) throw new Error('expectedBoardVersion must be a non-negative integer.');
    if (blackboard.version !== expected) {
        const error = new Error(`Blackboard version conflict: expected ${expected}, current ${blackboard.version}.`);
        error.code = 'version_conflict';
        error.currentBoardVersion = blackboard.version;
        throw error;
    }
}

function stageEvents(stageEvent, record, entry, participant, operation, blackboardVersion) {
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
        boardId: ROBO_TEAM_BLACKBOARD_BOARD_ID,
        blackboardVersion,
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
        const active = payload.scripta?.documents?.[String(payload.scripta?.activeResourceId || '')];
        if (String(active?.path || '') === pathValue) {
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
    participantId = '',
    authInfo = null,
    expectedBoardVersion = null,
} = {}) {
    const safeName = slugify(String(name || '').replace(/\.md$/i, ''));
    if (!safeName) throw new Error('SCRIPTA document name is required.');
    let output;
    let createdDocument = null;
    try {
        await mutateRoom(context, roomId, async (record, payload, stageEvent) => {
            if (!canViewMeetingRecord(record, authInfo)) throw new Error('Room not found.');
            const participant = participantIdentity(payload, authInfo, participantId, record.meetingId);
            assertProjectionVersion(payload, record.meetingId, expectedBoardVersion);
            const scripta = ensureScriptaPayload(record, payload);
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
            }, result);
            replaceActiveDocument(scripta, payload, entry);
            scripta.view = view;
            projectStoredView(entry, view);
            const blackboard = updateBlackboardProjection(record, payload);
            stageEvents(stageEvent, record, entry, participant, 'document-create', blackboard.version);
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
    participantId = '',
    authInfo = null,
    expectedBoardVersion = null,
} = {}) {
    let output;
    await mutateRoom(context, roomId, async (record, payload, stageEvent) => {
        if (!canViewMeetingRecord(record, authInfo)) throw new Error('Room not found.');
        const participant = participantIdentity(payload, authInfo, participantId, record.meetingId);
        assertProjectionVersion(payload, record.meetingId, expectedBoardVersion);
        const scripta = ensureScriptaPayload(record, payload);
        const resolvedDocumentPath = isGuestAuthInfo(authInfo)
            ? await resolveGuestDocumentPath(context, scripta, documentPath)
            : String(documentPath || '').trim();
        await assertDocumentAvailable(context, roomId, resolvedDocumentPath);
        const resourceId = stableId('resource', record.meetingId, resolvedDocumentPath);
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
        }, result);
        replaceActiveDocument(scripta, payload, entry);
        scripta.view = view;
        projectStoredView(entry, view);
        const blackboard = updateBlackboardProjection(record, payload);
        stageEvents(stageEvent, record, entry, participant, 'document-open', blackboard.version);
        output = { ok: true, resourceId, blackboard: serializeBlackboard(blackboard, participant, authInfo) };
    });
    return output;
}

export async function openScriptaDocument(context, input = {}) {
    const record = await loadRoomRecord(context, input.roomId);
    if (!canViewMeetingRecord(record, input.authInfo)) throw new Error('Room not found.');
    const payload = decryptRoomPayload(context, record);
    const scripta = ensureScriptaPayload(record, payload);
    const requestedPath = isGuestAuthInfo(input.authInfo)
        ? `${scripta.folderPath.replace(/\/$/, '')}/${slugify(documentFileName(input.path).replace(/\.md$/i, ''))}.md`
        : String(input.path || '').trim();
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
    expectedBoardVersion = null,
} = {}) {
    if (operation !== 'document-delete') throw new Error(`Unsupported SCRIPTA document operation "${operation}".`);
    if (confirmed !== true) throw new Error('Physical document deletion requires explicit confirmation.');
    const record = await loadRoomRecord(context, roomId);
    if (!canViewMeetingRecord(record, authInfo)) throw new Error('Room not found.');
    const currentPayload = decryptRoomPayload(context, record);
    const participant = participantIdentity(currentPayload, authInfo, participantId, record.meetingId);
    assertProjectionVersion(currentPayload, record.meetingId, expectedBoardVersion);
    const currentScripta = ensureScriptaPayload(record, currentPayload);
    const id = String(resourceId || currentScripta.activeResourceId);
    const currentEntry = currentScripta.documents[id];
    if (!currentEntry) throw new Error('SCRIPTA document was not found in this room.');

    const originalEntry = structuredClone(currentEntry);
    const originalView = structuredClone(currentScripta.view);
    const prepared = await scriptaExplorer.delete(context, {
        phase: 'prepare',
        documentId: currentEntry.documentId,
        path: currentEntry.path,
    });

    let output;
    try {
        await mutateRoom(context, roomId, async (freshRecord, payload, stageEvent) => {
            if (!canViewMeetingRecord(freshRecord, authInfo)) throw new Error('Room not found.');
            assertProjectionVersion(payload, freshRecord.meetingId, expectedBoardVersion);
            const scripta = ensureScriptaPayload(freshRecord, payload);
            const entry = scripta.documents[id];
            if (!entry) throw new Error('SCRIPTA document was not found in this room.');
            replaceActiveDocument(scripta, payload, null);
            scripta.view = { mode: 'document', chapterId: '', paragraphId: '' };
            const blackboard = updateBlackboardProjection(freshRecord, payload);
            stageEvents(stageEvent, freshRecord, originalEntry, participant, operation, blackboard.version);
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
            scripta.view = originalView;
            updateBlackboardProjection(freshRecord, payload);
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
    const id = String(input.resourceId || scripta.activeResourceId);
    const entry = scripta.documents[id];
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
    const entry = activeEntry(scripta);
    if (entry) await refreshEntry(context, entry, scripta, participant);
    const projection = entry?.projection || null;
    const publicProjection = projection ? structuredClone(projection) : null;
    for (const variant of publicProjection?.paragraph?.variants || []) {
        delete variant._ownerHash;
    }
    return {
        activeResourceId: scripta.activeResourceId,
        view: structuredClone(scripta.view),
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
    if (resourceId && resourceId !== scripta.activeResourceId) throw new Error('SCRIPTA document is not active in this room.');
    const entry = activeEntry(scripta);
    if (!entry) throw new Error('No SCRIPTA document is active.');
    const sessionId = collaborationSessionId(record, entry, participant, clientId);
    const result = await scriptaExplorer.collaborationOpen(context, {
        path: entry.path,
        resourceId: entry.resourceId,
        viewerHash: participant.hash,
        view: scripta.view,
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
    if (resourceId && resourceId !== scripta.activeResourceId) throw new Error('SCRIPTA document is not active in this room.');
    const entry = activeEntry(scripta);
    if (!entry) throw new Error('No SCRIPTA document is active.');
    const expectedSessionId = collaborationSessionId(record, entry, participant, clientId);
    if (sessionId !== expectedSessionId) throw new Error('SCRIPTA collaboration session is invalid.');
    const result = await scriptaExplorer.collaborationPull(context, {
        path: entry.path,
        resourceId: entry.resourceId,
        viewerHash: participant.hash,
        view: scripta.view,
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
        if (resourceId && resourceId !== scripta.activeResourceId) throw new Error('SCRIPTA document is not active in this room.');
        const entry = activeEntry(scripta);
        if (!entry) throw new Error('No SCRIPTA document is active.');
        const expectedSessionId = collaborationSessionId(record, entry, participant, clientId);
        if (sessionId !== expectedSessionId) throw new Error('SCRIPTA collaboration session is invalid.');
        scripta.participants[participant.hash] = participant.viewId;
        if (operation === 'p-variant-edit') {
            scripta.view.editingVariantId = '';
            scripta.view.editorParticipantId = '';
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
            view: scripta.view,
            participantMap: scripta.participants,
        });
        updateEntryFromCrdt(entry, result);
        const blackboard = updateBlackboardProjection(record, payload);
        stageEvents(stageEvent, record, entry, participant, operation, blackboard.version);
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
    if (input.resourceId && input.resourceId !== scripta.activeResourceId) {
        throw new Error('SCRIPTA document is not active in this room.');
    }
    const entry = activeEntry(scripta);
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
        const entry = activeEntry(scripta);
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
            replaceActiveDocument(scripta, payload, null);
            scripta.view = { mode: 'document', chapterId: '', paragraphId: '' };
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
    expectedBoardVersion = null,
} = {}) {
    let output;
    await mutateRoom(context, roomId, async (record, payload, stageEvent) => {
        if (!canViewMeetingRecord(record, authInfo)) throw new Error('Room not found.');
        const participant = participantIdentity(payload, authInfo, participantId, record.meetingId);
        assertProjectionVersion(payload, record.meetingId, expectedBoardVersion);
        const scripta = ensureScriptaPayload(record, payload);
        if (resourceId && resourceId !== scripta.activeResourceId) throw new Error('SCRIPTA document is not active in this room.');
        const entry = activeEntry(scripta);
        if (!entry) throw new Error('No SCRIPTA document is active.');
        let projection = hasRenderableProjection(entry) ? entry.projection : null;
        if (!projection && (direction === 'next' || direction === 'previous')) {
            projection = (await refreshEntry(context, entry, scripta, participant)).projection;
        }
        let requestedChapterId = String(chapterId || scripta.view.chapterId);
        let requestedParagraphId = String(paragraphId || scripta.view.paragraphId);
        if (direction === 'next' || direction === 'previous') {
            const paragraphs = (projection?.chapters || []).flatMap((item) => (
                item.paragraphs.map((paragraphItem) => ({
                    chapterId: item.chapterId,
                    paragraphId: paragraphItem.paragraphId,
                }))
            ));
            const currentIndex = paragraphs.findIndex((item) => item.paragraphId === scripta.view.paragraphId);
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
            scripta.view.paragraphId === paragraph.paragraphId
                ? scripta.view.selectedVariantId
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
            && scripta.view.paragraphId === paragraph.paragraphId
            && scripta.view.selectedVariantId === requestedVariantId
            && scripta.view.editingVariantId === requestedVariantId
        );
        const paragraphView = {
            mode: mode === 'document' ? 'document' : 'paragraph',
            chapterId: chapter.chapterId,
            paragraphId: paragraph.paragraphId,
            selectedVariantId: requestedVariantId,
            editingVariantId: editing === true
                ? requestedVariantId
                : keepExistingEditor
                    ? scripta.view.editingVariantId
                    : '',
            editorParticipantId: editing === true
                ? participant.viewId
                : keepExistingEditor
                    ? scripta.view.editorParticipantId
                    : '',
            focusTargetType: scripta.view.focusTargetType || 'paragraph',
            autoFocusRevision: Number(scripta.view.autoFocusRevision || 0),
        };
        scripta.view = paragraphView;
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
        const blackboard = updateBlackboardProjection(record, payload);
        stageEvents(stageEvent, record, entry, participant, 'focus', blackboard.version);
        output = {
            ok: true,
            focus: structuredClone(scripta.view),
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
    expectedBoardVersion = null,
} = {}) {
    return focusScripta(context, {
        roomId,
        direction,
        mode: 'paragraph',
        participantId,
        authInfo,
        expectedBoardVersion,
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
    expectedBoardVersion = null,
    ...args
} = {}) {
    let output;
    await mutateRoom(context, roomId, async (record, payload, stageEvent) => {
        if (!canViewMeetingRecord(record, authInfo)) throw new Error('Room not found.');
        const participant = participantIdentity(payload, authInfo, participantId, record.meetingId);
        assertProjectionVersion(payload, record.meetingId, expectedBoardVersion);
        const scripta = ensureScriptaPayload(record, payload);
        scripta.participants[participant.hash] = participant.viewId;
        if (resourceId && resourceId !== scripta.activeResourceId) throw new Error('SCRIPTA document is not active in this room.');
        const entry = activeEntry(scripta);
        if (!entry) throw new Error('No SCRIPTA document is active.');
        const result = await scriptaExplorer.mutate(context, {
            path: entry.path,
            resourceId: entry.resourceId,
            operation,
            args: {
                ...args,
                chapterId: chapterId || scripta.view.chapterId,
                paragraphId: paragraphId || scripta.view.paragraphId,
            },
            participant: {
                id: participant.id,
                hash: participant.hash,
                label: participant.label,
            },
            viewerHash: participant.hash,
            view: scripta.view,
            participantMap: scripta.participants,
        });
        updateEntryFromCrdt(entry, result);
        if (result.focusTarget) {
            scripta.view = {
                mode: 'document',
                chapterId: result.focusTarget.chapterId,
                paragraphId: result.focusTarget.paragraphId,
                focusTargetType: result.focusTarget.type,
                autoFocusRevision: entry.revision,
            };
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
        const blackboard = updateBlackboardProjection(record, payload);
        stageEvents(stageEvent, record, entry, participant, operation, blackboard.version);
        output = {
            ok: true,
            operation,
            focus: structuredClone(scripta.view),
            blackboard: serializeBlackboard(blackboard, participant, authInfo),
        };
    });
    return output;
}
