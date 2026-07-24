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
        if (!this.boardId) {
            throw new Error('Missing blackboard boardId.');
        }
        this.participantId = String(participantId || '').trim();
        this.participantName = String(participantName || '').trim();
        this.runTool = runTool;
        this.onAuditMessage = onAuditMessage;
        this.publishRealtimePayload = publishRealtimePayload;
        this.room = room;
        this.handlers = new Set();
        this.seenMessageIds = new Set();
        this.currentRevision = 0;
        this.unsubscribeRoom = null;
        this.scriptaReplica = new ScriptaCrdtReplica(this);
    }

    async loadInitialBlackboard(roomId = this.roomId) {
        const response = await this.runTool('webmeet_blackboard_get', {
            roomId,
            boardId: this.boardId,
            participantId: this.participantId
        });
        this.currentRevision = Number(response?.blackboard?.revision || 0);
        return response?.blackboard || { roomId, revision: 0, widgets: [] };
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
        this.currentRevision = Number(response?.blackboard?.revision || this.currentRevision);
        if (response?.blackboard) this.emit({ kind: 'blackboard', object: response.blackboard, revision: this.currentRevision, reason: action });
        await this.publishFinalUpdate(response, change?.changeType || 'update');
        return response;
    }

    async sendEvent(action, payload = {}, { widgetId = '', targetType = 'widget' } = {}) {
        const response = await this.runEvent(this.createEvent({
                target: { type: targetType, ...(widgetId ? { widgetId } : {}) },
                action,
                payload
            }));
        await this.publishAudit(response);
        if (!response?.ok) throw new Error(response?.error?.message || response?.message || 'Blackboard event failed.');
        this.currentRevision = Number(response?.blackboard?.revision || this.currentRevision);
        if (response?.blackboard) this.emit({ kind: 'blackboard', object: response.blackboard, revision: this.currentRevision, reason: action });
        if (response?.blackboard) await this.publishFinalUpdate(response, action);
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

    createEvent({ target, action, payload }) {
        return { target, action, payload };
    }

    async runEvent(event) {
        return this.runTool('webmeet_event_command', {
            roomId: this.roomId,
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
        this.currentRevision = Number(response?.blackboard?.revision || this.currentRevision);
        if (response?.blackboard) this.emit({ kind: 'blackboard', object: response.blackboard, revision: this.currentRevision, reason: 'undo' });
        if (response?.changed) {
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
        this.currentRevision = Number(response?.blackboard?.revision || this.currentRevision);
        if (response?.blackboard) this.emit({ kind: 'blackboard', object: response.blackboard, revision: this.currentRevision, reason: 'redo' });
        if (response?.changed) {
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
        this.currentRevision = Number(response?.blackboard?.revision || this.currentRevision);
        if (response?.blackboard) {
            this.emit({
                kind: 'blackboard',
                object: response.blackboard,
                revision: this.currentRevision,
                reason: 'scripta-crdt-edit'
            });
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
        this.emit({ kind: 'blackboard', object: blackboard, revision: blackboard.revision, reason });
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
            boardOwnerType: String(broadcastPayload.boardOwnerType || 'agent').trim(),
            boardOwnerId: String(broadcastPayload.boardOwnerId || 'agent_robo_team').trim(),
            boardVisibility: String(broadcastPayload.boardVisibility || 'room').trim(),
            blackboardRevision: revision,
            changeType: String(response?.change?.changeType || fallbackChangeType || 'update').trim(),
            targetType: String(response?.change?.targetType || 'blackboard').trim(),
            targetRef: String(response?.change?.targetRef || response?.object?.id || '').trim(),
            objectKind: broadcastPayload.kind || (response?.object?.id ? 'widget' : 'blackboard'),
            blackboardMessage
        });
    }
}
