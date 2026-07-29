import { Blackboard, cloneJson } from './model.mjs';
import { newEventId } from './event-contract.mjs';

export const DEFAULT_BLACKBOARD_WORKSPACE_HISTORY_DEPTH = 5;

function nowIso() {
    return new Date().toISOString();
}

function normalizeTitle(value = '', fallback = 'Workspace') {
    const title = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    return title || fallback;
}

function snapshotBoard(board) {
    const serialized = Blackboard.from(board).serializePrivileged();
    return { ...serialized, history: { maxDepth: DEFAULT_BLACKBOARD_WORKSPACE_HISTORY_DEPTH, undoStack: [], redoStack: [] } };
}

function snapshotWorkspace(workspace) {
    return {
        id: workspace.id,
        roomId: workspace.roomId,
        revision: workspace.revision,
        activeBoardId: workspace.activeBoardId,
        boardOrder: [...workspace.boardOrder],
        boards: workspace.boardOrder.map((boardId) => snapshotBoard(workspace.boards.get(boardId))),
    };
}

function resolveSelectedWidgetIds(board, widgetIds = []) {
    const requestedIds = [...new Set(widgetIds.map((id) => String(id || '').trim()).filter(Boolean))];
    if (!requestedIds.length) throw new Error('At least one Blackboard widget must be selected.');
    const selected = requestedIds.map((id) => board.getWidget(id));
    if (selected.some((widget) => !widget)) throw new Error('One or more selected Blackboard widgets no longer exist.');
    const selectedIds = new Set(requestedIds);
    let changed = true;
    while (changed) {
        const beforeSize = selectedIds.size;
        const selectedGroupIds = new Set([...selectedIds]
            .map((id) => String(board.getWidget(id)?.groupId || ''))
            .filter(Boolean));
        for (const widget of board.widgets.values()) {
            if (widget.groupId && selectedGroupIds.has(widget.groupId)) selectedIds.add(widget.id);
            const fromId = String(widget.properties?.connection?.from?.widgetId || '');
            const toId = String(widget.properties?.connection?.to?.widgetId || '');
            if (widget.type !== 'line' || !fromId || !toId) continue;
            if (selectedIds.has(widget.id)) {
                if (board.getWidget(fromId)) selectedIds.add(fromId);
                if (board.getWidget(toId)) selectedIds.add(toId);
            }
            if (selectedIds.has(fromId) && selectedIds.has(toId)) selectedIds.add(widget.id);
        }
        changed = selectedIds.size !== beforeSize;
    }
    return selectedIds;
}

class BlackboardWorkspaceHistory {
    constructor(input = {}) {
        this.maxDepth = Math.max(1, Number.parseInt(String(input.maxDepth || DEFAULT_BLACKBOARD_WORKSPACE_HISTORY_DEPTH), 10) || DEFAULT_BLACKBOARD_WORKSPACE_HISTORY_DEPTH);
        this.undoStack = Array.isArray(input.undoStack) ? cloneJson(input.undoStack).slice(-this.maxDepth) : [];
        this.redoStack = Array.isArray(input.redoStack) ? cloneJson(input.redoStack).slice(-this.maxDepth) : [];
    }

    record(action, before, after) {
        this.undoStack.push({ action: String(action || 'command'), before: cloneJson(before), after: cloneJson(after), createdAt: nowIso() });
        this.undoStack = this.undoStack.slice(-this.maxDepth);
        this.redoStack = [];
    }

    undo() {
        const entry = this.undoStack.pop() || null;
        if (entry) this.redoStack.push(entry);
        return entry?.before || null;
    }

    redo() {
        const entry = this.redoStack.pop() || null;
        if (entry) this.undoStack.push(entry);
        return entry?.after || null;
    }

    serialize() {
        return cloneJson({ maxDepth: this.maxDepth, undoStack: this.undoStack, redoStack: this.redoStack });
    }
}

export class BlackboardWorkspace {
    constructor(input = {}) {
        this.roomId = String(input.roomId || '').trim();
        this.id = String(input.id || `blackboard_workspace_${this.roomId || newEventId('room')}`).trim();
        this.revision = Number.isSafeInteger(input.revision) ? Math.max(0, input.revision) : 0;
        this.boards = new Map();
        const inputBoards = input.boards instanceof Map ? [...input.boards.values()] : Array.isArray(input.boards) ? input.boards : [];
        for (const rawBoard of inputBoards) {
            const board = Blackboard.from({ ...rawBoard, roomId: this.roomId });
            board.metadata = { ...board.metadata, title: normalizeTitle(board.metadata?.title, `Workspace ${this.boards.size + 1}`) };
            this.boards.set(board.boardId, board);
        }
        this.boardOrder = (Array.isArray(input.boardOrder) ? input.boardOrder : [])
            .map((boardId) => String(boardId || '').trim())
            .filter((boardId, index, values) => boardId && this.boards.has(boardId) && values.indexOf(boardId) === index);
        for (const boardId of this.boards.keys()) if (!this.boardOrder.includes(boardId)) this.boardOrder.push(boardId);
        if (!this.boardOrder.length) this.createBoard({ title: 'Workspace 1' }, { record: false, activate: true });
        this.activeBoardId = String(input.activeBoardId || '').trim();
        if (!this.boards.has(this.activeBoardId)) this.activeBoardId = this.boardOrder[0];
        this.history = input.history instanceof BlackboardWorkspaceHistory ? input.history : new BlackboardWorkspaceHistory(input.history);
    }

    get activeBoard() {
        return this.getBoard(this.activeBoardId);
    }

    getBoard(boardId = '') {
        return this.boards.get(String(boardId || '').trim()) || null;
    }

    requireBoard(boardId = '') {
        const board = this.getBoard(boardId);
        if (!board) {
            const error = new Error(`Blackboard workspace zone "${String(boardId || '').trim()}" was not found.`);
            error.code = 'board_not_found';
            throw error;
        }
        return board;
    }

    snapshot() {
        return snapshotWorkspace(this);
    }

    record(action, before) {
        this.history.record(action, before, this.snapshot());
    }

    bumpRevision() {
        this.revision += 1;
    }

    createBoard({ title = '' } = {}, { record = true, activate = true } = {}) {
        const before = record ? this.snapshot() : null;
        const boardId = newEventId('board');
        const board = new Blackboard({
            id: `blackboard_${boardId}`,
            roomId: this.roomId,
            boardId,
            boardOwnerType: 'room',
            boardOwnerId: this.roomId,
            boardVisibility: 'room',
            metadata: { title: normalizeTitle(title, `Workspace ${this.boards.size + 1}`) },
        });
        this.boards.set(boardId, board);
        this.boardOrder.push(boardId);
        if (activate || !this.activeBoardId) this.activeBoardId = boardId;
        this.bumpRevision();
        if (record) this.record('board-create', before);
        return board;
    }

    renameBoard(boardId, title, { record = true } = {}) {
        const before = record ? this.snapshot() : null;
        const board = this.requireBoard(boardId);
        board.metadata = { ...board.metadata, title: normalizeTitle(title, board.metadata?.title || 'Workspace') };
        board.bumpRevision();
        this.bumpRevision();
        if (record) this.record('board-rename', before);
        return board;
    }

    reorderBoard(boardId, targetIndex, { record = true } = {}) {
        const before = record ? this.snapshot() : null;
        const id = this.requireBoard(boardId).boardId;
        const from = this.boardOrder.indexOf(id);
        const to = Math.max(0, Math.min(this.boardOrder.length - 1, Number.parseInt(String(targetIndex), 10) || 0));
        this.boardOrder.splice(from, 1);
        this.boardOrder.splice(to, 0, id);
        if (from !== to) {
            this.bumpRevision();
            if (record) this.record('board-reorder', before);
        }
        return this.boardOrder;
    }

    deleteBoard(boardId, { record = true } = {}) {
        if (this.boardOrder.length <= 1) throw new Error('The last Blackboard workspace zone cannot be deleted.');
        const before = record ? this.snapshot() : null;
        const board = this.requireBoard(boardId);
        const index = this.boardOrder.indexOf(board.boardId);
        this.boards.delete(board.boardId);
        this.boardOrder.splice(index, 1);
        if (this.activeBoardId === board.boardId) this.activeBoardId = this.boardOrder[Math.min(index, this.boardOrder.length - 1)];
        this.bumpRevision();
        if (record) this.record('board-delete', before);
        return board;
    }

    activateBoard(boardId) {
        const board = this.requireBoard(boardId);
        if (this.activeBoardId !== board.boardId) {
            this.activeBoardId = board.boardId;
            this.bumpRevision();
        }
        return board;
    }

    transferWidgets({ sourceBoardId, targetBoardId, widgetIds = [], placement = null } = {}, { participantId = '', record = true } = {}) {
        const source = this.requireBoard(sourceBoardId);
        const target = this.requireBoard(targetBoardId);
        const selectedIds = resolveSelectedWidgetIds(source, widgetIds);
        const before = record ? this.snapshot() : null;
        const moving = [...selectedIds].map((id) => source.getWidget(id)).filter(Boolean).map((widget) => widget.serializePrivileged());
        const externalLineIds = [...source.widgets.values()].filter((widget) => {
            const fromId = String(widget.properties?.connection?.from?.widgetId || '');
            const toId = String(widget.properties?.connection?.to?.widgetId || '');
            return widget.type === 'line' && Boolean(fromId && toId) && (selectedIds.has(fromId) !== selectedIds.has(toId));
        }).map((widget) => widget.id);
        const geometries = moving.map((widget) => widget.properties?.geometry).filter(Boolean);
        const minX = geometries.length ? Math.min(...geometries.map((geometry) => Number(geometry.x || 0))) : 0;
        const minY = geometries.length ? Math.min(...geometries.map((geometry) => Number(geometry.y || 0))) : 0;
        const targetX = Number(placement?.x);
        const targetY = Number(placement?.y);
        const dx = Number.isFinite(targetX) ? targetX - minX : 0;
        const dy = Number.isFinite(targetY) ? targetY - minY : 0;
        if (source.boardId === target.boardId) {
            const movedGroupIds = new Set();
            for (const widget of moving) {
                const groupId = String(widget.groupId || '');
                if (groupId) {
                    if (movedGroupIds.has(groupId)) continue;
                    source.transformGroup(groupId, {translation: {x: dx, y: dy}}, {participantId, record: false});
                    movedGroupIds.add(groupId);
                } else if (widget.properties?.geometry || (widget.type === 'line' && widget.properties?.line && !widget.properties?.connection)) {
                    source.patchWidget(widget.id, {
                        properties: {geometryDelta: {x: dx, y: dy}},
                    }, {participantId, record: false});
                }
            }
            source.updateInteractionContext([...selectedIds], {participantId});
            this.bumpRevision();
            if (record) this.record('board-reposition', before);
            return {source, target, widgetIds: [...selectedIds], removedConnectionIds: []};
        }
        for (const id of [...selectedIds, ...externalLineIds]) {
            if (source.getWidget(id)) source.removeWidget(id, { participantId, canModerateBlackboard: true, record: false });
        }
        for (const serialized of moving) {
            const geometry = serialized.properties?.geometry;
            if (geometry && (dx || dy)) serialized.properties.geometry = { ...geometry, x: Number(geometry.x || 0) + dx, y: Number(geometry.y || 0) + dy };
            target.addWidget(serialized, { participantId, record: false });
        }
        source.updateInteractionContext([], { participantId });
        target.updateInteractionContext(moving.map((widget) => widget.id), { participantId });
        this.activeBoardId = target.boardId;
        this.bumpRevision();
        if (record) this.record('board-transfer', before);
        return { source, target, widgetIds: moving.map((widget) => widget.id), removedConnectionIds: externalLineIds };
    }

    copyWidgets({ sourceBoardId, targetBoardId, widgetIds = [], placement = null } = {}, { participantId = '', record = true } = {}) {
        const source = this.requireBoard(sourceBoardId);
        const target = this.requireBoard(targetBoardId);
        const selectedIds = resolveSelectedWidgetIds(source, widgetIds);
        const originals = [...selectedIds].map((id) => source.getWidget(id)).filter(Boolean);
        if (originals.some((widget) => widget.type === 'scripta-document')) {
            throw new Error('The workspace-backed SCRIPTA document cannot be copied as a Blackboard widget.');
        }
        const before = record ? this.snapshot() : null;
        const idMap = new Map(originals.map((widget) => [widget.id, newEventId('widget')]));
        const groupMap = new Map();
        const geometries = originals.map((widget) => widget.properties?.geometry).filter(Boolean);
        const minX = geometries.length ? Math.min(...geometries.map((geometry) => Number(geometry.x || 0))) : 0;
        const minY = geometries.length ? Math.min(...geometries.map((geometry) => Number(geometry.y || 0))) : 0;
        const targetX = Number(placement?.x);
        const targetY = Number(placement?.y);
        const dx = Number.isFinite(targetX) ? targetX - minX : 0;
        const dy = Number.isFinite(targetY) ? targetY - minY : 0;
        const copiedIds = [];
        for (const original of originals) {
            const serialized = original.serializePrivileged();
            const properties = cloneJson(serialized.properties || {});
            if (properties.geometry && (dx || dy)) {
                properties.geometry = {
                    ...properties.geometry,
                    x: Number(properties.geometry.x || 0) + dx,
                    y: Number(properties.geometry.y || 0) + dy,
                };
            }
            if (properties.connection) {
                properties.connection = {
                    from: {
                        ...properties.connection.from,
                        widgetId: idMap.get(String(properties.connection.from?.widgetId || '')),
                    },
                    to: {
                        ...properties.connection.to,
                        widgetId: idMap.get(String(properties.connection.to?.widgetId || '')),
                    },
                };
            }
            const originalGroupId = String(serialized.groupId || '');
            if (originalGroupId && !groupMap.has(originalGroupId)) groupMap.set(originalGroupId, newEventId('group'));
            const copiedId = idMap.get(original.id);
            target.addWidget({
                id: copiedId,
                type: serialized.type,
                properties,
                groupId: originalGroupId ? groupMap.get(originalGroupId) : '',
                visibility: serialized.visibility,
                locked: serialized.locked,
            }, {participantId, record: false});
            copiedIds.push(copiedId);
        }
        target.updateInteractionContext(copiedIds, {participantId});
        this.bumpRevision();
        if (record) this.record('board-copy', before);
        return {source, target, widgetIds: copiedIds};
    }

    restore(snapshot) {
        const restored = new BlackboardWorkspace({ ...snapshot, history: this.history });
        this.id = restored.id;
        this.roomId = restored.roomId;
        this.revision = Math.max(this.revision + 1, restored.revision);
        this.activeBoardId = restored.activeBoardId;
        this.boardOrder = restored.boardOrder;
        this.boards = restored.boards;
        return this;
    }

    undo() {
        const snapshot = this.history.undo();
        return snapshot ? this.restore(snapshot) : null;
    }

    redo() {
        const snapshot = this.history.redo();
        return snapshot ? this.restore(snapshot) : null;
    }

    serialize(viewerContext = {}) {
        return {
            id: this.id,
            roomId: this.roomId,
            revision: this.revision,
            activeBoardId: this.activeBoardId,
            boardOrder: [...this.boardOrder],
            boards: this.boardOrder.map((boardId) => {
                const board = this.requireBoard(boardId);
                return {
                    boardId,
                    title: normalizeTitle(board.metadata?.title, 'Workspace'),
                    revision: board.revision,
                    widgetCount: board.widgets.size,
                };
            }),
            activeBoard: this.activeBoard?.serialize(viewerContext) || null,
        };
    }

    serializePrivileged() {
        return {
            ...this.snapshot(),
            history: this.history.serialize(),
        };
    }

    static from(input = {}) {
        return input instanceof BlackboardWorkspace ? input : new BlackboardWorkspace(input);
    }
}
