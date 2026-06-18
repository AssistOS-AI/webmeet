import { WEBMEET_EVENT_TYPES, parseWebMeetEvent } from '../webmeet-events.js';
import {
    encodeBlackboardProtocolMessage,
    parseBlackboardProtocolMessage
} from './blackboard-protocol.js';

export class BlackboardNetworkAdapter {
    constructor({
        roomId,
        participantId = '',
        runTool,
        publishRealtimePayload = null,
        room = null
    } = {}) {
        this.roomId = String(roomId || '').trim();
        this.participantId = String(participantId || '').trim();
        this.runTool = runTool;
        this.publishRealtimePayload = publishRealtimePayload;
        this.room = room;
        this.handlers = new Set();
        this.seenMessageIds = new Set();
        this.currentVersion = 0;
        this.unsubscribeRoom = null;
    }

    async loadInitialBlackboard(roomId = this.roomId) {
        const response = await this.runTool('webmeet_blackboard_get', {
            roomId,
            participantId: this.participantId
        });
        this.currentVersion = Number(response?.blackboard?.version || 0);
        return response?.blackboard || { roomId, version: 0, widgets: [] };
    }

    async sendChange(change) {
        const response = await this.runTool('webmeet_blackboard_apply', {
            roomId: this.roomId,
            participantId: this.participantId,
            change: JSON.stringify(change || {})
        });
        await this.publishFinalUpdate(response, change?.changeType || 'update');
        return response;
    }

    async undo() {
        const response = await this.runTool('webmeet_blackboard_undo', {
            roomId: this.roomId,
            participantId: this.participantId
        });
        if (response?.changed) {
            await this.publishFinalUpdate(response, 'undo');
        }
        return response;
    }

    async redo() {
        const response = await this.runTool('webmeet_blackboard_redo', {
            roomId: this.roomId,
            participantId: this.participantId
        });
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
        const version = Number(parsed.payload?.blackboardVersion || 0);
        if (version && version < this.currentVersion) {
            return 'old-version';
        }
        const blackboardMessage = String(parsed.payload?.blackboardMessage || '').trim();
        if (blackboardMessage) {
            const protocol = parseBlackboardProtocolMessage(blackboardMessage);
            if (protocol.payload.roomId !== this.roomId) {
                return 'wrong-room';
            }
            const protocolMessageId = protocol.payload.messageId || '';
            if (protocolMessageId && this.seenMessageIds.has(protocolMessageId)) {
                return 'duplicate';
            }
            if (protocolMessageId) {
                this.seenMessageIds.add(protocolMessageId);
            }
            const protocolVersion = Number(protocol.payload.version || 0);
            if (protocolVersion && protocolVersion < this.currentVersion) {
                return 'old-version';
            }
            this.currentVersion = Math.max(this.currentVersion, version, protocolVersion);
            if (protocol.payload.object) {
                this.emit({
                    kind: protocol.payload.kind,
                    object: protocol.payload.object,
                    version: this.currentVersion,
                    messageId: protocolMessageId,
                    from: protocol.from,
                    to: protocol.to
                });
                return 'applied';
            }
        }
        this.currentVersion = Math.max(this.currentVersion, version);
        await this.requestResync('blackboard.updated');
        return 'applied';
    }

    async requestResync(reason = 'manual') {
        const blackboard = await this.loadInitialBlackboard(this.roomId);
        this.emit({ kind: 'blackboard', object: blackboard, version: blackboard.version, reason });
        return blackboard;
    }

    emit(payload) {
        for (const handler of this.handlers) {
            handler(payload);
        }
    }

    async publishFinalUpdate(response = {}, fallbackChangeType = 'update') {
        if (typeof this.publishRealtimePayload !== 'function') {
            return;
        }
        const version = Number(response?.blackboard?.version || 0);
        const broadcastPayload = response?.broadcast && typeof response.broadcast === 'object'
            ? response.broadcast
            : {
                kind: response?.object?.id ? 'widget' : 'blackboard',
                roomId: this.roomId,
                version,
                visibility: response?.object?.visibility || { mode: 'all' },
                object: response?.object?.id ? response.object : response?.blackboard
            };
        const from = this.participantId ? `user:${this.participantId}` : 'user:local';
        const blackboardMessage = encodeBlackboardProtocolMessage({
            from,
            to: 'ALL',
            payload: broadcastPayload
        });
        await this.publishRealtimePayload({
            type: WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED,
            meetingId: this.roomId,
            blackboardVersion: version,
            changeType: String(response?.change?.changeType || fallbackChangeType || 'update').trim(),
            targetType: String(response?.change?.targetType || 'blackboard').trim(),
            targetRef: String(response?.change?.targetRef || response?.object?.id || '').trim(),
            objectKind: broadcastPayload.kind || (response?.object?.id ? 'widget' : 'blackboard'),
            blackboardMessage
        });
    }
}
