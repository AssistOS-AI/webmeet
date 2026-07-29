import { WEBMEET_EVENT_TYPES, parseWebMeetEvent } from '../webmeet-events.js';
import {
    encodeBlackboardProtocolMessage,
    parseBlackboardProtocolMessage
} from './blackboard-protocol.js';
import { ScriptaCrdtReplica } from './scripta-crdt-replica.js';

const SCRIPTA_DOCUMENT_MUTATION_ACTIONS = new Set([
    'scripta-p-variant-add',
    'scripta-p-variant-vote',
    'scripta-p-variant-vote-withdraw',
    'scripta-p-variant-reformulate',
    'scripta-p-variant-edit',
    'scripta-p-variant-delete',
    'scripta-p-variant-image-insert',
    'scripta-p-variant-image-replace',
    'scripta-p-variant-image-delete',
    'scripta-p-variant-image-layout',
    'scripta-undo',
    'scripta-chapter-add',
    'scripta-chapter-edit',
    'scripta-chapter-delete',
    'scripta-chapter-move',
    'scripta-paragraph-add',
    'scripta-paragraph-delete',
    'scripta-paragraph-move'
]);

function containsViewerScopedScriptaProjection(object) {
    if (!object || typeof object !== 'object') return false;
    if (object.type === 'scripta-document') return true;
    return Array.isArray(object.widgets)
        && object.widgets.some((widget) => widget?.type === 'scripta-document');
}

export class BlackboardNetworkAdapter {
    constructor({
        roomId,
        boardId = '',
        participantId = '',
        participantName = '',
        runTool,
        onAuditMessage = null,
        publishRealtimePayload = null,
        room = null
    } = {}) {
        this.roomId = String(roomId || '').trim();
        this.boardId = String(boardId || '').trim();
        this.participantId = String(participantId || '').trim();
        this.participantName = String(participantName || '').trim();
        this.runTool = runTool;
        this.onAuditMessage = onAuditMessage;
        this.publishRealtimePayload = publishRealtimePayload;
        this.room = room;
        this.handlers = new Set();
        this.seenMessageIds = new Set();
        this.locallyAppliedScriptaRevisions = new Set();
        this.currentRevision = 0;
        this.workspace = null;
        this.workspaceRevision = 0;
        this.unsubscribeRoom = null;
        this.scriptaReplica = new ScriptaCrdtReplica(this);
    }

    async loadInitialBlackboard(roomId = this.roomId, boardId = '') {
        const response = await this.runTool(String(boardId || '').trim() ? 'webmeet_blackboard_get' : 'webmeet_blackboard_workspace_get', {
            roomId,
            ...(String(boardId || '').trim() ? { boardId: String(boardId).trim() } : {}),
            participantId: this.participantId
        });
        this.applyWorkspaceProjection(response?.workspace, { emit: false });
        this.boardId = String(response?.blackboard?.boardId || response?.workspace?.activeBoardId || this.boardId).trim();
        const revision = Number(response?.blackboard?.revision || 0);
        this.currentRevision = revision;
        return response?.blackboard || { roomId, revision: 0, widgets: [] };
    }

    applyWorkspaceProjection(workspace, { emit = true, reason = 'workspace-update' } = {}) {
        if (!workspace || typeof workspace !== 'object') return false;
        const revision = Number(workspace.revision || 0);
        if (!Number.isSafeInteger(revision) || revision < this.workspaceRevision) return false;
        this.workspaceRevision = revision;
        this.workspace = workspace;
        this.boardId = String(workspace.activeBoardId || this.boardId).trim();
        if (emit) this.emit({ kind: 'workspace', object: workspace, revision, reason });
        return true;
    }

    async loadBoard(boardId, { activate = false } = {}) {
        const targetBoardId = String(boardId || '').trim();
        if (!targetBoardId) throw new Error('Missing Blackboard workspace zone id.');
        if (activate && targetBoardId !== this.boardId) {
            return this.sendWorkspaceAction('board-activate', { boardId: targetBoardId });
        }
        const blackboard = await this.loadInitialBlackboard(this.roomId, targetBoardId);
        this.applyBlackboardProjection(blackboard, { reason: 'board-load' });
        return { workspace: this.workspace, blackboard };
    }

    async fetchBoardProjection(boardId) {
        const targetBoardId = String(boardId || '').trim();
        if (!targetBoardId) throw new Error('Missing Blackboard workspace zone id.');
        const response = await this.runTool('webmeet_blackboard_get', {
            roomId: this.roomId,
            boardId: targetBoardId,
            participantId: this.participantId,
        });
        return response?.blackboard || null;
    }

    async sendWorkspaceAction(action, input = {}) {
        const target = action === 'board-create' ? { type: 'workspace' } : { type: 'blackboard' };
        const sourceBoardId = String(input.boardId || this.boardId).trim();
        const payload = {};
        for (const key of ['title', 'targetIndex', 'targetBoardId', 'widgetIds', 'placement']) {
            if (input[key] !== undefined) payload[key] = input[key];
        }
        const response = await this.runEvent(this.createEvent({ target, action, payload }), sourceBoardId);
        await this.publishAudit(response);
        if (!response?.ok) throw new Error(response?.error?.message || 'Blackboard workspace action failed.');
        this.applyWorkspaceProjection(response.workspace, { reason: action });
        if (response.blackboard) {
            this.currentRevision = 0;
            this.applyBlackboardProjection(response.blackboard, { reason: action });
        }
        await this.publishFinalUpdate(response, action);
        return response;
    }

    applyBlackboardProjection(blackboard, { kind = 'blackboard', reason = 'update' } = {}) {
        if (!blackboard || typeof blackboard !== 'object') return false;
        const revision = Number(blackboard.revision);
        if (!Number.isSafeInteger(revision) || revision < 0 || revision < this.currentRevision) {
            return false;
        }
        this.currentRevision = Math.max(this.currentRevision, revision);
        this.emit({ kind, object: blackboard, revision, reason });
        return true;
    }

    async sendChange(change) {
        const targetType = String(change?.targetType || 'widget');
        const action = String(change?.changeType || 'update');
        if (action === 'add') throw new Error('Unsupported blackboard event action "add".');
        const target = action === 'create' || ['clear', 'group'].includes(action)
            ? { type: 'blackboard' }
            : {
                type: targetType,
                ...(change?.targetRef
                    ? targetType === 'group'
                        ? { groupId: String(change.targetRef) }
                        : { widgetId: String(change.targetRef) }
                    : {}),
            };
        let payload = {};
        if (action === 'create') {
            const inputWidget = JSON.parse(JSON.stringify(change.widget || change.object || {}));
            const widget = { type: inputWidget.type, properties: inputWidget.properties || {} };
            payload = { widget };
        } else if (action === 'update') payload = { patch: change.patch || {}, ...(change.reason ? { reason: change.reason } : {}) };
        else if (action === 'group') payload = { widgetIds: change.widgetIds || change.data?.widgetIds || [] };
        else if (action === 'submit') payload = { data: change.data || {} };
        const event = this.createEvent({
            target,
            action,
            payload,
        });
        const response = await this.runEvent(event);
        await this.publishAudit(response);
        if (!response?.ok) throw new Error(response?.error?.message || 'Blackboard event failed.');
        this.applyWorkspaceProjection(response?.workspace, { reason: action });
        const projectionApplied = this.applyBlackboardProjection(response?.blackboard, { reason: action });
        if (projectionApplied) await this.publishFinalUpdate(response, change?.changeType || 'update');
        return response;
    }

    async sendEvent(action, payload = {}, { widgetId = '', targetType = 'widget', projectionMode = 'render' } = {}) {
        const response = await this.runEvent(this.createEvent({
                target: { type: targetType, ...(widgetId ? { widgetId } : {}) },
                action,
                payload
            }));
        await this.publishAudit(response);
        if (!response?.ok) throw new Error(response?.error?.message || response?.message || 'Blackboard event failed.');
        this.applyWorkspaceProjection(response?.workspace, { reason: action });
        const projectionApplied = this.applyBlackboardProjection(response?.blackboard, {
            kind: projectionMode === 'state' ? 'blackboard-state' : 'blackboard',
            reason: action
        });
        const responseRevision = Number(response?.blackboard?.revision || 0);
        if (projectionApplied && SCRIPTA_DOCUMENT_MUTATION_ACTIONS.has(String(action || '')) && responseRevision > 0) {
            this.locallyAppliedScriptaRevisions.add(responseRevision);
            while (this.locallyAppliedScriptaRevisions.size > 64) {
                this.locallyAppliedScriptaRevisions.delete(this.locallyAppliedScriptaRevisions.values().next().value);
            }
        }
        if (projectionApplied) await this.publishFinalUpdate(response, action);
        if (SCRIPTA_DOCUMENT_MUTATION_ACTIONS.has(String(action || ''))) {
            // The command response is the authoritative projection and can be
            // rendered immediately. Keep the browser CRDT replica synchronized
            // in the background; edits wait for this queue before producing a
            // local Automerge change.
            void this.scriptaReplica.schedulePullAll();
        }
        return response;
    }

    async listScriptaWorkspaceEntries() {
        return this.runTool('webmeet_scripta_workspace_list', { roomId: this.roomId });
    }

    async commitMediaBlob(stagedBlob) {
        const response = await this.runTool('webmeet_media_commit', {
            roomId: this.roomId,
            participantId: this.participantId,
            blobRef: {
                id: stagedBlob?.id,
                agent: stagedBlob?.agent,
                localPath: stagedBlob?.localPath
            }
        });
        return response?.asset || response;
    }

    async mutateScriptaVariantImage(operation, {
        assetId = '', imageId = '', variantId = '', chapterId = '', paragraphId = '', alt, position,
        variantOrdinal, imageOrdinal, widthPercent, aspectRatio, fit, alignment
    } = {}) {
        if (!['insert', 'replace', 'delete', 'layout'].includes(operation)) {
            throw new Error(`Unsupported SCRIPTA image operation "${operation}".`);
        }
        const payload = {};
        for (const [key, value] of Object.entries({assetId, imageId, variantId, chapterId, paragraphId})) {
            if (String(value || '').trim()) payload[key] = value;
        }
        for (const [key, value] of Object.entries({variantOrdinal, imageOrdinal, position, widthPercent})) {
            if (value !== undefined && value !== null && value !== '') payload[key] = value;
        }
        if (alt !== undefined) payload.alt = alt;
        if (String(aspectRatio || '').trim()) payload.aspectRatio = aspectRatio;
        if (String(fit || '').trim()) payload.fit = fit;
        if (String(alignment || '').trim()) payload.alignment = alignment;
        return this.sendEvent(`scripta-p-variant-image-${operation}`, payload, {
            widgetId: 'robo_scripta_document',
            targetType: 'widget',
            projectionMode: operation === 'layout' ? 'state' : 'render',
        });
    }

    async addScriptaImageParagraph({chapterId = '', assetId = '', alt = 'Image'} = {}) {
        return this.sendEvent('scripta-paragraph-add', {
            chapterId,
            text: '',
            assetId,
            alt,
        }, {
            widgetId: 'robo_scripta_document',
            targetType: 'widget',
        });
    }

    async insertScriptaMedia(assetId, alt = 'Image') {
        return this.mutateScriptaVariantImage('insert', {assetId, alt});
    }

    createEvent({ target, action, payload }) {
        return { target, action, payload };
    }

    async runEvent(event, boardId = this.boardId) {
        return this.runTool('webmeet_event_command', {
            roomId: this.roomId,
            boardId: String(boardId || '').trim(),
            participantId: this.participantId,
            selectedWidgetId: event.target?.widgetId || '',
            source: 'ui',
            commandSource: 'chat',
            commandId: `command_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(16).slice(2)}`}`,
            event: JSON.stringify(event)
        });
    }

    async undo() {
        const response = await this.runEvent(this.createEvent({
            target: { type: 'blackboard' }, action: 'undo', payload: {}
        }));
        await this.publishAudit(response);
        if (!response?.ok) throw new Error(response?.error?.message || 'Blackboard undo failed.');
        this.applyWorkspaceProjection(response?.workspace, { reason: 'undo' });
        const projectionApplied = this.applyBlackboardProjection(response?.blackboard, { reason: 'undo' });
        if (response?.changed && projectionApplied) {
            await this.publishFinalUpdate(response, 'undo');
        }
        return response;
    }

    async redo() {
        const response = await this.runEvent(this.createEvent({
            target: { type: 'blackboard' }, action: 'redo', payload: {}
        }));
        await this.publishAudit(response);
        if (!response?.ok) throw new Error(response?.error?.message || 'Blackboard redo failed.');
        this.applyWorkspaceProjection(response?.workspace, { reason: 'redo' });
        const projectionApplied = this.applyBlackboardProjection(response?.blackboard, { reason: 'redo' });
        if (response?.changed && projectionApplied) {
            await this.publishFinalUpdate(response, 'redo');
        }
        return response;
    }

    subscribe(handler) {
        this.handlers.add(handler);
        return () => {
            this.handlers.delete(handler);
        };
    }

    unsubscribe() {
        this.handlers.clear();
        this.unsubscribeRoom?.();
        this.unsubscribeRoom = null;
        void this.scriptaReplica?.closeAll?.();
    }

    async openScriptaCollaboration(resourceId) {
        return this.scriptaReplica.open(resourceId);
    }

    async applyScriptaVariantEdit(payload = {}) {
        let response;
        try {
            response = await this.scriptaReplica.editVariant(payload);
        } catch (error) {
            await this.requestResync('scripta-p-variant-edit-failed').catch(() => {});
            throw error;
        }
        const projectionApplied = this.applyBlackboardProjection(response?.blackboard, {
            reason: 'scripta-crdt-edit'
        });
        if (projectionApplied) {
            await this.publishFinalUpdate(response, 'scripta-p-variant-edit');
        }
        return response;
    }

    async handleEncodedEvent(encodedEvent) {
        const parsed = parseWebMeetEvent(encodedEvent);
        if (parsed.type !== WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED) {
            return 'ignored';
        }
        const messageId = parsed.id || parsed.payload?.id || '';
        if (messageId && this.seenMessageIds.has(messageId)) {
            return 'duplicate';
        }
        if (messageId) {
            this.seenMessageIds.add(messageId);
        }
        const revision = Number(parsed.payload?.blackboardRevision || 0);
        const eventBoardId = String(parsed.payload?.boardId || '').trim();
        if (parsed.payload?.objectKind === 'workspace') {
            const blackboard = await this.loadInitialBlackboard(this.roomId);
            this.applyWorkspaceProjection(this.workspace, { reason: 'realtime-workspace' });
            this.applyBlackboardProjection(blackboard, { reason: 'realtime-workspace' });
            return 'applied';
        }
        if (!eventBoardId || eventBoardId !== this.boardId) {
            return 'wrong-board';
        }
        if (revision && revision < this.currentRevision) {
            return 'old-revision';
        }
        const blackboardMessage = String(parsed.payload?.blackboardMessage || '').trim();
        if (blackboardMessage) {
            const protocol = parseBlackboardProtocolMessage(blackboardMessage);
            if (protocol.payload.roomId !== this.roomId) {
                return 'wrong-room';
            }
            const protocolBoardId = String(protocol.payload.boardId || '').trim();
            if (!protocolBoardId || protocolBoardId !== this.boardId) {
                return 'wrong-board';
            }
            const protocolMessageId = protocol.payload.messageId || '';
            if (protocolMessageId && this.seenMessageIds.has(protocolMessageId)) {
                return 'duplicate';
            }
            if (protocolMessageId) {
                this.seenMessageIds.add(protocolMessageId);
            }
            const protocolRevision = Number(protocol.payload.revision || 0);
            if (protocolRevision && protocolRevision < this.currentRevision) {
                return 'old-revision';
            }
            this.currentRevision = Math.max(this.currentRevision, revision, protocolRevision);
            if (protocol.payload.presentation) {
                this.emit({
                    kind: 'scripta-presentation',
                    presentation: protocol.payload.presentation,
                    revision: this.currentRevision,
                    messageId: protocolMessageId,
                    from: protocol.from,
                    to: protocol.to,
                });
                return 'applied';
            }
            if (!protocol.payload.object && this.locallyAppliedScriptaRevisions.delete(protocolRevision)) {
                return 'applied';
            }
            if (protocol.payload.object) {
                if (containsViewerScopedScriptaProjection(protocol.payload.object)) {
                    // SCRIPTA edit/delete permissions and viewer votes are
                    // participant-specific. Never apply another participant's
                    // serialized projection; reload the same board revision
                    // through the authenticated WebMeet boundary instead.
                    void this.scriptaReplica.schedulePullAll();
                    await this.requestResync('scripta-viewer-projection');
                    return 'applied';
                }
                this.emit({
                    kind: protocol.payload.kind,
                    object: protocol.payload.object,
                    revision: this.currentRevision,
                    messageId: protocolMessageId,
                    from: protocol.from,
                    to: protocol.to
                });
                // The realtime projection is complete. Synchronize the editing
                // replica after rendering it, using the same queue as local
                // events so a subsequent inline edit cannot overtake the pull.
                void this.scriptaReplica.schedulePullAll();
                return 'applied';
            }
        }
        void this.scriptaReplica.schedulePullAll();
        this.currentRevision = Math.max(this.currentRevision, revision);
        await this.requestResync('blackboard.updated');
        return 'applied';
    }

    async requestResync(reason = 'manual') {
        const blackboard = await this.loadInitialBlackboard(this.roomId);
        this.applyBlackboardProjection(blackboard, { reason });
        return blackboard;
    }

    emit(payload) {
        for (const handler of this.handlers) {
            handler(payload);
        }
    }

    async publishAudit(response) {
        if (!response?.auditMessage) return;
        this.onAuditMessage?.(response.auditMessage);
        if (typeof this.publishRealtimePayload !== 'function') return;
        await this.publishRealtimePayload({
            type: WEBMEET_EVENT_TYPES.CHAT_REALTIME,
            meetingId: this.roomId,
            message: response.auditMessage
        }).catch(() => {});
    }

    async publishScriptaDraft(presentation = {}) {
        if (typeof this.publishRealtimePayload !== 'function') return;
        const editorParticipantId = String(presentation.editorParticipantId || this.participantId).trim();
        const blackboardMessage = encodeBlackboardProtocolMessage({
            from: editorParticipantId ? `user:${editorParticipantId}` : 'user:local',
            to: 'ALL',
            payload: {
                kind: 'widget',
                roomId: this.roomId,
                boardId: this.boardId,
                blackboardId: this.boardId,
                boardOwnerType: 'agent',
                boardOwnerId: 'agent_robo_team',
                boardVisibility: 'room',
                revision: this.currentRevision,
                visibility: { mode: 'all' },
                object: null,
                presentation: {
                    type: 'scripta-variant-draft',
                    resourceId: String(presentation.resourceId || ''),
                    chapterId: String(presentation.chapterId || ''),
                    paragraphId: String(presentation.paragraphId || ''),
                    variantId: String(presentation.variantId || ''),
                    editorParticipantId,
                    text: String(presentation.text ?? ''),
                },
            },
        });
        await this.publishRealtimePayload({
            type: WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED,
            meetingId: this.roomId,
            boardId: this.boardId,
            boardOwnerType: 'agent',
            boardOwnerId: 'agent_robo_team',
            boardVisibility: 'room',
            blackboardRevision: this.currentRevision,
            changeType: 'scripta-p-variant-edit-draft',
            targetType: 'widget',
            targetRef: 'robo_scripta_document',
            objectKind: 'widget',
            editorParticipantId,
            blackboardMessage,
        });
    }

    async publishFinalUpdate(response = {}, fallbackChangeType = 'update') {
        if (typeof this.publishRealtimePayload !== 'function') {
            return;
        }
        const revision = Number(response?.blackboard?.revision || 0);
        let broadcastPayload = response?.broadcast && typeof response.broadcast === 'object'
            ? response.broadcast
            : {
                kind: response?.object?.id ? 'widget' : 'blackboard',
                roomId: this.roomId,
                boardId: this.boardId,
                blackboardId: this.boardId,
                boardOwnerType: 'agent',
                boardOwnerId: 'agent_robo_team',
                boardVisibility: 'room',
                revision,
                visibility: response?.object?.visibility || { mode: 'all' },
                object: response?.object?.id ? response.object : response?.blackboard
            };
        if (
            String(fallbackChangeType || '').startsWith('scripta-')
            || containsViewerScopedScriptaProjection(broadcastPayload.object)
        ) {
            // A realtime SCRIPTA message is an invalidation signal. The
            // receiver obtains its own authorized projection from WebMeet.
            broadcastPayload = { ...broadcastPayload, object: null };
        }
        const from = this.participantId ? `user:${this.participantId}` : 'user:local';
        const blackboardMessage = encodeBlackboardProtocolMessage({
            from,
            to: 'ALL',
            payload: broadcastPayload
        });
        await this.publishRealtimePayload({
            type: WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED,
            meetingId: this.roomId,
            boardId: this.boardId,
            workspaceRevision: Number(response?.workspace?.revision || this.workspaceRevision || 0),
            activeBoardId: String(response?.workspace?.activeBoardId || this.boardId),
            affectedBoardIds: Array.isArray(response?.affectedBoardIds) ? response.affectedBoardIds : [this.boardId],
            boardOwnerType: String(broadcastPayload.boardOwnerType || 'agent').trim(),
            boardOwnerId: String(broadcastPayload.boardOwnerId || 'agent_robo_team').trim(),
            boardVisibility: String(broadcastPayload.boardVisibility || 'room').trim(),
            blackboardRevision: revision,
            changeType: String(response?.change?.changeType || fallbackChangeType || 'update').trim(),
            targetType: String(response?.change?.targetType || 'blackboard').trim(),
            targetRef: String(response?.change?.targetRef || response?.object?.id || '').trim(),
            objectKind: response?.workspace ? 'workspace' : broadcastPayload.kind || (response?.object?.id ? 'widget' : 'blackboard'),
            blackboardMessage
        });
    }
}
